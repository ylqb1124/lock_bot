// api.js - API 调用层
// 封装 Lock Bot 和 Monquery 的 HTTP 调用，纯异步函数，不含业务逻辑

// 本地代理路径（通过 proxy.js 解决 CORS）
// 直接改为内网地址也可（如果网络/CORS 条件允许）
const MONQUERY_BASE = '/monquery';
const LOCKBOT_BASE = '/lockbot';

// 两批节点使用不同的 namespace
const CLUSTER_BACKUP = 'wxtky02-p800-backup-8nic-vd';
const CLUSTER_NON_BACKUP = 'wxtky02-p800-8nic-vd';

// 非 backup namespace 的节点
const NON_BACKUP_NODES = [32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69];

import clusterScope from '../../shared/cluster-scope.json' with { type: 'json' };

const MONITORED_NODES = clusterScope.nodeIds;
const CARDS_PER_NODE = clusterScope.cardsPerNode;

function buildNamespace(nodeNum) {
  const cluster = NON_BACKUP_NODES.includes(nodeNum) ? CLUSTER_NON_BACKUP : CLUSTER_BACKUP;
  return `${cluster}-node${nodeNum}.wxtky02`;
}

// 核心指标：整机级先展示，卡级指标后续渐进补齐
const MONQUERY_NODE_ITEMS = ['XPU_AVERAGE_UTILIZATION'];
const MONQUERY_CARD_XPU_ITEMS = Array.from({ length: CARDS_PER_NODE }, (_, c) => `XPU${c}_XPU_UTILIZATION`);
const MONQUERY_CARD_MEM_ITEMS = Array.from({ length: CARDS_PER_NODE }, (_, c) => `XPU${c}_MEM_UTILIZATION`);
const MONQUERY_CARD_ITEMS = [...MONQUERY_CARD_XPU_ITEMS, ...MONQUERY_CARD_MEM_ITEMS];
const MONQUERY_ITEMS = [...MONQUERY_NODE_ITEMS, ...MONQUERY_CARD_ITEMS];
export const DEFAULT_MONQUERY_TIMEOUT_MS = 60_000;
export const CURRENT_MONQUERY_TIMEOUT_MS = 12_000;

function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

/**
 * Lock Bot 登录，返回 JWT access_token
 */
export async function loginLockBot(username, password) {
  const resp = await fetchWithTimeout(`${LOCKBOT_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return data.access_token;
}

/**
 * 获取当前用户的所有 Bot 列表
 */
export async function fetchLockBotList(token) {
  const resp = await fetchWithTimeout(`${LOCKBOT_BASE}/api/bots`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Fetch bot list failed: ${resp.status}`);
  return resp.json();
}

/**
 * 获取单个 Bot 的状态（节点/设备占用情况）
 */
export async function fetchLockBotState(botId, token) {
  const resp = await fetchWithTimeout(`${LOCKBOT_BASE}/api/bots/${botId}/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Fetch bot state failed: ${resp.status}`);
  return resp.json();
}

/**
 * 批量查询所有 Bot 的状态
 */
