// adapter.js - 数据适配层
// 将 Lock Bot + Monquery 的原始 API 响应转换为前端渲染所需的 NodeData[]

import clusterScope from '../../shared/cluster-scope.json' with { type: 'json' };

const CARD_COUNT = clusterScope.cardsPerNode;
const SLOT_COUNT = 288; // 24h / 5min = 288 槽
const CHINA_OFFSET_SECONDS = 8 * 60 * 60;

// ---- 辅助函数 ----

/**
 * Unix 时间戳（秒）→ 北京时间 5 分钟槽索引 (0-287)
 */
function toSlotIndex(ts) {
  return Math.floor(((ts + CHINA_OFFSET_SECONDS) % 86400) / 300);
}

function parseChinaLikeTimestamp(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  const str = String(raw).trim();
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  if (/[Zz]|[+-]\d{2}:\d{2}$/.test(str)) {
    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? 0 : Math.floor(parsed.getTime() / 1000);
  }
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second = '00'] = match;
  return Math.floor(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) / 1000) - CHINA_OFFSET_SECONDS;
}

/**
 * 从 lock bot 节点名提取前缀 + 数字 ID
 * "gpu-node-01" → { prefix: 'node', id: 1 }
 * "bdc9"         → { prefix: 'bdc',  id: 9 }
 * 返回 null 表示无法识别
 */
function extractNodeId(name) {
  const std = String(name).match(/^(?:gpu-)?node-?(\d+)$/);
  if (std) return { prefix: 'node', id: parseInt(std[1], 10) };
  const bdc = String(name).match(/^bdc-?(\d+)$/);
  if (bdc) return { prefix: 'bdc', id: parseInt(bdc[1], 10) };
  return null;
}

/**
 * 从 monquery namespace 中提取节点数字 ID
 * "wxtky02-p800-backup-8nic-vd-node1.wxtky02" → 1
 */
