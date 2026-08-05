export function formatAverageUserCount(value) {
  return Number.isFinite(value) ? String(Math.ceil(value)) : '暂无有效样本';
}
