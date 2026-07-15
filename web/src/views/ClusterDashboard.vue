<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchCachedClusterTrend, fetchLockBotList, fetchLockBotState, fetchMonqueryUtilization } from '../services/api.js';
import { adaptNodeData } from '../services/adapter.js';
import '../cluster-dashboard.css';

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(['expired']);

const CARD_COUNT = 8;
const AVG_MARGIN = { top: 10, right: 16, bottom: 20, left: 48 };
const XPU_TICKS = [0, 5, 10, 15, 20, 25, 30, 35];
const MEM_TICKS = [0, 10, 20, 30, 40, 50, 60, 70];
const QUICK_RANGES = [
  { label: '最近 15 分钟', minutes: 15 },
  { label: '最近 30 分钟', minutes: 30 }, { label: '最近 1 小时', minutes: 60 },
  { label: '最近 3 小时', minutes: 180 }, { label: '最近 6 小时', minutes: 360 },
  { label: '最近 12 小时', minutes: 720 }, { label: '最近 24 小时', minutes: 1440 },
  { label: '最近 2 天', minutes: 2880 }, { label: '最近 7 天', minutes: 10080 },
  { label: '最近 30 天', minutes: 43200 }, { label: '最近 90 天', minutes: 129600 },
];
const X_AXIS_TICK_INTERVALS = [
  { maxMinutes: 60, seconds: 150 },
  { maxMinutes: 180, seconds: 300 },
  { maxMinutes: 360, seconds: 600 },
  { maxMinutes: 720, seconds: 1200 },
  { maxMinutes: 1440, seconds: 3000 },
  { maxMinutes: 2880, seconds: 6000 },
  { maxMinutes: 10080, seconds: 18000 },
  { maxMinutes: 43200, seconds: 72000 },
  { maxMinutes: Infinity, seconds: 216000 },
];

const rangeStart = ref(null);
const rangeEnd = ref(null);
const quickRangeMinutes = ref(180);
const trendDataAsOf = ref(null);
const lastRefreshAt = ref(null);
const draftStart = ref('');
const draftEnd = ref('');
const quickSearch = ref('');
const panelCollapsed = ref(true);
const meanVisible = ref(true);
const openTip = ref('');
const loading = ref(true);
const error = ref('');
const toast = ref('');
const nodes = ref([]);
const bots = ref([]);
const series = ref({ times: [], xpu: [], memory: [], lock: [] });

const xpuCanvas = ref(null);
const memoryCanvas = ref(null);
const lockCanvas = ref(null);
const xpuTooltip = ref(null);
const memoryTooltip = ref(null);
const lockTooltip = ref(null);
let requestSequence = 0;
let refreshTimer;
let toastTimer;
let resizeHandler;
const listenerCleanup = [];

const filteredQuickRanges = computed(() => {
  const filter = quickSearch.value.trim().toLowerCase();
  return QUICK_RANGES.filter(range => !filter || range.label.toLowerCase().includes(filter));
});
const activeMinutes = computed(() => rangeStart.value && rangeEnd.value
  ? Math.round((rangeEnd.value - rangeStart.value) / 60_000)
  : null);
const timeLabel = computed(() => {
  const active = QUICK_RANGES.find(range => range.minutes === activeMinutes.value);
  return active?.label || '自定义时间范围';
});
function formatClock(value) {
  if (!value) return '--:--';
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const dataAsOf = computed(() => trendDataAsOf.value
  ? `数据统计截止 ${formatClock(trendDataAsOf.value * 1000)}`
  : '数据统计截止 --:--');
const refreshStatus = computed(() => lastRefreshAt.value ? `已刷新 ${formatClock(lastRefreshAt.value)}` : '尚未刷新');
const rangeSummary = computed(() => rangeStart.value && rangeEnd.value
  ? `${formatDateTimeLabel(rangeStart.value)} 至 ${formatDateTimeLabel(rangeEnd.value)}`
  : '');
const stats = computed(() => buildStats(nodes.value, series.value.xpu, series.value.memory));

function floorToFiveMinutes(value) {
  const date = new Date(value);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() - date.getMinutes() % 5);
  return date;
}

function normalizeRange(start, end) {
  const queryEnd = floorToFiveMinutes(end || new Date());
  let queryStart = floorToFiveMinutes(start || queryEnd);
  if (queryStart >= queryEnd) queryStart = new Date(queryEnd.getTime() - 5 * 60_000);
  return { queryStart, queryEnd };
}

function formatMonqueryDateTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function formatDateTimeLabel(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function toDatetimeLocalValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildBuckets(start, end) {
  const buckets = [];
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 5 * 60_000) buckets.push(Math.floor(timestamp / 1000));
  return buckets;
}

function xAxisTickSeconds(times) {
  if (times.length < 2) return 150;
  const rangeMinutes = (times[times.length - 1] - times[0]) / 60;
  return X_AXIS_TICK_INTERVALS.find(interval => rangeMinutes <= interval.maxMinutes).seconds;
}

