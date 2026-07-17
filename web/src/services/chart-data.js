export function hasFiniteSamples(values) {
  return values.some(Number.isFinite);
}

export function nearestFiniteIndex(values, targetIndex) {
  if (!values.length) return -1;
  const target = Math.max(0, Math.min(values.length - 1, Math.round(targetIndex)));
  for (let distance = 0; distance < values.length; distance += 1) {
    const before = target - distance;
    if (before >= 0 && Number.isFinite(values[before])) return before;
    const after = target + distance;
    if (after < values.length && Number.isFinite(values[after])) return after;
  }
  return -1;
}

export function resolveYAxis(values, defaultMax, defaultTicks, ceiling = Infinity) {
  const peak = values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, -Infinity);
  if (!Number.isFinite(peak) || peak <= defaultMax) return { yMax: defaultMax, ticks: defaultTicks };

  const step = defaultTicks.length > 1 ? defaultTicks[1] - defaultTicks[0] : defaultMax / 4;
  const expandedMax = Math.ceil((peak * 1.1) / step) * step;
  const yMax = Math.max(defaultMax, Math.min(expandedMax, ceiling));
  return {
    yMax,
    ticks: Array.from({ length: Math.floor(yMax / step) + 1 }, (_, index) => index * step),
  };
}
