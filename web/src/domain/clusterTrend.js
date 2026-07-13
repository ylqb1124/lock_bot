import { BUCKET_SECONDS } from './timeRange.js';

const CARD_COUNT = 8;

export function normalizeMonqueryEntries(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.Data)) return response.Data;
  return [];
}

function parsePointTimestamp(point) {
  const value = Array.isArray(point)
    ? point[0]
    : point?.timestamp ?? point?.time ?? point?.Timestamp;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
}

function parsePointValue(point) {
  const value = Array.isArray(point)
    ? point[1]
    : point?.value ?? point?.Value;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bucketTimestamp(timestamp) {
  return Math.floor(timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
}

export function aggregateMetric(entries, itemName, buckets) {
  const expected = new Set(buckets);
  const sums = new Map();
  const counts = new Map();
  for (const entry of normalizeMonqueryEntries(entries)) {
    const points = entry?.Items?.[itemName] || entry?.items?.[itemName] || [];
    for (const point of points) {
      const timestamp = parsePointTimestamp(point);
      const value = parsePointValue(point);
      if (timestamp === null || value === null) continue;
      const bucket = bucketTimestamp(timestamp);
      if (!expected.has(bucket)) continue;
      sums.set(bucket, (sums.get(bucket) || 0) + value);
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    }
  }
  return buckets.map(bucket => counts.has(bucket) ? sums.get(bucket) / counts.get(bucket) : null);
}

function parseOccupancyTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function recordNodeName(value) {
  const normalized = String(value || '').toLowerCase();
  const node = normalized.match(/(?:gpu-)?node-?(\d+)/);
  if (node) return `node${Number(node[1])}`;
  const bdc = normalized.match(/bdc-?(\d+)/);
  return bdc ? `bdc${Number(bdc[1])}` : null;
}

function recordCardIds(occupation) {
  const device = Number(occupation?.dev_id ?? occupation?.device_id ?? occupation?.card_id);
  return Number.isInteger(device) && device >= 0 && device < CARD_COUNT
    ? [device]
    : Array.from({ length: CARD_COUNT }, (_, index) => index);
}

export function occupancyValues(buckets, occupancyRecords, nodes) {
  const totalCards = nodes.length * CARD_COUNT;
  const lockedByBucket = buckets.map(() => new Set());
  if (!totalCards) return lockedByBucket.map(() => 0);
  const nodeIndices = new Map(nodes.map((node, index) => [node.name, index]));
  for (const occupation of occupancyRecords || []) {
    const nodeIndex = nodeIndices.get(recordNodeName(occupation.node_key ?? occupation.node ?? occupation.node_name));
    const start = parseOccupancyTime(occupation.start_time ?? occupation.start);
    const rawEnd = parseOccupancyTime(occupation.end_time ?? occupation.end);
    const end = rawEnd ?? (start === null ? null : start + Number(occupation.duration_seconds ?? occupation.duration ?? 0));
    if (nodeIndex === undefined || start === null || !Number.isFinite(end) || end <= start) continue;
    const cards = recordCardIds(occupation);
    for (let index = 0; index < buckets.length; index += 1) {
      const bucketStart = buckets[index];
      if (bucketStart >= end || bucketStart + BUCKET_SECONDS <= start) continue;
      for (const card of cards) lockedByBucket[index].add(nodeIndex * CARD_COUNT + card);
    }
  }
  return lockedByBucket.map(locked => locked.size / totalCards * 100);
}

export function lockedCardsFromNodes(nodes) {
  return nodes.reduce((total, node) => total + (node.cardHasActiveLock || []).filter(Boolean).length, 0);
}

export function replaceLiveBucket(values, buckets, liveLockedCards, totalCards, now = Date.now()) {
  if (!totalCards) return values;
  const current = Math.floor(now / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
  const index = buckets.indexOf(current);
  if (index >= 0) values[index] = Math.min(100, liveLockedCards / totalCards * 100);
  return values;
}

export function summarize(values) {
  const populated = values.filter(Number.isFinite);
  if (!populated.length) return { current: null, average: null, peak: null };
  return {
    current: populated.at(-1),
    average: populated.reduce((sum, value) => sum + value, 0) / populated.length,
    peak: Math.max(...populated),
  };
}