function buildXAxisTicks(times) {
  if (times.length < 2) return times;
  const start = times[0];
  const end = times[times.length - 1];
  const interval = xAxisTickSeconds(times);
  const ticks = [];
  for (let timestamp = start; timestamp <= end; timestamp += interval) ticks.push(timestamp);
  if (ticks[ticks.length - 1] !== end) ticks.push(end);
  return ticks;
}

function normalizeEntries(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.Data)) return response.Data;
  return [];
}

function processMonqueryData(response, times) {
  const byTime = new Map();
  const addPoint = (point, metric) => {
    const rawTimestamp = Number(point?.Timestamp ?? point?.timestamp ?? point?.time);
    const value = Number(point?.Value ?? point?.value);
    if (!Number.isFinite(rawTimestamp) || !Number.isFinite(value)) return;
    const timestamp = rawTimestamp > 1e12 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    const bucket = byTime.get(timestamp) || { xpuSum: 0, xpuCount: 0, memorySum: 0, memoryCount: 0 };
    if (metric === 'xpu') { bucket.xpuSum += value; bucket.xpuCount += 1; }
    else { bucket.memorySum += value; bucket.memoryCount += 1; }
    byTime.set(timestamp, bucket);
  };

  for (const entry of normalizeEntries(response)) {
    const items = entry?.Items || entry?.items || {};
    for (const point of items.XPU_AVERAGE_UTILIZATION || items.xpu_average_utilization || []) addPoint(point, 'xpu');
    for (let card = 0; card < CARD_COUNT; card += 1) {
      for (const point of items[`XPU${card}_MEM_UTILIZATION`] || items[`xpu${card}_mem_utilization`] || []) addPoint(point, 'memory');
    }
  }

  return {
    times,
    xpu: times.map(timestamp => {
      const point = byTime.get(timestamp);
      return point?.xpuCount ? point.xpuSum / point.xpuCount : null;
    }),
    memory: times.map(timestamp => {
      const point = byTime.get(timestamp);
      return point?.memoryCount ? point.memorySum / point.memoryCount : null;
    }),
  };
}

function smooth(values, windowSize = 2) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    const start = Math.max(0, index - windowSize + 1);
    const windowValues = values.slice(start, index + 1).filter(Number.isFinite);
    return windowValues.reduce((sum, item) => sum + item, 0) / windowValues.length;
  });
}

function displayBucketSize(times) {
  const minutes = times.length > 1 ? (times.at(-1) - times[0]) / 60 : 0;
  if (minutes <= 2 * 24 * 60) return 1;
  if (minutes <= 7 * 24 * 60) return 3;
  if (minutes <= 30 * 24 * 60) return 24;
  return 72;
}

function aggregateSeries(times, xpu, memory, lock) {
  const bucketSize = displayBucketSize(times);
  if (bucketSize === 1) return { times, xpu: smooth(xpu), memory: smooth(memory), lock };
  const aggregated = { times: [], xpu: [], memory: [], lock: [] };
  for (let start = 0; start < times.length; start += bucketSize) {
    const end = Math.min(times.length, start + bucketSize);
    const averageRange = values => average(values.slice(start, end));
    aggregated.times.push(times[start]);
    aggregated.xpu.push(averageRange(xpu));
    aggregated.memory.push(averageRange(memory));
    aggregated.lock.push(averageRange(lock));
  }
  return aggregated;
}

function nodeName(value) {
  const normalized = String(value || '');
  const node = normalized.match(/^(?:gpu-)?node-?(\d+)$/i);
  if (node) return `node${Number(node[1])}`;
  const bdc = normalized.match(/^bdc-?(\d+)$/i);
  return bdc ? `bdc${Number(bdc[1])}` : null;
}

function recordCards(record) {
  const card = Number(record?.dev_id ?? record?.device_id ?? record?.card_id);
  return Number.isInteger(card) && card >= 0 && card < CARD_COUNT
    ? [card]
    : Array.from({ length: CARD_COUNT }, (_, index) => index);
}

function toSeconds(value) {
  if (value == null || value === '') return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  const text = String(value).trim();
  const timestamp = /[Zz]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

function firstNodeStates(stateResults) {
  const states = new Map();
  for (const result of stateResults) {
    if (!result) continue;
    for (const [name, state] of Object.entries(result.state || {})) {
      const normalized = nodeName(name);
      if (normalized && !states.has(normalized)) states.set(normalized, { state, type: result.type });
    }
  }
  return states;
}

function liveLockIntervals(stateResults, todayBoundary, now) {
  const intervals = [];
  const boundary = Math.floor(todayBoundary.getTime() / 1000);
  const current = Math.floor(now.getTime() / 1000);
  for (const [name, result] of firstNodeStates(stateResults)) {
    const devices = result.type === 'DEVICE' && Array.isArray(result.state)
      ? result.state
      : [{ ...result.state, dev_id: null }];
    for (const device of devices) {
      if (device?.status === 'idle' || !device?.current_users?.length) continue;
      const deviceId = Number(device.dev_id);
      const cards = device.dev_id != null && Number.isInteger(deviceId) && deviceId >= 0 && deviceId < CARD_COUNT
        ? [deviceId]
        : Array.from({ length: CARD_COUNT }, (_, index) => index);
      for (const user of device.current_users) {
        const rawStart = toSeconds(user.start_time);
        const rawEnd = rawStart + Number(user.duration || 0);
        const start = Math.max(rawStart, boundary);
        const end = Math.min(rawEnd, current);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ node: name, cards, start, end });
      }
    }
  }
  return intervals;
}

