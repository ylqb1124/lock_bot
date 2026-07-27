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

function effectiveFromToSeconds(dateKey) {
  const match = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid nodeGroups.effectiveFrom: ${dateKey}`);
  const [, year, month, day] = match;
  // 该日期 00:00:00 CST 对应的 Unix 秒
  return Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0) / 1000 - CST_OFFSET_SECONDS;
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

module.exports = { buildNodeScopeTimeline, buildNodeTimeline, nodeIdsAt, nodeCountAt, totalCardsAt };
