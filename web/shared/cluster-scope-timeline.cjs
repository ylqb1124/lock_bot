// cluster-scope-timeline.cjs
// 基于 cluster-scope.json 的 nodeGroups 字段，按时间点动态计算"当时实际存在的节点集合/总卡数"。
// 新增监控节点不能改写历史趋势：XPU、显存和锁定率都必须按每个采样点的时间，
// 只统计那个时间点已经生效（effectiveFrom <= 采样时间）的节点。
//
// 使用方式：
//   const { buildNodeTimeline, totalCardsAt } = require('./cluster-scope-timeline.cjs');
//   const timeline = buildNodeTimeline(clusterScope, targetNodeIds); // 只统计请求范围内的节点子集
//   totalCardsAt(timeline, clusterScope.cardsPerNode, sampledAtSeconds);

const CST_OFFSET_SECONDS = 8 * 60 * 60;

function effectiveFromToSeconds(effectiveFrom) {
  const value = String(effectiveFrom);
  const dateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    // 仅日期表示该日期 00:00:00 CST。
    return Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0) / 1000 - CST_OFFSET_SECONDS;
  }

  // 精确生效时间必须显式带 +08:00，避免部署主机的本地时区影响历史趋势。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+08:00$/.test(value)) {
    throw new Error(`Invalid nodeGroups.effectiveFrom: ${effectiveFrom}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid nodeGroups.effectiveFrom: ${effectiveFrom}`);
  return Math.floor(timestamp / 1000);
}

/**
 * 把 nodeGroups 按 effectiveFrom 升序展开为一个"累计节点数"的阶梯序列，
 * 只统计落在 targetNodeIds（Set 或数组）范围内的节点，用于支持前端节点筛选场景下的分母计算。
 * 返回形如 [{ effectiveFromSeconds, cumulativeCount }, ...]，按 effectiveFromSeconds 升序排列。
 */
function buildNodeScopeTimeline(clusterScope, targetNodeIds) {
  const targetSet = targetNodeIds instanceof Set ? targetNodeIds : new Set(targetNodeIds);
  const groups = (clusterScope.nodeGroups || [])
    .map(group => ({
      effectiveFromSeconds: effectiveFromToSeconds(group.effectiveFrom),
      nodeIds: group.nodeIds.filter(nodeId => targetSet.has(nodeId)),
    }))
    .sort((a, b) => a.effectiveFromSeconds - b.effectiveFromSeconds);

  const activeNodeIds = [];
  return groups.map(group => {
    activeNodeIds.push(...group.nodeIds);
    return { effectiveFromSeconds: group.effectiveFromSeconds, nodeIds: [...activeNodeIds] };
  });
}

function buildNodeTimeline(clusterScope, targetNodeIds) {
  return buildNodeScopeTimeline(clusterScope, targetNodeIds)
    .map(step => ({ effectiveFromSeconds: step.effectiveFromSeconds, cumulativeCount: step.nodeIds.length }));
}

/**
 * 为锁定率生成专用节点范围时间线。lockUsageExclusions 只影响锁定率的
 * 分子与分母，不改变 XPU/显存趋势、Monquery 查询范围或当前概览的节点范围。
 */
function buildLockUsageScopeTimeline(clusterScope, targetNodeIds) {
  const targetSet = targetNodeIds instanceof Set ? targetNodeIds : new Set(targetNodeIds);
  const events = new Map();
  const addEvent = (effectiveFrom, type, nodeIds) => {
    const effectiveFromSeconds = effectiveFromToSeconds(effectiveFrom);
    const event = events.get(effectiveFromSeconds) || { add: [], remove: [] };
    event[type].push(...nodeIds.filter(nodeId => targetSet.has(nodeId)));
    events.set(effectiveFromSeconds, event);
  };

  for (const group of clusterScope.nodeGroups || []) addEvent(group.effectiveFrom, 'add', group.nodeIds || []);
  for (const group of clusterScope.lockUsageExclusions || []) addEvent(group.effectiveFrom, 'remove', group.nodeIds || []);

  const activeNodeIds = new Set();
  const removedNodeIds = new Set();
  return [...events.entries()]
    .sort(([left], [right]) => left - right)
    .map(([effectiveFromSeconds, event]) => {
      for (const nodeId of event.add) {
        if (!removedNodeIds.has(nodeId)) activeNodeIds.add(nodeId);
      }
      for (const nodeId of event.remove) {
        removedNodeIds.add(nodeId);
        activeNodeIds.delete(nodeId);
      }
      return { effectiveFromSeconds, nodeIds: [...activeNodeIds] };
    });
}

function buildLockUsageTimeline(clusterScope, targetNodeIds) {
  return buildLockUsageScopeTimeline(clusterScope, targetNodeIds)
    .map(step => ({ effectiveFromSeconds: step.effectiveFromSeconds, cumulativeCount: step.nodeIds.length }));
}

/**
 * 给定时间线（buildNodeTimeline 的返回值）和某个采样时间点，
 * 返回该时间点"已生效"的节点数（取 <= sampledAt 的最后一个阶梯的累计值）。
 */
function nodeCountAt(timeline, sampledAtSeconds) {
  let count = 0;
  for (const step of timeline) {
    if (step.effectiveFromSeconds > sampledAtSeconds) break;
    count = step.cumulativeCount;
  }
  return count;
}

function nodeIdsAt(timeline, sampledAtSeconds) {
  let nodeIds = [];
  for (const step of timeline) {
    if (step.effectiveFromSeconds > sampledAtSeconds) break;
    nodeIds = step.nodeIds;
  }
  return nodeIds;
}

function totalCardsAt(timeline, cardsPerNode, sampledAtSeconds) {
  return nodeCountAt(timeline, sampledAtSeconds) * cardsPerNode;
}

module.exports = {
  buildNodeScopeTimeline,
  buildNodeTimeline,
  buildLockUsageScopeTimeline,
  buildLockUsageTimeline,
  nodeIdsAt,
  nodeCountAt,
  totalCardsAt,
};