function lockUtilization(times, occupancyRecords, liveIntervals, stateNodes, liveBoundary, now) {
  const totalCards = stateNodes.length * CARD_COUNT;
  if (!totalCards || !times.length) return [];
  const locked = times.map(() => new Set());
  const rangeStart = times[0];
  const rangeEnd = times.at(-1) + 300;
  const liveBoundarySeconds = Math.floor(liveBoundary.getTime() / 1000);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const nodeIndices = new Map(stateNodes.map((node, index) => [node.name, index]));

  for (const record of occupancyRecords) {
    const index = nodeIndices.get(nodeName(record.node_key ?? record.node ?? record.node_name));
    const start = toSeconds(record.start_time ?? record.start);
    const knownEnd = toSeconds(record.end_time ?? record.end);
    const recordedEnd = Number.isFinite(knownEnd) ? knownEnd : start + Number(record.duration_seconds ?? record.duration ?? 0);
    const end = recordedEnd > nowSeconds ? Math.min(recordedEnd, liveBoundarySeconds) : recordedEnd;
    if (index === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end < rangeStart || start >= rangeEnd) continue;
    const first = Math.max(0, Math.floor((start - rangeStart) / 300));
    const last = Math.min(times.length - 1, Math.floor((Math.max(start, end - 1) - rangeStart) / 300));
    for (let bucket = first; bucket <= last; bucket += 1) {
      for (const card of recordCards(record)) locked[bucket].add(index * CARD_COUNT + card);
    }
  }

  for (const interval of liveIntervals) {
    const index = nodeIndices.get(interval.node);
    if (index === undefined || interval.end <= rangeStart || interval.start >= rangeEnd) continue;
    const first = Math.max(0, Math.floor((interval.start - rangeStart) / 300));
    const last = Math.min(times.length - 1, Math.ceil((interval.end - rangeStart) / 300) - 1);
    for (let bucket = first; bucket <= last; bucket += 1) {
      for (const card of interval.cards) locked[bucket].add(index * CARD_COUNT + card);
    }
  }
  return locked.map(cards => cards.size / totalCards * 100);
}

function currentSlot() {
  const now = new Date();
  return now.getHours() * 12 + Math.floor(now.getMinutes() / 5);
}

function botType(bot) {
  return String(bot.bot_type || bot.type || 'NODE').toUpperCase();
}

function sortNodes(list) {
  return [...list].sort((first, second) => {
    const parse = name => name.startsWith('bdc') ? { prefix: 'bdc', id: Number(name.slice(3)) } : { prefix: 'node', id: Number(name.slice(4)) };
    const a = parse(first.name); const b = parse(second.name);
    if (a.prefix !== b.prefix) return a.prefix === 'node' ? -1 : 1;
    return a.id - b.id;
  });
}

function adaptStates(stateResults, monqueryData) {
  const firstStates = new Map();
  for (const result of stateResults) {
    if (!result) continue;
    for (const [name, state] of Object.entries(result.state || {})) {
      if (!firstStates.has(name)) firstStates.set(name, { state, type: result.type });
    }
  }
  const deviceState = {}; const nodeState = {};
  for (const [name, result] of firstStates) {
    if (result.type === 'DEVICE') deviceState[name] = result.state;
    else nodeState[name] = result.state;
  }
  return sortNodes([
    ...adaptNodeData(deviceState, monqueryData, currentSlot(), 'DEVICE'),
    ...adaptNodeData(nodeState, monqueryData, currentSlot(), 'NODE'),
  ]);
}

function average(values) {
  const populated = values.filter(Number.isFinite);
  return populated.length ? populated.reduce((sum, value) => sum + value, 0) / populated.length : null;
}