export async function fetchAllBotStates(token) {
  const resp = await fetchWithTimeout(`${LOCKBOT_BASE}/api/bots/running-states`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Fetch all bot states failed: ${resp.status}`);
  const payload = await resp.json();
  const states = payload?.data ?? payload;
  if (!states || typeof states !== 'object' || Array.isArray(states)) {
    throw new Error('Fetch all bot states returned an invalid response');
  }
  return states;
}

/**
 * 查询 Bot 的当天历史占用记录
 * @param {number} botId - Bot ID
 * @param {string} date - 日期 "YYYY-MM-DD"
 * @param {string} token - JWT token
 * @returns {Promise<Array>} 占用记录数组 [{node_key, user_id, lock_mode, start_time, end_time, duration_seconds}]
 */
export async function fetchLockBotOccupancy(botId, date, token) {
  const resp = await fetchWithTimeout(
    `${LOCKBOT_BASE}/api/bots/${botId}/occupancy?date=${encodeURIComponent(date)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Fetch occupancy failed: ${resp.status}`);
  return resp.json();
}

/**
 * 查询指定节点 + 指标的 Monquery 数据
 * @param {string} start - 起始时间 YYYYMMDDHHmmss
 * @param {string} end   - 结束时间 YYYYMMDDHHmmss
 * @param {number[]} nodeNums - 节点编号
 * @param {string[]} items - 指标名
 * @returns {Promise<Array>} monquery data[] 数组
 */
async function fetchMonqueryItems(start, end, nodeNums, items, options = {}) {
  if (!nodeNums.length || !items.length) return [];
  const namespaces = nodeNums.map(buildNamespace).join(',');
  const url = `${MONQUERY_BASE}/monquery/getHistoryitemdata` +
    `?namespaces=${encodeURIComponent(namespaces)}` +
    `&items=${encodeURIComponent(items.join(','))}` +
    `&start=${start}&end=${end}&interval=300`;
  let resp;
  try {
    resp = await fetchWithTimeout(url, {}, options.timeoutMs ?? DEFAULT_MONQUERY_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
      throw new Error('Monquery 请求超时，请缩短时间范围后重试');
    }
    throw error;
  }
  if (!resp.ok) throw new Error(`Monquery fetch failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(`Monquery error: ${data.message}`);
  return data.data || [];
}

function makeNodeBatches(batchSize) {
  const batches = [];
  for (let i = 0; i < MONITORED_NODES.length; i += batchSize) {
    batches.push(MONITORED_NODES.slice(i, i + batchSize));
  }
  return batches;
}

function parseMonqueryDateTime(value) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) throw new Error(`Invalid Monquery datetime: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) - 8 * 60 * 60 * 1000);
}

function formatMonqueryDateTime(value) {
  const date = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function makeTimeSlices(start, end, maxDurationMs = 24 * 60 * 60 * 1000) {
  const slices = [];
  let cursor = parseMonqueryDateTime(start);
  const finish = parseMonqueryDateTime(end);
  while (cursor < finish) {
    const sliceEnd = new Date(Math.min(cursor.getTime() + maxDurationMs, finish.getTime()));
    slices.push([formatMonqueryDateTime(cursor), formatMonqueryDateTime(sliceEnd)]);
    cursor = sliceEnd;
  }
  return slices.length ? slices : [[start, end]];
}

function itemPoints(item) {
  if (Array.isArray(item)) return item;
  if (Array.isArray(item?.Data)) return item.Data;
  if (Array.isArray(item?.data)) return item.data;
  return [];
}

function mergeMonquerySlices(results) {
  const namespaces = new Map();
  for (const entries of results) {
    for (const entry of entries || []) {
      if (!entry?.NameSpace) continue;
      if (!namespaces.has(entry.NameSpace)) namespaces.set(entry.NameSpace, { ...entry, Items: {} });
      const target = namespaces.get(entry.NameSpace);
      for (const [name, item] of Object.entries(entry.Items || {})) {
        const points = target.Items[name] || new Map();
        for (const point of itemPoints(item)) {
          const timestamp = point?.Timestamp ?? point?.timestamp ?? point?.time;
          if (timestamp != null) points.set(String(timestamp), point);
        }
        target.Items[name] = points;
      }
    }
  }
  return Array.from(namespaces.values(), entry => ({
    ...entry,
    Items: Object.fromEntries(Object.entries(entry.Items).map(([name, points]) => [name, Array.from(points.values())])),
  }));
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * 先查询整机级 XPU 平均利用率，用于快速首屏渲染
 */
export async function fetchMonqueryNodeUtilization(start, end) {
  const results = await Promise.all(
    makeNodeBatches(24).map(nodeNums => fetchMonqueryItems(start, end, nodeNums, MONQUERY_NODE_ITEMS))
  );
  return results.flat();
}

/**
 * 分批查询卡级 XPU/显存指标，调用方可按批次渐进渲染
 */
export async function* fetchMonqueryCardUtilizationBatches(start, end, options = {}) {
  const batchSize = options.batchSize || 8;
  const pending = makeNodeBatches(batchSize).map((nodeNums, index) => {
    const entry = { index, nodeNums, promise: null };
    entry.promise = fetchMonqueryItems(start, end, nodeNums, MONQUERY_CARD_ITEMS)
      .then(data => ({ entry, nodeNums, data }));
    return entry;
  });
  while (pending.length) {
    const batch = await Promise.race(pending.map(entry => entry.promise));
    const idx = pending.indexOf(batch.entry);
    if (idx >= 0) pending.splice(idx, 1);
    yield { nodeNums: batch.nodeNums, data: batch.data };
  }
}

/**
 * 批量查询固定监控节点集合（详见 web/shared/cluster-scope.json）的完整数据（保留兼容 average.html 等旧调用）
 * @param {string} start - 起始时间 YYYYMMDDHHmmss
 * @param {string} end   - 结束时间 YYYYMMDDHHmmss
 * @returns {Promise<Array>} monquery data[] 数组
 */
export async function fetchClusterTrend(start, end, token, intervalSeconds, nodes) {
  const params = new URLSearchParams({
    start: String(Math.floor(start.getTime() / 1000)),
    end: String(Math.floor(end.getTime() / 1000)),
    interval: String(intervalSeconds),
  });
  if (Array.isArray(nodes)) params.set('nodes', nodes.join(','));
  const resp = await fetchWithTimeout(`/api/cluster-trend?${params}`, { headers: { Authorization: `Bearer ${token}` } }, 180_000);
  if (!resp.ok) throw new Error(`Fetch cluster trend failed: ${resp.status}`);
  return resp.json();
}

export async function fetchMonqueryUtilization(start, end, options = {}) {
  const tasks = [];
  for (const [sliceStart, sliceEnd] of makeTimeSlices(start, end)) {
    for (const nodeNums of makeNodeBatches(16)) {
      tasks.push(() => fetchMonqueryItems(sliceStart, sliceEnd, nodeNums, MONQUERY_ITEMS, options));
    }
  }
  const results = await runWithConcurrency(tasks, options.concurrency ?? 6);
  return mergeMonquerySlices(results);
}

/**
 * 判断错误是否为 AbortController 超时/中止，用于区分主动取消和真实网络异常
 */
export function isAbortError(err) {
  return err && err.name === 'AbortError';
}

export { CARDS_PER_NODE, MONITORED_NODES, MONQUERY_ITEMS, MONQUERY_NODE_ITEMS, MONQUERY_CARD_ITEMS };
