const http = require('http');
const crypto = require('crypto');
const { STEP_SECONDS } = require('./trend-store');

const CLUSTER_BACKUP = 'wxtky02-p800-backup-8nic-vd';
const CLUSTER_NON_BACKUP = 'wxtky02-p800-8nic-vd';
const NON_BACKUP_NODES = new Set([32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
const MONITORED_NODES = Array.from({ length: 51 }, (_, index) => index + 1).filter(node => ![13, 14, 17].includes(node));
const ITEMS = ['XPU_AVERAGE_UTILIZATION', ...Array.from({ length: 8 }, (_, card) => `XPU${card}_MEM_UTILIZATION`)];
const CLUSTER_KEY = crypto.createHash('sha256').update(JSON.stringify({ MONITORED_NODES, ITEMS })).digest('hex').slice(0, 16);
const DAY_SECONDS = 24 * 60 * 60;
const CST_OFFSET_SECONDS = 8 * 60 * 60;
const CARD_COUNT = 8;

function formatMonqueryDateTime(timestamp) {
  const date = new Date((timestamp + CST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function cstDateKey(timestamp) {
  const date = new Date((timestamp + CST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function cstDayStart(timestamp) {
  return Math.floor((timestamp + CST_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS - CST_OFFSET_SECONDS;
}

function todayStartCst(nowSeconds = Math.floor(Date.now() / 1000)) {
  return cstDayStart(nowSeconds);
}

function cstDayStarts(startAt, endAt) {
  const days = [];
  for (let dayStart = cstDayStart(startAt); dayStart <= endAt; dayStart += DAY_SECONDS) days.push(dayStart);
  return days;
}

function namespace(node) {
  const cluster = NON_BACKUP_NODES.has(node) ? CLUSTER_NON_BACKUP : CLUSTER_BACKUP;
  return `${cluster}-node${node}.wxtky02`;
}

function requestJson(host, port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: requestPath, headers, timeout: 90_000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Upstream returned ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Upstream returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Upstream request timed out after 90 seconds')));
    request.on('error', reject);
  });
}

function normalizeEntries(response) {
  return Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : Array.isArray(response?.Data) ? response.Data : [];
}

function parseSamples(response, startAt, endAt) {
  const byTime = new Map();
  const add = (point, type) => {
    const rawTimestamp = Number(point?.Timestamp ?? point?.timestamp ?? point?.time);
    const value = Number(point?.Value ?? point?.value);
    if (!Number.isFinite(rawTimestamp) || !Number.isFinite(value)) return;
    const timestamp = rawTimestamp > 1e12 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    if (timestamp < startAt || timestamp > endAt) return;
    const bucket = byTime.get(timestamp) || { xpuSum: 0, xpuCount: 0, memorySum: 0, memoryCount: 0 };
    if (type === 'xpu') { bucket.xpuSum += value; bucket.xpuCount += 1; } else { bucket.memorySum += value; bucket.memoryCount += 1; }
    byTime.set(timestamp, bucket);
  };
  for (const entry of normalizeEntries(response)) {
    const items = entry?.Items || entry?.items || {};
    for (const point of items.XPU_AVERAGE_UTILIZATION || items.xpu_average_utilization || []) add(point, 'xpu');
    for (let card = 0; card < CARD_COUNT; card += 1) for (const point of items[`XPU${card}_MEM_UTILIZATION`] || items[`xpu${card}_mem_utilization`] || []) add(point, 'memory');
  }
  return Array.from({ length: Math.floor((endAt - startAt) / STEP_SECONDS) + 1 }, (_, index) => {
    const sampledAt = startAt + index * STEP_SECONDS;
    const point = byTime.get(sampledAt);
    return { sampledAt, xpu: point?.xpuCount ? point.xpuSum / point.xpuCount : null, memory: point?.memoryCount ? point.memorySum / point.memoryCount : null };
  });
}

async function fetchMonqueryWindow(config, startAt, endAt) {
  const params = new URLSearchParams({ namespaces: MONITORED_NODES.map(namespace).join(','), items: ITEMS.join(','), start: formatMonqueryDateTime(startAt), end: formatMonqueryDateTime(endAt), interval: '300' });
  return parseSamples(await requestJson(config.backend.monquery.host, config.backend.monquery.port, `/monquery/getHistoryitemdata?${params}`), startAt, endAt);
}

function splitByDay(startAt, endAt) {
  const windows = [];
  for (let cursor = startAt; cursor <= endAt;) {
    const end = Math.min(endAt, cursor + DAY_SECONDS - STEP_SECONDS);
    windows.push([cursor, end]);
    cursor = end + STEP_SECONDS;
  }
  return windows;
}

async function runWithConcurrency(values, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await work(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
}

function nodeName(value) {
  const normalized = String(value || '');
  const node = normalized.match(/^(?:gpu-)?node-?(\d+)$/i);
  if (node) return `node${Number(node[1])}`;
  const bdc = normalized.match(/^bdc-?(\d+)$/i);
  return bdc ? `bdc${Number(bdc[1])}` : null;
}

function toSeconds(value) {
  if (value == null || value === '') return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  const text = String(value).trim();
  return Math.floor(Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`) / 1000);
}

function recordCards(record) {
  const card = Number(record?.dev_id ?? record?.device_id ?? record?.card_id);
  return Number.isInteger(card) && card >= 0 && card < CARD_COUNT ? [card] : Array.from({ length: CARD_COUNT }, (_, index) => index);
}

function lockedCardSamples(intervals, startAt, endAt) {
  const locked = new Map();
  for (const interval of intervals) {
    const start = interval.start;
    const end = interval.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    for (let timestamp = Math.max(startAt, Math.floor(start / STEP_SECONDS) * STEP_SECONDS); timestamp <= Math.min(endAt, end - 1); timestamp += STEP_SECONDS) {
      const cards = locked.get(timestamp) || new Set();
      for (const card of interval.cards) cards.add(`${interval.node}:${card}`);
      locked.set(timestamp, cards);
    }
  }
  return Array.from({ length: Math.floor((endAt - startAt) / STEP_SECONDS) + 1 }, (_, index) => {
    const sampledAt = startAt + index * STEP_SECONDS;
    return { sampledAt, lockedCards: locked.get(sampledAt)?.size || 0 };
  });
}

function occupancySamples(records, startAt, endAt) {
  const intervals = records.map(record => {
    const start = toSeconds(record.start_time);
    const endTime = toSeconds(record.end_time);
    return {
      node: nodeName(record.node_key ?? record.node ?? record.node_name),
      cards: recordCards(record),
      start,
      end: Number.isFinite(endTime) ? endTime : start + Number(record.duration_seconds ?? record.duration ?? 0),
    };
  }).filter(interval => interval.node);
  return lockedCardSamples(intervals, startAt, endAt);
}

function stateIntervals(botStates, dayStart, nowSeconds) {
  const firstNodes = new Map();
  for (const { type, state } of botStates) {
    for (const [rawName, nodeState] of Object.entries(state || {})) {
      const node = nodeName(rawName);
      if (node && !firstNodes.has(node)) firstNodes.set(node, { type, state: nodeState });
    }
  }
  const intervals = [];
  for (const [node, result] of firstNodes) {
    const devices = result.type === 'DEVICE' && Array.isArray(result.state) ? result.state : [{ ...result.state, dev_id: null }];
    for (const device of devices) {
      if (device?.status === 'idle' || !device?.current_users?.length) continue;
      const cards = recordCards(device);
      for (const user of device.current_users) {
        const start = Math.max(toSeconds(user.start_time), dayStart);
        const end = Math.min(toSeconds(user.start_time) + Number(user.duration ?? 0), nowSeconds);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ node, cards, start, end });
      }
    }
  }
  return intervals;
}

function createTrendService(config, store) {
  const inflight = new Map();
  const shared = (key, work) => {
    if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(work).finally(() => inflight.delete(key)));
    return inflight.get(key);
  };
  const backfillMonquery = async windows => {
    let fetchedWindows = 0;
    for (const [startAt, endAt] of windows) for (const [windowStart, windowEnd] of splitByDay(startAt, endAt)) {
      await shared(`monquery:${windowStart}:${windowEnd}`, async () => store.saveWindow(CLUSTER_KEY, windowStart, windowEnd, await fetchMonqueryWindow(config, windowStart, windowEnd)));
      fetchedWindows += 1;
    }
    return fetchedWindows;
  };

  async function lockSeries(startAt, endAt, authorization) {
    if (!authorization) return { lock: Array.from({ length: Math.floor((endAt - startAt) / STEP_SECONDS) + 1 }, () => null), lockDataAsOf: null };
    const headers = { authorization };
    const bots = await requestJson(config.backend.lockbot.host, config.backend.lockbot.port, '/api/bots', headers);
    const scopeKey = crypto.createHash('sha256').update(JSON.stringify((bots || []).map(bot => [bot.id, bot.type]).sort())).digest('hex').slice(0, 16);
    const totalCards = MONITORED_NODES.length * CARD_COUNT;
    const todayStart = todayStartCst();
    const historicalEnd = Math.min(endAt, todayStart - STEP_SECONDS);
    const missingDays = (historicalEnd >= startAt ? cstDayStarts(startAt, historicalEnd) : []).filter(dayStart => !store.hasLockDay(scopeKey, dayStart));
    await runWithConcurrency(missingDays, 2, async dayStart => {
      const records = (await Promise.all((bots || []).map(bot => requestJson(config.backend.lockbot.host, config.backend.lockbot.port, `/api/bots/${bot.id}/occupancy?date=${encodeURIComponent(cstDateKey(dayStart))}`, headers).catch(() => [])))).flat();
      store.saveLockDay(scopeKey, dayStart, totalCards, occupancySamples(records, dayStart, dayStart + DAY_SECONDS - STEP_SECONDS));
    });
    if (endAt >= todayStart) {
      const [recordsByBot, states] = await Promise.all([
        Promise.all((bots || []).map(bot => requestJson(config.backend.lockbot.host, config.backend.lockbot.port, `/api/bots/${bot.id}/occupancy?date=${encodeURIComponent(cstDateKey(todayStart))}`, headers).catch(() => []))),
        Promise.all((bots || []).map(bot => requestJson(config.backend.lockbot.host, config.backend.lockbot.port, `/api/bots/${bot.id}/state`, headers).then(state => ({ type: bot.type, state })).catch(() => null))),
      ]);
      const intervals = recordsByBot.flat().map(record => {
        const start = toSeconds(record.start_time);
        const endTime = toSeconds(record.end_time);
        return { node: nodeName(record.node_key ?? record.node ?? record.node_name), cards: recordCards(record), start, end: Number.isFinite(endTime) ? endTime : start + Number(record.duration_seconds ?? record.duration ?? 0) };
      }).filter(interval => interval.node).concat(stateIntervals(states.filter(Boolean), todayStart, Math.floor(Date.now() / 1000)));
      store.saveLockDay(scopeKey, todayStart, totalCards, lockedCardSamples(intervals, todayStart, todayStart + DAY_SECONDS - STEP_SECONDS));
    }
    const rows = new Map(store.readLockRange(scopeKey, startAt, endAt).map(row => [row.sampled_at, row.locked_cards]));
    const lock = Array.from({ length: Math.floor((endAt - startAt) / STEP_SECONDS) + 1 }, (_, index) => {
      const count = rows.get(startAt + index * STEP_SECONDS);
      return Number.isFinite(count) ? count / totalCards * 100 : null;
    });
    const last = lock.reduce((result, value, index) => Number.isFinite(value) ? startAt + index * STEP_SECONDS : result, null);
    return { lock, lockDataAsOf: last };
  }

  return {
    async query(startAt, endAt, authorization) {
      const todayStart = todayStartCst();
      const historicalEnd = Math.min(endAt, todayStart - STEP_SECONDS);
      const historicalMissing = historicalEnd >= startAt ? store.missingWindows(CLUSTER_KEY, startAt, historicalEnd) : [];
      const fetchedWindows = historicalMissing.length ? await backfillMonquery(historicalMissing) : 0;
      const liveSamples = new Map();
      let today = 'not-requested';
      const todayStartAt = Math.max(startAt, todayStart);
      if (todayStartAt <= endAt) {
        try {
          const samples = await shared(`live:${todayStartAt}:${endAt}`, () => fetchMonqueryWindow(config, todayStartAt, endAt));
          store.saveWindow(CLUSTER_KEY, todayStartAt, endAt, samples);
          samples.forEach(sample => liveSamples.set(sample.sampledAt, sample));
          today = 'live';
        } catch { today = 'stale'; }
      }
      const samples = new Map(store.readRange(CLUSTER_KEY, startAt, endAt).map(row => [row.sampled_at, row]));
      liveSamples.forEach((sample, timestamp) => samples.set(timestamp, { xpu_avg: sample.xpu, memory_avg: sample.memory }));
      const times = []; const xpu = []; const memory = [];
      for (let timestamp = startAt; timestamp <= endAt; timestamp += STEP_SECONDS) {
        const sample = samples.get(timestamp);
        times.push(timestamp); xpu.push(sample?.xpu_avg ?? null); memory.push(sample?.memory_avg ?? null);
      }
      const lock = await lockSeries(startAt, endAt, authorization);
      const dataAsOf = times.reduce((result, timestamp, index) => Number.isFinite(xpu[index]) || Number.isFinite(memory[index]) ? timestamp : result, null);
      return { times, xpu, memory, ...lock, dataAsOf, cache: { fetchedWindows, today } };
    },
  };
}

module.exports = { createTrendService };