function buildStats(currentNodes, xpu, memory) {
  const effectiveSlot = Math.max(0, currentSlot() - 1);
  let busyNodes = 0;
  let busyCards = 0;
  let lockedNodes = 0;
  let lockedCards = 0;
  for (const node of currentNodes) {
    if (node.status !== 'FREE') busyNodes += 1;
    if (node.hasActiveLock) lockedNodes += 1;
    for (let card = 0; card < CARD_COUNT; card += 1) {
      const xpuValue = node.cardUtils?.[card]?.[effectiveSlot] || 0;
      const memoryValue = node.cardMemUtils?.[card]?.[effectiveSlot] || 0;
      if (node.hasCardMonqueryData ? xpuValue >= 10 || memoryValue >= 10 : node.hasActiveLock) busyCards += 1;
      if (node.cardHasActiveLock?.[card]) lockedCards += 1;
    }
  }
  const totalCards = currentNodes.length * CARD_COUNT;
  const percent = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
  const pair = values => {
    const mean = average(values);
    const peak = values.filter(Number.isFinite).reduce((result, value) => Math.max(result, value), -Infinity);
    return mean === null || !Number.isFinite(peak) ? '--/--' : `${mean.toFixed(1)}%/${peak.toFixed(1)}%`;
  };
  return [
    { label: '总节点', value: String(currentNodes.length), tone: 'total' },
    { label: '总卡数', value: String(totalCards), tone: 'total' },
    { label: 'LOCKED 节点', value: String(lockedNodes), tone: 'locked' },
    { label: 'BUSY节点', value: String(busyNodes), tone: 'busy', tip: '当前存在实际计算任务的节点数。节点的 XPU 或显存利用率达到 10% 及以上时计入。' },
    { label: 'BUSY卡数', value: String(busyCards), tone: 'busy', tip: '当前存在实际计算任务的 XPU 卡数。单卡的 XPU 或显存利用率达到 10% 及以上时计入。' },
    { label: '节点利用率', value: percent(totalCards ? lockedCards / totalCards * 100 : null), tone: 'locked', tip: '当前已通过 Lock Bot 锁定的 XPU 卡占全集群总卡数的比例，反映资源已分配给任务的规模。' },
    { label: 'XPU平均利用率/峰值利用率', value: pair(xpu), tone: 'xpu-avg', tip: '平均利用率反映所选时段内集群整体计算负载；峰值利用率反映该时段最高负载水平。' },
    { label: '显存平均利用率/峰值利用率', value: pair(memory), tone: 'mem-avg', tip: '平均利用率反映所选时段内集群整体显存压力；峰值利用率反映该时段最高显存压力。' },
  ];
}

function setRange(start, end) {
  rangeStart.value = start;
  rangeEnd.value = end;
  draftStart.value = toDatetimeLocalValue(start);
  draftEnd.value = toDatetimeLocalValue(end);
}

function setQuickRange(minutes) {
  quickRangeMinutes.value = minutes;
  const end = floorToFiveMinutes(new Date());
  setRange(new Date(end.getTime() - minutes * 60_000), end);
}

function refreshData() {
  if (quickRangeMinutes.value) setQuickRange(quickRangeMinutes.value);
  load();
}

function resetRange() {
  setQuickRange(3 * 60);
  load();
}

function applyRange() {
  const start = new Date(draftStart.value);
  const end = new Date(draftEnd.value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    showToast('请选择有效的开始和结束时间');
    return;
  }
  setRange(start, end);
  quickRangeMinutes.value = null;
  load();
}

async function copyRange() {
  const text = rangeSummary.value;
  try {
    await navigator.clipboard.writeText(text);
    showToast('时间范围已复制');
  } catch {
    showToast(text);
  }
}

function showToast(message) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 5_000);
}