function extractNodeIdFromNamespace(ns) {
  const m = ns.match(/node(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 将 Monquery 稀疏时间序列填充为 288 槽数组（5 分钟粒度）
 * 同一槽内的多个数据点取平均
 */
function fillUtilArray(series) {
  const arr = new Array(SLOT_COUNT).fill(null);
  const counts = new Array(SLOT_COUNT).fill(0);
  if (!series || !series.length) return arr;
  for (const pt of series) {
    const timestamp = Number(pt?.Timestamp ?? pt?.timestamp ?? pt?.time);
    const value = Number(pt?.Value ?? pt?.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
    const seconds = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    const idx = toSlotIndex(seconds);
    if (idx >= 0 && idx < SLOT_COUNT) {
      arr[idx] = (arr[idx] || 0) + value;
      counts[idx]++;
    }
  }
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (counts[i] > 0) arr[i] /= counts[i];
  }
  return arr;
}

/**
 * 构建占用时间段（5 分钟槽索引范围）
 * 返回 { start, end, user }，两端 clamp 到 [0, SLOT_COUNT-1]
 */
/**
 * 将任意格式时间戳归一化为 Unix 秒
 * 支持: Unix秒（<=1e12）、Unix毫秒（>1e12）、ISO字符串
 * 解析失败返回 0
 */
function normalizeToUnixSec(raw) {
  return parseChinaLikeTimestamp(raw);
}

/**
 * 合并重叠/相邻的占用区间，避免时间线上视觉堆叠
 * 同用户相邻（gap ≤ 1 槽）也合并，视为同一次连续占用
 */
function mergeOverlappingOccupations(occs) {
  if (!occs || occs.length <= 1) return occs;
  // 按起始槽排序
  const sorted = [...occs].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    // 重叠或紧邻（gap ≤ 1 槽 = 5 分钟）
    if (cur.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, cur.end);
      // 合并用户名
      const users = new Set(prev.user.split(', ').filter(Boolean));
      for (const u of (cur.user || '').split(', ').filter(Boolean)) users.add(u);
      prev.user = [...users].join(', ');
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function currentChinaDate() {
  return new Date(Date.now() + CHINA_OFFSET_SECONDS * 1000).toISOString().slice(0, 10);
}

function chinaDayRange(displayDate = currentChinaDate()) {
  const match = String(displayDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const start = Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 1000)
    - CHINA_OFFSET_SECONDS;
  return { start, end: start + 86400 };
}

function projectOccupationToDay(startSec, endSec, userId, dayRange) {
  if (!dayRange || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  if (endSec <= dayRange.start || startSec >= dayRange.end) return null;
  const visibleStart = Math.max(startSec, dayRange.start);
  const visibleEnd = Math.min(endSec, dayRange.end);
  const start = Math.max(0, Math.min(SLOT_COUNT - 1, Math.floor((visibleStart - dayRange.start) / 300)));
  const end = Math.max(0, Math.min(SLOT_COUNT, Math.floor((visibleEnd - dayRange.start) / 300)));
  if (end <= start) return null;
  return { start, end, user: userId || '' };
}

function buildOccupationRange(startTime, duration, userId, dayRange) {
  const startSec = normalizeToUnixSec(startTime);
  const durationSec = Number(duration);
  const endSec = startSec + (Number.isFinite(durationSec) ? durationSec : 0);
  return projectOccupationToDay(startSec, endSec, userId, dayRange);
}

/**
 * 按数字 ID 索引 monquery 数据，便于 O(1) 查找
 */
function indexMonqueryByName(data) {
  const map = {};
  for (const entry of data) {
    const nodeId = extractNodeIdFromNamespace(entry.NameSpace);
    if (nodeId) map[nodeId] = entry.Items;
  }
  return map;
}

export function mergeMonqueryData(existing = [], incoming = []) {
  const byNs = new Map();
  for (const entry of existing || []) {
    if (!entry || !entry.NameSpace) continue;
    byNs.set(entry.NameSpace, {
      ...entry,
      Items: { ...(entry.Items || {}) },
    });
  }
  for (const entry of incoming || []) {
    if (!entry || !entry.NameSpace) continue;
    const prev = byNs.get(entry.NameSpace);
    if (!prev) {
      byNs.set(entry.NameSpace, {
        ...entry,
        Items: { ...(entry.Items || {}) },
      });
    } else {
      prev.Items = {
        ...(prev.Items || {}),
        ...(entry.Items || {}),
      };
    }
  }
  return [...byNs.values()];
}

/**
 * 将历史占用记录按节点名分组并转为 occupation 数组
 * @param {Array} occupancyHistory - [{node_key, user_id, start_time, end_time, duration_seconds, ...}]
 * @param {object|null} dayRange - 展示当天（北京时间）的 Unix 秒区间 [start, end)
 * @returns {object} { nodeName: [{start, end, user}] }
 */
function groupHistoryOccupations(occupancyHistory, dayRange) {
  const map = {};
  if (!occupancyHistory || !occupancyHistory.length) return map;
  for (const rec of occupancyHistory) {
    const nodeId = extractNodeId(rec.node_key);
    if (!nodeId) continue;
    const name = nodeId.prefix + nodeId.id;
    if (!map[name]) map[name] = [];
    const startSec = normalizeToUnixSec(rec.start_time_cn ?? rec.start_time);
    let endSec = normalizeToUnixSec(rec.end_time_cn ?? rec.end_time);
    if (!endSec) {
      const duration = Number(rec.duration ?? rec.duration_seconds);
      endSec = Number.isFinite(duration) ? startSec + duration : startSec;
    }
    const occupation = projectOccupationToDay(startSec, endSec, rec.user_id, dayRange);
    if (occupation) map[name].push(occupation);
  }
  return map;
}

/**
 * 从显存利用率 288 槽数组推导占用时段
 * 显存 >= 10% 视为占用，连续占用槽合并为一条记录
 * @param {number[]} memUtil288 - 单卡 288 槽显存利用率
 * @returns {Array<{start, end}>}
 */
function deriveMemOccupations(memUtil288) {
  const ranges = [];
  let inRange = false, rangeStart = 0;
  for (let i = 0; i <= SLOT_COUNT; i++) {
    const busy = i < SLOT_COUNT && memUtil288[i] >= 10;
    if (busy && !inRange) {
      rangeStart = i;
      inRange = true;
    } else if (!busy && inRange) {
      ranges.push({ start: rangeStart, end: i - 1, user: '' });
      inRange = false;
    }
  }
  return ranges;
}

function hasMetricSamples(series) {
  return Array.isArray(series) && series.some(point => {
    const timestamp = Number(point?.Timestamp ?? point?.timestamp ?? point?.time);
    const value = Number(point?.Value ?? point?.value);
    return Number.isFinite(timestamp) && Number.isFinite(value);
  });
}

// ---- 主适配函数 ----

/**
 * 将两个 API 的原始响应统一转为 NodeData[]
 *
 * @param {object}  lockBotState    - Lock Bot /api/bots/{id}/state 返回值
 * @param {Array}   monqueryData    - Monquery getHistoryitemdata 返回的 data[]
 * @param {number}  nowIdx          - 当前 5 分钟槽索引 (0-287)
 * @param {string}  botType         - 'NODE' | 'DEVICE' | 'QUEUE'
 * @param {Array}   occupancyHistory - Lock Bot 历史占用记录（可选）
 * @param {string}  displayDate - 当前时间线日期，格式 YYYY-MM-DD（北京时间）
 * @returns {Array<NodeData>}
 */
export function adaptNodeData(lockBotState, monqueryData, nowIdx, botType, occupancyHistory = [], displayDate = currentChinaDate()) {
  const monqueryIndex = monqueryData ? indexMonqueryByName(monqueryData) : {};
  const dayRange = chinaDayRange(displayDate);
  const historyByNode = groupHistoryOccupations(occupancyHistory, dayRange);
  const nodes = [];

  for (const [lockBotName, state] of Object.entries(lockBotState)) {
    const nodeId = extractNodeId(lockBotName);
    if (!nodeId) continue;

    const name = nodeId.prefix + nodeId.id;
    // bdc 节点无 Monquery 数据
    const nodeItems = nodeId.prefix === 'bdc' ? null : monqueryIndex[nodeId.id];

    // ---- 解析 Lock Bot 占用信息（仅用于展示占用时段，不决定状态） ----
    let occupations = [];
    let cardOccupations = Array.from({ length: CARD_COUNT }, () => []);
    const occKeySet = new Set(); // 去重键

    function addOccupation(occ) {
      const key = `${occ.start},${occ.end},${occ.user}`;
      if (occKeySet.has(key)) return;
      occKeySet.add(key);
      occupations.push(occ);
      for (let c = 0; c < CARD_COUNT; c++) {
        cardOccupations[c].push(occ);
      }
    }

    // ---- 统计：真实卡数 + 每卡活跃锁状态 ----
    const cardStates = botType === 'DEVICE' ? (Array.isArray(state) ? state : []) : [];
    const cardCount = botType === 'DEVICE' ? (cardStates.length || CARD_COUNT) : CARD_COUNT;
    const cardHasActiveLock = new Array(CARD_COUNT).fill(false);
    let hasActiveLock = false;

    if (botType === 'DEVICE') {
      for (const dev of cardStates) {
        if (dev.dev_id >= 0 && dev.dev_id < CARD_COUNT) {
          const locked = dev.status !== 'idle' && (dev.current_users || []).length > 0;
          cardHasActiveLock[dev.dev_id] = locked;
          if (locked) hasActiveLock = true;
        }
      }
    } else {
      hasActiveLock = state.status !== 'idle' && (state.current_users || []).length > 0;
      cardHasActiveLock.fill(hasActiveLock);
    }

    if (botType === 'NODE' || botType === 'QUEUE') {
      // 整机粒度：所有卡共享节点级占用
      if (state.status !== 'idle') {
        for (const user of state.current_users || []) {
          const occupation = buildOccupationRange(user.start_time, user.duration, user.user_id, dayRange);
          if (occupation) addOccupation(occupation);
        }
      }
    } else if (botType === 'DEVICE') {
      // 单卡粒度（cardStates 已在上面计算）
      for (let c = 0; c < CARD_COUNT; c++) {
        const dev = cardStates.find(d => d.dev_id === c);
        if (dev && dev.status !== 'idle') {
          for (const user of dev.current_users || []) {
            const occ = buildOccupationRange(user.start_time, user.duration, user.user_id, dayRange);
            // 卡片级直接追加，节点级由后续合并
            if (occ) cardOccupations[c].push(occ);
          }
        }
      }
      // 从 cardOccupations 推导节点级 occupations（合并多卡的占用的最左到最右）
      let minStart = SLOT_COUNT, maxEnd = 0;
      const userIds = new Set();
      for (let c = 0; c < CARD_COUNT; c++) {
        for (const o of cardOccupations[c]) {
          if (o.start < minStart) minStart = o.start;
          if (o.end > maxEnd) maxEnd = o.end;
          userIds.add(o.user);
        }
      }
      if (maxEnd > minStart) {
        occupations.push({ start: minStart, end: maxEnd, user: [...userIds].join(', ') });
      }
    }

    // ---- 合并历史占用记录 ----
    const historyOccs = historyByNode[name] || [];
    for (const h of historyOccs) {
      const key = `${h.start},${h.end},${h.user}`;
      if (occKeySet.has(key)) continue;
      occKeySet.add(key);
      occupations.push(h);
      for (let c = 0; c < CARD_COUNT; c++) {
        cardOccupations[c].push(h);
      }
    }

    // ---- 解析利用率 ----
    let avgUtil = new Array(SLOT_COUNT).fill(null);
    let avgMemUtil = new Array(SLOT_COUNT).fill(null);
    const cardUtils = Array.from({ length: CARD_COUNT }, () => new Array(SLOT_COUNT).fill(null));
    const cardMemUtils = Array.from({ length: CARD_COUNT }, () => new Array(SLOT_COUNT).fill(null));

    const hasNodeMonqueryData = hasMetricSamples(nodeItems?.['XPU_AVERAGE_UTILIZATION']);
    let hasCardXpuMonqueryData = false;
    let hasMemMonqueryData = false;

    if (nodeItems) {
      const avgSeries = nodeItems['XPU_AVERAGE_UTILIZATION'];
      if (avgSeries) avgUtil = fillUtilArray(avgSeries);

      for (let c = 0; c < CARD_COUNT; c++) {
        const utilKey = `XPU${c}_XPU_UTILIZATION`;
        const memKey = `XPU${c}_MEM_UTILIZATION`;
        const utilSeries = nodeItems[utilKey];
        const memSeries = nodeItems[memKey];
        if (hasMetricSamples(utilSeries)) {
          hasCardXpuMonqueryData = true;
          cardUtils[c] = fillUtilArray(utilSeries);
        }
        if (hasMetricSamples(memSeries)) {
          hasMemMonqueryData = true;
          cardMemUtils[c] = fillUtilArray(memSeries);
        }
      }

      // 计算 8 卡显存平均利用率（逐槽取平均）
      if (hasMemMonqueryData) {
        for (let i = 0; i < SLOT_COUNT; i++) {
          const values = cardMemUtils.map(series => series[i]).filter(Number.isFinite);
          avgMemUtil[i] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        }
      }
    }

    const hasCardMonqueryData = hasCardXpuMonqueryData || hasMemMonqueryData;
    const hasMonqueryData = hasNodeMonqueryData || hasCardMonqueryData;

    // 用最新已完成槽代替当前进行中槽（Monquery 数据有 0-5min 延迟，nowIdx 可能指向未填充的槽）
    const effectiveIdx = Math.max(0, nowIdx - 1);
    const currentUtil = avgUtil[effectiveIdx];
    const currentMemUtil = avgMemUtil[effectiveIdx];

    // ---- 状态判定：卡级指标优先；整机级指标为加载卡级前的临时状态 ----
    let busyCards = 0;
    let knownCardCount = 0;
    const cardMetricStates = new Array(CARD_COUNT).fill('UNKNOWN');
    let statusSource = 'unknown';
    let nodeStatus = 'UNKNOWN';
    if (hasCardMonqueryData) {
      for (let c = 0; c < CARD_COUNT; c++) {
        const cm = cardMemUtils[c] ? cardMemUtils[c][effectiveIdx] : 0;
        const cu = cardUtils[c] ? cardUtils[c][effectiveIdx] : 0;
        if (!Number.isFinite(cm) && !Number.isFinite(cu)) continue;
        knownCardCount += 1;
        if (cm >= 10 || cu >= 10) {
          busyCards++;
          cardMetricStates[c] = 'BUSY';
        } else {
          cardMetricStates[c] = 'FREE';
        }
      }
      if (knownCardCount === CARD_COUNT) {
        nodeStatus = busyCards === 0 ? 'FREE' : busyCards === CARD_COUNT ? 'BUSY' : 'PARTIAL';
        statusSource = 'card-metrics';
      } else if (busyCards > 0) {
        nodeStatus = 'PARTIAL';
        statusSource = 'partial-card-metrics';
      }
    }
    if (knownCardCount === 0 && Number.isFinite(currentUtil)) {
      nodeStatus = currentUtil >= 10 ? 'BUSY' : 'FREE';
      statusSource = 'node-metric';
    }

    // ---- 合并重叠的占用区间（避免时间线上视觉堆叠） ----
    occupations = mergeOverlappingOccupations(occupations);
    for (let c = 0; c < CARD_COUNT; c++) {
      cardOccupations[c] = mergeOverlappingOccupations(cardOccupations[c]);
    }

    // ---- 从显存数据推导每张卡的实际占用时段 ----
    const cardMemOccupations = hasMemMonqueryData
      ? Array.from({ length: CARD_COUNT }, (_, c) => deriveMemOccupations(cardMemUtils[c]))
      : Array.from({ length: CARD_COUNT }, () => []);

    nodes.push({
      name,
      status: nodeStatus,
      currentUtil,
      currentMemUtil,
      avgUtil,
      avgMemUtil,
      cardUtils,
      cardMemUtils,
      occupations,
      cardOccupations,
      cardMemOccupations,
      botType,
      hasMonqueryData,
      hasNodeMonqueryData,
      hasCardMonqueryData,
      hasMemMonqueryData,
      knownCardCount,
      busyCards,
      cardMetricStates,
      statusSource,
      hasActiveLock,
      cardCount,
      cardHasActiveLock,
    });
  }

  // 按前缀 + 数字 ID 排序（node1, node2, ..., bdc9, bdc19, ...）
  nodes.sort((a, b) => {
    const parse = name => {
      if (name.startsWith('bdc')) return { prefix: 'bdc', id: parseInt(name.slice(3), 10) };
      return { prefix: 'node', id: parseInt(name.slice(4), 10) };
    };
    const va = parse(a.name), vb = parse(b.name);
    if (va.prefix !== vb.prefix) return va.prefix === 'node' ? -1 : 1;
    return va.id - vb.id;
  });

  return nodes;
}
