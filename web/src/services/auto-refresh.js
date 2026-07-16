const MAX_AUTO_REFRESH_RANGE_MS = 24 * 60 * 60 * 1000;
const CURRENT_END_GRACE_MS = 5 * 60 * 1000;

export function shouldAutoRefresh(rangeStart, rangeEnd, now = Date.now()) {
  const start = new Date(rangeStart).getTime();
  const end = new Date(rangeEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  return end <= now
    && now - end <= CURRENT_END_GRACE_MS
    && end - start <= MAX_AUTO_REFRESH_RANGE_MS;
}
