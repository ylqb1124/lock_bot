function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
}

export function averageFinite(values = []) {
  const populated = values.filter(Number.isFinite);
  return populated.length ? populated.reduce((sum, value) => sum + value, 0) / populated.length : null;
}

function formatAveragePeak(values) {
  const mean = averageFinite(values);
  const peak = values.filter(Number.isFinite).reduce((result, value) => Math.max(result, value), -Infinity);
  return mean === null || !Number.isFinite(peak) ? '--/--' : `${mean.toFixed(1)}%/${peak.toFixed(1)}%`;
}

export function buildClusterStats(currentNodes = [], series = {}, lockTrendComplete = true, cardsPerNode = 8) {
  const totalCards = currentNodes.length * cardsPerNode;
  const lockAverage = lockTrendComplete ? averageFinite(series.lock || []) : null;

  return [
    { label: '总节点', value: String(currentNodes.length), tone: 'total' },
    { label: '总卡数', value: String(totalCards), tone: 'total' },
    { label: '节点平均使用率', value: formatPercent(lockAverage), tone: 'locked', tip: '所选时段内，每个有效采样点的 Lock Bot 锁定卡比例的平均值，反映计算资源已分配给任务的平均规模。' },
    { label: 'XPU卡平均利用率/峰值利用率', value: formatAveragePeak(series.xpu || []), tone: 'xpu-avg', tip: '平均利用率反映所选时段内集群整体计算负载；峰值利用率反映该时段最高负载水平。' },
    { label: '显存平均利用率/峰值利用率', value: formatAveragePeak(series.memory || []), tone: 'mem-avg', tip: '平均利用率反映所选时段内集群整体显存压力；峰值利用率反映该时段最高显存压力。' },
  ];
}