async function load() {
  if (!rangeStart.value || !rangeEnd.value) return;
  const sequence = ++requestSequence;
  loading.value = true;
  error.value = '';
  try {
    if (!bots.value.length) bots.value = await fetchLockBotList(props.token);
    const { queryStart, queryEnd } = normalizeRange(rangeStart.value, rangeEnd.value);
    const today = new Date();
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const statePromise = Promise.all(bots.value.map(async bot => {
      try {
        return { bot, type: botType(bot), state: await fetchLockBotState(bot.id, props.token) };
      } catch {
        return null;
      }
    }));
    const currentPromise = fetchMonqueryUtilization(formatMonqueryDateTime(todayStart), formatMonqueryDateTime(today));
    const trendPromise = fetchCachedClusterTrend(queryStart, queryEnd, props.token);
    const [stateResults, currentData, trendData] = await Promise.all([statePromise, currentPromise, trendPromise]);
    if (sequence !== requestSequence) return;
    const currentNodes = adaptStates(stateResults, currentData);
    trendDataAsOf.value = trendData.dataAsOf;
    lastRefreshAt.value = Date.now();
    const rawTrend = trendData;
    nodes.value = currentNodes;
    series.value = aggregateSeries(
      rawTrend.times,
      rawTrend.xpu,
      rawTrend.memory,
      rawTrend.lock,
    );
    await nextTick();
    drawAllCharts();
  } catch (caught) {
    if (sequence !== requestSequence) return;
    if (/401|403/.test(String(caught?.message))) emit('expired');
    error.value = caught?.message || '加载全集群趋势数据失败';
    await nextTick();
    drawAllCharts();
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function drawAllCharts() {
  drawChart(xpuCanvas.value, series.value.xpu, '#7c3aed', 35, XPU_TICKS, 'XPU 利用率');
  drawChart(memoryCanvas.value, series.value.memory, '#ea580c', 70, MEM_TICKS, '显存利用率');
  drawChart(lockCanvas.value, series.value.lock, '#d97706', 100, [0, 25, 50, 75, 100], '节点利用率');
}

function drawChart(canvas, values, color, yMax, ticks, label) {
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const width = wrap.clientWidth || wrap.offsetWidth || 600;
  const height = wrap.clientHeight || wrap.offsetHeight || 310;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const count = values.length;
  const plotWidth = width - AVG_MARGIN.left - AVG_MARGIN.right;
  const plotHeight = height - AVG_MARGIN.top - AVG_MARGIN.bottom;
  const xFor = index => AVG_MARGIN.left + index / Math.max(1, count - 1) * plotWidth;
  const yFor = value => AVG_MARGIN.top + (1 - Math.max(0, Math.min(yMax, value || 0)) / yMax) * plotHeight;

  context.save();
  context.strokeStyle = '#94a3b8'; context.lineWidth = .8; context.setLineDash([4, 4]);
  ticks.forEach(value => { const y = yFor(value); context.beginPath(); context.moveTo(AVG_MARGIN.left, y); context.lineTo(width - AVG_MARGIN.right, y); context.stroke(); });
  const xTicks = buildXAxisTicks(series.value.times);
  const rangeStart = series.value.times[0];
  const rangeEnd = series.value.times[series.value.times.length - 1];
  const rangeSeconds = Math.max(1, rangeEnd - rangeStart);
  xTicks.forEach(timestamp => {
    const x = AVG_MARGIN.left + (timestamp - rangeStart) / rangeSeconds * plotWidth;
    context.beginPath(); context.moveTo(x, AVG_MARGIN.top); context.lineTo(x, AVG_MARGIN.top + plotHeight); context.stroke();
  });
  context.setLineDash([]); context.restore();

  context.save(); context.fillStyle = '#000'; context.font = '11px "SF Mono","JetBrains Mono",monospace'; context.textAlign = 'right'; context.textBaseline = 'middle';
  ticks.forEach(value => context.fillText(`${value}%`, AVG_MARGIN.left - 8, yFor(value))); context.restore();
  context.save(); context.strokeStyle = '#000'; context.lineWidth = 2; context.beginPath(); context.moveTo(AVG_MARGIN.left, AVG_MARGIN.top); context.lineTo(AVG_MARGIN.left, AVG_MARGIN.top + plotHeight); context.stroke(); context.beginPath(); context.moveTo(AVG_MARGIN.left, AVG_MARGIN.top + plotHeight); context.lineTo(width - AVG_MARGIN.right, AVG_MARGIN.top + plotHeight); context.stroke(); context.restore();

  context.save(); context.fillStyle = '#000'; context.font = '11px "SF Mono","JetBrains Mono",monospace'; context.textAlign = 'center'; context.textBaseline = 'top';
  const tickInterval = xAxisTickSeconds(series.value.times);
  const maxLabels = Math.max(2, Math.floor(plotWidth / 145));
  const labelEvery = Math.max(1, Math.ceil(xTicks.length / maxLabels));
  const sameDay = series.value.times.length && new Date(rangeStart * 1000).toDateString() === new Date(rangeEnd * 1000).toDateString();
  const labelCandidates = xTicks.flatMap((timestamp, index) => {
    if (index % labelEvery !== 0 && index !== xTicks.length - 1) return [];
    const date = new Date(timestamp * 1000);
    const seconds = tickInterval < 300 ? `:${String(date.getSeconds()).padStart(2, '0')}` : '';
    const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}${seconds}`;
    const text = sameDay ? clock : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock}`;
    const x = AVG_MARGIN.left + (timestamp - rangeStart) / rangeSeconds * plotWidth;
    return [{ text, x, width: context.measureText(text).width }];
  });
  const lastLabel = labelCandidates.at(-1);
  const lastLabelLeft = lastLabel ? width - AVG_MARGIN.right - lastLabel.width : Infinity;
  let occupiedRight = AVG_MARGIN.left;
  labelCandidates.forEach((label, index) => {
    const isFirst = index === 0;
    const isLast = index === labelCandidates.length - 1;
    const left = isFirst ? AVG_MARGIN.left : isLast ? lastLabelLeft : label.x - label.width / 2;
    const right = left + label.width;
    if (!isFirst && !isLast && (left < occupiedRight + 12 || right > lastLabelLeft - 12)) return;
    context.textAlign = isFirst ? 'left' : isLast ? 'right' : 'center';
    context.fillText(label.text, isFirst ? AVG_MARGIN.left : isLast ? width - AVG_MARGIN.right : label.x, AVG_MARGIN.top + plotHeight + 5);
    occupiedRight = right;
  });
  context.restore();

  if (!count) {
    context.save(); context.fillStyle = '#94a3b8'; context.font = '600 14px -apple-system,"PingFang SC",sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('暂无数据', AVG_MARGIN.left + plotWidth / 2, AVG_MARGIN.top + plotHeight / 2); context.restore();
    storeCanvasMeta(canvas, values, color, yMax, label, null, null, width, height, plotWidth, plotHeight);
    snapshot(canvas);
    return;
  }

  context.save(); context.beginPath(); context.rect(AVG_MARGIN.left, AVG_MARGIN.top, plotWidth, plotHeight); context.clip();
  const gradient = context.createLinearGradient(0, AVG_MARGIN.top, 0, AVG_MARGIN.top + plotHeight); gradient.addColorStop(0, `${color}26`); gradient.addColorStop(1, `${color}00`);
  const segments = [];
  let segment = [];
  values.forEach((value, index) => {
    if (Number.isFinite(value)) segment.push({ value, index });
    else if (segment.length) { segments.push(segment); segment = []; }
  });
  if (segment.length) segments.push(segment);
  segments.forEach(points => {
    context.beginPath();
    points.forEach(({ value, index }, pointIndex) => pointIndex ? context.lineTo(xFor(index), yFor(value)) : context.moveTo(xFor(index), yFor(value)));
    context.lineTo(xFor(points.at(-1).index), AVG_MARGIN.top + plotHeight);
    context.lineTo(xFor(points[0].index), AVG_MARGIN.top + plotHeight);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
  });
  context.strokeStyle = color; context.lineWidth = 2;
  segments.forEach(points => {
    context.beginPath();
    points.forEach(({ value, index }, pointIndex) => pointIndex ? context.lineTo(xFor(index), yFor(value)) : context.moveTo(xFor(index), yFor(value)));
    context.stroke();
  });
  const mean = average(values); const peak = values.reduce((result, value, index) => Number.isFinite(value) && (!result || value > result.value) ? { value, index } : result, null);
  if (meanVisible.value && mean !== null) { const y = yFor(mean); context.strokeStyle = '#dc2626'; context.lineWidth = 1; context.beginPath(); context.moveTo(AVG_MARGIN.left, y); context.lineTo(width - AVG_MARGIN.right, y); context.stroke(); context.fillStyle = '#dc2626'; context.font = '700 11px "SF Mono","JetBrains Mono",monospace'; context.textAlign = 'right'; context.textBaseline = 'bottom'; context.fillText(`均值 ${mean.toFixed(1)}%`, width - AVG_MARGIN.right - 4, y - 4); }
  if (peak) { const x = xFor(peak.index); const y = yFor(peak.value); const textY = y < AVG_MARGIN.top + 16 ? y + 18 : y - 10; context.fillStyle = color; context.font = '700 13px "SF Mono","JetBrains Mono",monospace'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.lineWidth = 4; context.strokeStyle = 'rgba(255,255,255,.9)'; context.strokeText('*', x, y); context.fillText('*', x, y); context.font = '700 10px "SF Mono","JetBrains Mono",monospace'; const textX = Math.max(AVG_MARGIN.left + 42, Math.min(width - AVG_MARGIN.right - 42, x)); context.strokeText(`峰值 ${peak.value.toFixed(1)}%`, textX, textY); context.fillText(`峰值 ${peak.value.toFixed(1)}%`, textX, textY); }
  context.restore();

  const legendX = AVG_MARGIN.left + 10; const legendY = AVG_MARGIN.top + 10; const legendHeight = meanVisible.value ? 70 : 52;
  context.save(); context.fillStyle = 'rgba(255,255,255,.92)'; context.strokeStyle = 'rgba(148,163,184,.35)'; context.lineWidth = 1; context.beginPath(); context.roundRect(legendX, legendY, 132, legendHeight, 4); context.fill(); context.stroke();
  [{ label: '当前范围', color, lineWidth: 2 }, ...(meanVisible.value && mean !== null ? [{ label: '范围均值', color: '#dc2626', lineWidth: 1 }] : []), ...(peak ? [{ label: '峰值', color, star: true }] : [])].forEach((item, index) => { const y = legendY + 10 + index * 14; if (item.star) { context.fillStyle = item.color; context.font = '700 11px "SF Mono","JetBrains Mono",monospace'; context.textAlign = 'center'; context.fillText('*', legendX + 16, y); } else { context.strokeStyle = item.color; context.lineWidth = item.lineWidth; context.beginPath(); context.moveTo(legendX + 6, y); context.lineTo(legendX + 26, y); context.stroke(); } context.fillStyle = '#475569'; context.font = '10px -apple-system,"PingFang SC",sans-serif'; context.textAlign = 'left'; context.textBaseline = 'middle'; context.fillText(item.label, legendX + 34, y); }); context.restore();
  storeCanvasMeta(canvas, values, color, yMax, label, meanVisible.value ? mean : null, peak, width, height, plotWidth, plotHeight);
  snapshot(canvas);
}

function storeCanvasMeta(canvas, values, color, yMax, label, mean, peak, width, height, plotWidth, plotHeight) {
  canvas._clusterMeta = { values, color, yMax, label, mean, peak, width, height, plotWidth, plotHeight, margins: AVG_MARGIN };
}

function snapshot(canvas) {
  const image = new Image(); image.src = canvas.toDataURL(); canvas._clusterSnapshot = image;
}

function restoreSnapshot(canvas) {
  if (!canvas?._clusterSnapshot) return;
  const context = canvas.getContext('2d'); context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(canvas._clusterSnapshot, 0, 0); context.restore();
}

function bindHover(canvas, tooltipElement) {
  if (!canvas || !tooltipElement) return;
  const move = event => {
    const meta = canvas._clusterMeta;
    if (!meta?.values?.length) return;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const plotX = x - meta.margins.left;
    if (plotX < 0 || plotX > meta.plotWidth) { tooltipElement.style.display = 'none'; restoreSnapshot(canvas); return; }
    const index = Math.max(0, Math.min(meta.values.length - 1, Math.round(plotX / meta.plotWidth * (meta.values.length - 1))));
    const crosshairX = meta.margins.left + index / Math.max(1, meta.values.length - 1) * meta.plotWidth;
    restoreSnapshot(canvas);
    const context = canvas.getContext('2d'); context.save(); context.beginPath(); context.rect(meta.margins.left, meta.margins.top, meta.plotWidth, meta.plotHeight); context.clip(); context.strokeStyle = 'rgba(100,116,139,.5)'; context.lineWidth = 1; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(crosshairX, meta.margins.top); context.lineTo(crosshairX, meta.margins.top + meta.plotHeight); context.stroke(); context.setLineDash([]); const value = meta.values[index]; const y = meta.margins.top + (1 - value / meta.yMax) * meta.plotHeight; context.beginPath(); context.arc(crosshairX, y, 4, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = meta.color; context.lineWidth = 2; context.stroke(); context.restore();
    const date = new Date(series.value.times[index] * 1000);
    tooltipElement.innerHTML = `<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}</div><div style="display:grid;grid-template-columns:12px 48px 48px;align-items:center;gap:6px;margin:1px 0;"><span style="width:7px;height:7px;border-radius:50%;background:${meta.color};justify-self:center;"></span><span style="font-size:10px;color:#cbd5e1;">${meta.label}</span><span style="font-weight:600;color:${meta.color};text-align:right;font-variant-numeric:tabular-nums;">${value.toFixed(1)}%</span></div>${meta.mean === null ? '' : `<div style="display:grid;grid-template-columns:12px 48px 48px;align-items:center;gap:6px;margin:1px 0;"><span style="width:12px;height:2px;background:#dc2626;justify-self:center;"></span><span style="font-size:10px;color:#cbd5e1;">范围均值</span><span style="font-weight:600;color:#dc2626;text-align:right;font-variant-numeric:tabular-nums;">${meta.mean.toFixed(1)}%</span></div>`}`;
    tooltipElement.style.display = 'block';
    const gap = 10;
    const edge = 6;
    const tooltipWidth = Math.min(tooltipElement.offsetWidth, Math.max(0, bounds.width - edge * 2));
    const tooltipHeight = Math.min(tooltipElement.offsetHeight, Math.max(0, bounds.height - edge * 2));
    const preferredLeft = crosshairX + gap;
    const fallbackLeft = crosshairX - tooltipWidth - gap;
    const left = preferredLeft + tooltipWidth <= bounds.width - edge ? preferredLeft : fallbackLeft;
    const pointerY = event.clientY - bounds.top;
    tooltipElement.style.left = `${Math.max(edge, Math.min(left, bounds.width - tooltipWidth - edge))}px`;
    tooltipElement.style.top = `${Math.max(edge, Math.min(pointerY - tooltipHeight - gap, bounds.height - tooltipHeight - edge))}px`;
  };
  const leave = () => { tooltipElement.style.display = 'none'; restoreSnapshot(canvas); };
  canvas.addEventListener('mousemove', move); canvas.addEventListener('mouseleave', leave);
  listenerCleanup.push(() => { canvas.removeEventListener('mousemove', move); canvas.removeEventListener('mouseleave', leave); });
}

function closeTips(event) {
  if (!event.target.closest('.tip-icon')) openTip.value = '';
}

onMounted(async () => {
  setQuickRange(3 * 60);
  refreshTimer = window.setInterval(() => { if (!document.hidden) refreshData(); }, 60_000);
  resizeHandler = () => { if (series.value.xpu.length || series.value.lock.length) drawAllCharts(); };
  window.addEventListener('resize', resizeHandler);
  document.addEventListener('click', closeTips);
  bindHover(xpuCanvas.value, xpuTooltip.value);
  bindHover(memoryCanvas.value, memoryTooltip.value);
  bindHover(lockCanvas.value, lockTooltip.value);
  await load();
});

onBeforeUnmount(() => {
  requestSequence += 1;
  window.clearInterval(refreshTimer); window.clearTimeout(toastTimer);
  window.removeEventListener('resize', resizeHandler); document.removeEventListener('click', closeTips);
  listenerCleanup.splice(0).forEach(cleanup => cleanup());
});
</script>

<template>
  <main class="cluster-dashboard">
    <header class="cluster-page-header"><h1>开发机资源监控面板</h1></header>
    <section class="stats-bar" aria-label="全集群统计">
      <div v-for="row in [stats.slice(0, 4), stats.slice(4)]" :key="row[0].label" class="stats-bar-row">
        <article v-for="card in row" :key="card.label" class="stat-card" :class="card.tone">
          <div class="label">{{ card.label }}</div><div class="value" :class="[card.tone, { pct: card.value.includes('%') }]">{{ card.value }}</div>
          <button v-if="card.tip" type="button" class="tip-icon" aria-label="查看计算说明" @click.stop="openTip = openTip === card.label ? '' : card.label">?</button>
          <div v-if="card.tip" class="tip-popup" :class="{ show: openTip === card.label }">{{ card.tip }}</div>
        </article>
      </div>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>
    <section id="average-view">
      <div class="cluster-filter-head">
        <div class="gtp-trigger-bar">
          <span class="gtp-time-label">{{ timeLabel }}</span>
          <button type="button" class="gtp-zoom-btn" :title="panelCollapsed ? '展开筛选' : '收缩筛选'" :aria-label="panelCollapsed ? '展开时间筛选' : '收缩时间筛选'" aria-controls="cluster-range-panel" :aria-expanded="!panelCollapsed" @click="panelCollapsed = !panelCollapsed">{{ panelCollapsed ? '+' : '−' }}</button>
          <button type="button" class="gtp-refresh-btn" :disabled="loading" @click="refreshData()">{{ loading ? '正在加载…' : '⟲ 刷新' }}</button>
          <span class="data-as-of"><span class="data-as-of-dot" aria-hidden="true"></span><span>{{ dataAsOf }}</span><span class="refresh-status">{{ refreshStatus }}</span></span>
        </div>
      </div>
      <div id="cluster-range-panel" class="cluster-range-panel" :class="{ hidden: panelCollapsed }">
        <div class="cluster-range-grid">
          <div class="cluster-range-absolute">
            <div class="cluster-range-title">时间范围筛选</div>
            <div class="cluster-field"><label for="cluster-start-time">开始时间</label><input id="cluster-start-time" v-model="draftStart" type="datetime-local" step="1" /></div>
            <div class="cluster-field"><label for="cluster-end-time">结束时间</label><input id="cluster-end-time" v-model="draftEnd" type="datetime-local" step="1" /></div>
            <div class="cluster-range-actions"><button type="button" class="cluster-icon-btn" title="复制时间范围" @click="copyRange">复制区间</button><button type="button" class="cluster-icon-btn" title="重置为最近 3 小时" @click="resetRange">默认筛选</button><button type="button" class="cluster-apply-btn" :disabled="loading" @click="applyRange">筛选</button></div>
          </div>
          <div class="cluster-range-quick"><input v-model="quickSearch" class="cluster-quick-search" type="search" placeholder="搜索快捷时间" /><div class="cluster-quick-list"><button v-for="quick in filteredQuickRanges" :key="quick.minutes" type="button" class="cluster-quick-item" :class="{ active: activeMinutes === quick.minutes }" :disabled="loading" @click="setQuickRange(quick.minutes); load()">{{ quick.label }}</button></div></div>
        </div>
      </div>

      <section class="charts-row">
        <article class="chart-panel"><div class="chart-panel-head"><div class="chart-panel-title">XPU利用率趋势</div><button type="button" class="avg-mean-toggle" :class="{ active: meanVisible }" :aria-pressed="meanVisible" @click="meanVisible = !meanVisible; drawAllCharts()">均值线</button></div><div class="chart-wrap"><canvas ref="xpuCanvas"></canvas><div ref="xpuTooltip" class="chart-tooltip"></div></div></article>
        <article class="chart-panel"><div class="chart-panel-title">显存利用率趋势</div><div class="chart-wrap"><canvas ref="memoryCanvas"></canvas><div ref="memoryTooltip" class="chart-tooltip"></div></div></article>
        <article class="chart-panel"><div class="chart-panel-title chart-title-with-tip">节点利用率趋势<button type="button" class="tip-icon" aria-label="查看绘图规则" @click.stop="openTip = openTip === 'lock-chart' ? '' : 'lock-chart'">?</button><div class="tip-popup" :class="{ show: openTip === 'lock-chart' }"><div>展示所选时段内已锁定 XPU 卡占全集群总卡数的变化。</div><div>用于观察资源分配规模及任务排期趋势。</div></div></div><div class="chart-wrap"><canvas ref="lockCanvas"></canvas><div ref="lockTooltip" class="chart-tooltip"></div></div></article>
      </section>
    </section>
  </main>
  <div class="cluster-dashboard-toast" :class="{ show: toast }">{{ toast }}</div>
</template>
