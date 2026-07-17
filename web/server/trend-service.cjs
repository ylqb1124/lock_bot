const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const clusterScope = require('../shared/cluster-scope.json');

const CLUSTER_BACKUP = 'wxtky02-p800-backup-8nic-vd';
const CLUSTER_NON_BACKUP = 'wxtky02-p800-8nic-vd';
const NON_BACKUP_NODES = new Set([32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
const MONITORED_NODES = clusterScope.nodeIds;
const CARD_COUNT = clusterScope.cardsPerNode;
const ITEMS = ['XPU_AVERAGE_UTILIZATION', ...Array.from({ length: CARD_COUNT }, (_, card) => `XPU${card}_MEM_UTILIZATION`)];
const MONQUERY_NODE_BATCH_SIZE = 16;
const DAY_SECONDS = 24 * 60 * 60;
const CST_OFFSET_SECONDS = 8 * 60 * 60;
const LOCK_HISTORY_CACHE_DIR = path.join(__dirname, '..', '.devdata', 'lock-history');

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

function hashKey(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes} min ${((milliseconds % 60_000) / 1_000).toFixed(1)} s`;
}

function lockCachePath(dayStart, scopeKey) {
  return path.join(LOCK_HISTORY_CACHE_DIR, `${scopeKey}-${cstDateKey(dayStart)}.json`);
}

function readLockHistoryCache(dayStart, scopeKey) {
  try {
    const data = JSON.parse(fs.readFileSync(lockCachePath(dayStart, scopeKey), 'utf8'));
    if (data?.complete === true && Array.isArray(data.records)) return data.records;
  } catch {
    // A missing or malformed cache entry is fetched again.
  }
  return null;
}

function saveLockHistoryCache(dayStart, scopeKey, records) {
  fs.mkdirSync(LOCK_HISTORY_CACHE_DIR, { recursive: true });
  const target = lockCachePath(dayStart, scopeKey);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ complete: true, records }));
  fs.renameSync(temporary, target);
}

function defaultLockHistoryCache() {
  return {
    read: readLockHistoryCache,
    save: saveLockHistoryCache,
  };
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

function parseSamples(response, startAt, endAt, intervalSeconds) {
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
  return Array.from({ length: Math.floor((endAt - startAt) / intervalSeconds) + 1 }, (_, index) => {
    const sampledAt = startAt + index * intervalSeconds;
    const point = byTime.get(sampledAt);
    return { sampledAt, xpu: point?.xpuCount ? point.xpuSum / point.xpuCount : null, memory: point?.memoryCount ? point.memorySum / point.memoryCount : null };
  });
}

async function fetchMonqueryWindow(config, startAt, endAt, intervalSeconds, requestedNodes = null) {
  const nodes = requestedNodes
    ? requestedNodes
      .map(node => String(node).match(/^node(\d+)$/i))
      .map(match => match ? Number(match[1]) : NaN)
      .filter(node => MONITORED_NODES.includes(node))
    : MONITORED_NODES;
  const batches = [];
  for (let index = 0; index < nodes.length; index += MONQUERY_NODE_BATCH_SIZE) {
    batches.push(nodes.slice(index, index + MONQUERY_NODE_BATCH_SIZE));
  }
  const responses = await Promise.all(batches.map(batch => {
    const params = new URLSearchParams({
      namespaces: batch.map(namespace).join(','),
      items: ITEMS.join(','),
      start: formatMonqueryDateTime(startAt),
      end: formatMonqueryDateTime(endAt),
      interval: String(intervalSeconds),
    });
    return requestJson(config.backend.monquery.host, config.backend.monquery.port, `/monquery/getHistoryitemdata?${params}`);
  }));
  return parseSamples(responses.flatMap(normalizeEntries), startAt, endAt, intervalSeconds);
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

function botType(bot) {
  return String(bot?.bot_type || bot?.type || 'NODE').toUpperCase();
}

function lockedCardSamples(intervals, startAt, endAt, intervalSeconds) {
  const locked = new Map();
  for (const interval of intervals) {
    const start = interval.start;
    const end = interval.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    for (let timestamp = Math.max(startAt, Math.floor(start / intervalSeconds) * intervalSeconds); timestamp <= Math.min(endAt, end - 1); timestamp += intervalSeconds) {
      const cards = locked.get(timestamp) || new Set();
      for (const card of interval.cards) cards.add(`${interval.node}:${card}`);
      locked.set(timestamp, cards);
    }
  }
  return Array.from({ length: Math.floor((endAt - startAt) / intervalSeconds) + 1 }, (_, index) => {
    const sampledAt = startAt + index * intervalSeconds;
    return { sampledAt, lockedCards: locked.get(sampledAt)?.size || 0 };
  });
}

function occupancyIntervals(records) {
  return records.map(record => {
    const start = toSeconds(record.start_time);
    const endTime = toSeconds(record.end_time);
    return {
      node: nodeName(record.node_key ?? record.node ?? record.node_name),
      cards: recordCards(record),
      start,
      end: Number.isFinite(endTime) ? endTime : start + Number(record.duration_seconds ?? record.duration ?? 0),
    };
  }).filter(interval => interval.node);
}

function stateIntervals(botStates, dayStart, nowSeconds) {
  const intervals = [];
  for (const { type, state } of botStates) {
    for (const [rawName, nodeState] of Object.entries(state || {})) {
      const node = nodeName(rawName);
      if (!node) continue;
      const devices = type === 'DEVICE' && Array.isArray(nodeState) ? nodeState : [{ ...nodeState, dev_id: null }];
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
  }
  return intervals;
}

async function lockSeries(config, startAt, endAt, authorization, intervalSeconds, requestedNodes, lockHistoryCache) {
  const count = Math.floor((endAt - startAt) / intervalSeconds) + 1;
  if (!authorization) {
    return {
      lock: new Array(count).fill(null),
      lockDataAsOf: null,
      lockStatus: { complete: false, failureCount: 1 },
    };
  }

  const headers = { authorization };
  const bots = await requestJson(config.backend.lockbot.host, config.backend.lockbot.port, '/api/bots', headers);
  const targetNodes = new Set(requestedNodes || MONITORED_NODES.map(node => `node${node}`));
  const scopeKey = hashKey({
    nodes: [...targetNodes].sort(),
    bots: (bots || []).map(bot => [bot.id, botType(bot)]).sort((first, second) => String(first[0]).localeCompare(String(second[0]))),
  });
  const intervals = [];
  const unavailableDays = new Set();
  let failureCount = 0;
  await runWithConcurrency(cstDayStarts(startAt, endAt), 2, async dayStart => {
    const isToday = dayStart === todayStartCst();
    const cachedRecords = isToday ? null : lockHistoryCache.read(dayStart, scopeKey);
    if (cachedRecords) {
      intervals.push(...occupancyIntervals(cachedRecords).filter(interval => targetNodes.has(interval.node)));
      return;
    }
    const responses = await Promise.all((bots || []).map(async bot => {
      try {
        const records = await requestJson(
          config.backend.lockbot.host,
          config.backend.lockbot.port,
          `/api/bots/${bot.id}/occupancy?date=${encodeURIComponent(cstDateKey(dayStart))}`,
          headers,
        );
        return { ok: true, records };
      } catch {
        return { ok: false, records: [] };
      }
    }));
    const failures = responses.filter(response => !response.ok).length;
    if (failures) {
      unavailableDays.add(dayStart);
      failureCount += failures;
    }
    const records = responses.flatMap(response => response.records);
    if (!failures && !isToday) {
      try {
        lockHistoryCache.save(dayStart, scopeKey, records);
      } catch (error) {
        console.warn(`Lock history cache write failed: ${error.message}`);
      }
    }
    intervals.push(...occupancyIntervals(records).filter(interval => targetNodes.has(interval.node)));
  });

  const todayStart = todayStartCst();
  if (endAt >= todayStart) {
    const states = await Promise.all((bots || []).map(async bot => {
      try {
        const state = await requestJson(
          config.backend.lockbot.host,
          config.backend.lockbot.port,
          `/api/bots/${bot.id}/state`,
          headers,
        );
        return { ok: true, type: botType(bot), state };
      } catch {
        return { ok: false };
      }
    }));
    const failures = states.filter(state => !state.ok).length;
    if (failures) {
      unavailableDays.add(todayStart);
      failureCount += failures;
    }
    intervals.push(...stateIntervals(states.filter(state => state.ok), todayStart, Math.floor(Date.now() / 1000)).filter(interval => targetNodes.has(interval.node)));
  }

  const totalCards = targetNodes.size * CARD_COUNT;
  const samples = lockedCardSamples(intervals, startAt, endAt, intervalSeconds);
  const lock = samples.map(sample => unavailableDays.has(cstDayStart(sample.sampledAt)) ? null : sample.lockedCards / totalCards * 100);
  const last = lock.reduce((result, value, index) => Number.isFinite(value) ? startAt + index * intervalSeconds : result, null);
  return { lock, lockDataAsOf: last, lockStatus: { complete: failureCount === 0, failureCount } };
}

function createTrendService(config, options = {}) {
  const inflight = new Map();
  const lockHistoryCache = options.lockHistoryCache || defaultLockHistoryCache();
  const share = (key, work) => {
    if (!inflight.has(key)) {
      inflight.set(key, Promise.resolve().then(work).finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  };
  return {
    async query(startAt, endAt, authorization, nodes = null, intervalSeconds = 300) {
      startAt = Math.floor(startAt / intervalSeconds) * intervalSeconds;
      endAt = Math.floor(endAt / intervalSeconds) * intervalSeconds;
      const targetNodes = nodes || MONITORED_NODES.map(node => `node${node}`);
      const key = hashKey({
        startAt,
        endAt,
        intervalSeconds,
        targetNodes: [...targetNodes].sort(),
        authorization: crypto.createHash('sha256').update(authorization || '').digest('hex'),
      });
      return share(key, async () => {
        const startedAt = performance.now();
        let monqueryMs = 0;
        let lockMs = 0;
        let completed = false;
        try {
          const monqueryStartedAt = performance.now();
          const samples = await fetchMonqueryWindow(config, startAt, endAt, intervalSeconds, targetNodes);
          monqueryMs = performance.now() - monqueryStartedAt;
          const times = samples.map(sample => sample.sampledAt);
          const xpu = samples.map(sample => sample.xpu);
          const memory = samples.map(sample => sample.memory);
          const lockStartedAt = performance.now();
          const lock = await lockSeries(config, startAt, endAt, authorization, intervalSeconds, targetNodes, lockHistoryCache);
          lockMs = performance.now() - lockStartedAt;
          const dataAsOf = times.reduce((result, timestamp, index) => Number.isFinite(xpu[index]) || Number.isFinite(memory[index]) ? timestamp : result, null);
          completed = true;
          return { times, xpu, memory, ...lock, dataAsOf, targetNodes, cache: { mode: 'lock-history' } };
        } finally {
          console.info(
            `[cluster] 趋势请求${completed ? '完成' : '失败'} · 总计 ${formatDuration(performance.now() - startedAt)} · Monquery ${formatDuration(monqueryMs)} · Lock Bot ${formatDuration(lockMs)} · Lock Bot 节点 ${targetNodes.length} · Monquery 节点 ${MONITORED_NODES.length} · 批次 ${Math.ceil(MONITORED_NODES.length / MONQUERY_NODE_BATCH_SIZE)} · ${formatMonqueryDateTime(startAt)}-${formatMonqueryDateTime(endAt)}`,
          );
        }
      });
    },
  };
}

module.exports = {
  createTrendService,
  _private: { botType, lockedCardSamples, stateIntervals },
};
