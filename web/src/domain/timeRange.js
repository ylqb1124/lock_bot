export const BUCKET_SECONDS = 5 * 60;

export const QUICK_RANGES = [
  { label: '近 5 分钟', minutes: 5 },
  { label: '近 30 分钟', minutes: 30 },
  { label: '近 1 小时', minutes: 60 },
  { label: '近 6 小时', minutes: 360 },
  { label: '近 24 小时', minutes: 1440 },
  { label: '近 3 天', minutes: 4320 },
  { label: '近 7 天', minutes: 10080 },
];

export function floorToBucket(date = new Date()) {
  return new Date(Math.floor(date.getTime() / (BUCKET_SECONDS * 1000)) * BUCKET_SECONDS * 1000);
}

export function buildBuckets(start, end) {
  const buckets = [];
  for (let timestamp = floorToBucket(start).getTime(); timestamp <= end.getTime(); timestamp += BUCKET_SECONDS * 1000) {
    buckets.push(Math.floor(timestamp / 1000));
  }
  return buckets;
}

export function normalizeRange(start, end) {
  const normalizedStart = floorToBucket(start);
  const normalizedEnd = floorToBucket(end);
  if (normalizedStart > normalizedEnd) throw new Error('开始时间不能晚于结束时间');
  return { start: normalizedStart, end: normalizedEnd };
}

export function rangeForMinutes(minutes, now = new Date()) {
  const end = floorToBucket(now);
  return { start: new Date(end.getTime() - minutes * 60 * 1000), end };
}

export function enumerateDates(start, end) {
  const dates = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    dates.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatMonqueryDateTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

export function toDatetimeLocalValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function formatRange(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
