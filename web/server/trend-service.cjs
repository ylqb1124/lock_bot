const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const clusterScope = require('../shared/cluster-scope.json');
const { buildNodeScopeTimeline, buildNodeTimeline, nodeIdsAt, totalCardsAt } = require('../shared/cluster-scope-timeline.cjs');

const CLUSTER_BACKUP = 'wxtky02-p800-backup-8nic-vd';
const CLUSTER_NON_BACKUP = 'wxtky02-p800-8nic-vd';
const NON_BACKUP_NODES = new Set([32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79]);
const MONITORED_NODES = clusterScope.nodeIds;
const CARD_COUNT = clusterScope.cardsPerNode;
const ITEMS = ['XPU_AVERAGE_UTILIZATION', ...Array.from({ length: CARD_COUNT }, (_, card) => `XPU${card}_MEM_UTILIZATION`)];
const MONQUERY_NODE_BATCH_SIZE = 16;
const DAY_SECONDS = 24 * 60 * 60;
const CST_OFFSET_SECONDS = 8 * 60 * 60;
const LOCK_HISTORY_CACHE_DIR = path.join(__dirname, '..', '.devdata', 'lock-history');
const LOCK_HISTORY_CACHE_VERSION = 4;
const LOCK_HISTORY_CACHE_MAX_AGE_DAYS = 180;
const LOCK_HISTORY_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCK_HISTORY_CACHE_FILENAME_PATTERN = /-(\d{4,})-(\d{2})-(\d{2})\.json$/;

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

function lockHistoryScopeKey(nodeNames) {
  return hashKey({
    version: LOCK_HISTORY_CACHE_VERSION,
    nodes: [...new Set(nodeNames)].sort(),
  });
}

function pruneLockHistoryCache(maxAgeDays = LOCK_HISTORY_CACHE_MAX_AGE_DAYS, directory = LOCK_HISTORY_CACHE_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return { removed: 0, scanned: 0 };
  }
  const cutoff = Date.now() - maxAgeDays * DAY_SECONDS * 1000;
  let removed = 0;
  for (const entry of entries) {
    const match = entry.match(LOCK_HISTORY_CACHE_FILENAME_PATTERN);
    if (!match) continue;
    const [, year, month, day] = match;
    const fileDate = new Date(Number(year), Number(month) - 1, Number(day));
    if (Number.isNaN(fileDate.getTime()) || fileDate.getTime() >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(directory, entry));
      removed += 1;
    } catch (error) {
      console.warn(`Lock history cache prune failed for ${entry}: ${error.message}`);
    }
  }
  if (removed) console.info(`[cluster] 已清理 ${removed} 个超过 ${maxAgeDays} 天的锁定历史缓存文件`);
  return { removed, scanned: entries.length };
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

function monitoredNodeIds(requestedNodes = null) {
  if (!requestedNodes) return MONITORED_NODES;
  const requestedIds = new Set(requestedNodes
    .map(node => String(node).match(/^node(\d+)$/i))
    .map(match => match ? Number(match[1]) : NaN)
    .filter(node => MONITORED_NODES.includes(node)));
  return MONITORED_NODES.filter(node => requestedIds.has(node));
}

function sameNodeIds(left, right) {
  return left.length === right.length && left.every((nodeId, index) => nodeId === right[index]);
}

function monqueryWindows(scopeTimeline, startAt, endAt, intervalSeconds) {
  const windows = [];
  let window = null;
  for (let sampledAt = startAt; sampledAt <= endAt; sampledAt += intervalSeconds) {
    const nodeIds = nodeIdsAt(scopeTimeline, sampledAt);
    if (!window || !sameNodeIds(window.nodeIds, nodeIds)) {
      if (window) windows.push(window);
      window = { startAt: sampledAt, endAt: sampledAt, nodeIds };
    } else {
      window.endAt = sampledAt;
    }
  }
  if (window) windows.push(window);
  return windows;
}

async function fetchMonqueryNodes(config, startAt, endAt, intervalSeconds, nodes) {
  if (!nodes.length) return parseSamples([], startAt, endAt, intervalSeconds);
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

async function fetchMonqueryWindow(config, startAt, endAt, intervalSeconds, requestedNodes = null) {
  const targetNodeIds = monitoredNodeIds(requestedNodes);
  const scopeTimeline = buildNodeScopeTimeline(clusterScope, targetNodeIds);
  const windows = monqueryWindows(scopeTimeline, startAt, endAt, intervalSeconds);
  const samples = await Promise.all(windows.map(window => fetchMonqueryNodes(
    config,
    window.startAt,
    window.endAt,
    intervalSeconds,
    window.nodeIds,
  )));
  return { samples: samples.flat(), nodeCounts: windows.map(window => window.nodeIds.length) };
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
  if (/[Zz]|[+-]\d{2}:\d{2}$/.test(text)) return Math.floor(Date.parse(text) / 1000);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = '00'] = match;
  return Math.floor(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) / 1000) - CST_OFFSET_SECONDS;
}

function recordCards(record) {
  const card = Number(record?.dev_id ?? record?.device_id ?? record?.card_id);
  return Number.isInteger(card) && card >= 0 && card < CARD_COUNT ? [card] : Array.from({ length: CARD_COUNT }, (_, index) => index);
}

function botType(bot) {
  return String(bot?.bot_type || bot?.type || 'NODE').toUpperCase();
}

function lockedCardSamples(intervals, startAt, endAt, intervalSeconds, activeNodesAt = null) {
  const locked = new Map();
  for (const interval of intervals) {
    const start = interval.start;
    const end = interval.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    for (let timestamp = Math.max(startAt, Math.floor(start / intervalSeconds) * intervalSeconds); timestamp <= Math.min(endAt, end - 1); timestamp += intervalSeconds) {
      if (activeNodesAt && !activeNodesAt(timestamp).has(interval.node)) continue;
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
    const start = toSeconds(record.start_time_cn ?? record.start_time);
    const endTime = toSeconds(record.end_time_cn ?? record.end_time);
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
  const scopeKey = lockHistoryScopeKey([...targetNodes]);
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

  const targetNodeIds = monitoredNodeIds([...targetNodes]);
  const scopeTimeline = buildNodeScopeTimeline(clusterScope, targetNodeIds);
  const timeline = buildNodeTimeline(clusterScope, targetNodeIds);
  const activeNodeNames = new Map();
  const activeNodesAt = sampledAt => {
    if (!activeNodeNames.has(sampledAt)) {
      activeNodeNames.set(sampledAt, new Set(nodeIdsAt(scopeTimeline, sampledAt).map(nodeId => `node${nodeId}`)));
    }
    return activeNodeNames.get(sampledAt);
  };
  const samples = lockedCardSamples(intervals, startAt, endAt, intervalSeconds, activeNodesAt);
  const lock = samples.map(sample => unavailableDays.has(cstDayStart(sample.sampledAt)) ? null : sample.lockedCards / totalCardsAt(timeline, CARD_COUNT, sample.sampledAt) * 100);
  const last = lock.reduce((result, value, index) => Number.isFinite(value) ? startAt + index * intervalSeconds : result, null);
  return { lock, lockDataAsOf: last, lockStatus: { complete: failureCount === 0, failureCount } };
}

function createTrendService(config, options = {}) {
  const inflight = new Map();
  const lockHistoryCache = options.lockHistoryCache || defaultLockHistoryCache();
  if (!options.lockHistoryCache && options.pruneOnStart !== false) {
    pruneLockHistoryCache();
    setInterval(pruneLockHistoryCache, LOCK_HISTORY_CACHE_PRUNE_INTERVAL_MS).unref();
  }
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
        let monqueryNodeCounts = [];
        let lockMs = 0;
        let completed = false;
        try {
          const monqueryStartedAt = performance.now();
          const monquery = await fetchMonqueryWindow(config, startAt, endAt, intervalSeconds, targetNodes);
          monqueryMs = performance.now() - monqueryStartedAt;
          monqueryNodeCounts = monquery.nodeCounts;
          const { samples } = monquery;
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
            `[cluster] 趋势请求${completed ? '完成' : '失败'} · 总计 ${formatDuration(performance.now() - startedAt)} · Monquery ${formatDuration(monqueryMs)} · Lock Bot ${formatDuration(lockMs)} · Lock Bot 节点 ${targetNodes.length} · Monquery 节点 ${monqueryNodeCounts.join('→') || 0} · 批次 ${monqueryNodeCounts.map(count => Math.ceil(count / MONQUERY_NODE_BATCH_SIZE)).join('→') || 0} · ${formatMonqueryDateTime(startAt)}-${formatMonqueryDateTime(endAt)}`,
          );
        }
      });
    },
  };
}

module.exports = {
  createTrendService,
  createLockHistoryCache: defaultLockHistoryCache,
  lockHistoryScopeKey,
  _private: { botType, lockedCardSamples, occupancyIntervals, stateIntervals, pruneLockHistoryCache },
};
