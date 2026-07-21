<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { CURRENT_MONQUERY_TIMEOUT_MS, fetchAllBotStates, fetchClusterTrend, fetchLockBotList, fetchMonqueryUtilization } from '../services/api.js';
import { adaptNodeData } from '../services/adapter.js';
import { nextAutoRefreshDelay, shouldAutoRefresh } from '../services/auto-refresh.js';
import { hasFiniteSamples, nearestFiniteIndex, resolveYAxis } from '../services/chart-data.js';
import { CARD_COUNT, mergeLockBotStates } from '../services/cluster-state.js';
import {
  chinaSlotIndex,
  chinaTimeParts,
  formatChinaClock,
  formatChinaDate,
  formatChinaDateTime,
  formatChinaDatetimeLocal,
  formatChinaMonqueryDateTime,
  isSameChinaDay,
  parseChinaDatetimeLocal,
  startOfChinaDay,
} from '../services/china-time.js';
import '../cluster-dashboard.css';

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(['expired']);

const AVG_MARGIN = { top: 10, right: 16, bottom: 20, left: 48 };
const XPU_TICKS = [0, 5, 10, 15, 20, 25, 30, 35];
const MEM_TICKS = [0, 10, 20, 30, 40, 50, 60, 70];
const QUICK_RANGES = [
  { id: '15m', label: '最近 15 分钟', minutes: 15 },
  { id: '30m', label: '最近 30 分钟', minutes: 30 }, { id: '1h', label: '最近 1 小时', minutes: 60 },
  { id: '3h', label: '最近 3 小时', minutes: 180 }, { id: '6h', label: '最近 6 小时', minutes: 360 },
  { id: '12h', label: '最近 12 小时', minutes: 720 }, { id: '24h', label: '最近 24 小时', minutes: 1440 },
  { id: '2d', label: '最近 2 天', minutes: 2880 }, { id: '7d', label: '最近 7 天', minutes: 10080 },
  { id: '30d', label: '最近 30 天', minutes: 43200 }, { id: '90d', label: '最近 90 天', minutes: 129600 },
  { id: '6mo', label: '最近 6 个月', months: 6 },
];
const TREND_INTERVALS = [
  { maxMinutes: 360, seconds: 60 },
  { maxMinutes: 720, seconds: 120 },
  { maxMinutes: 1440, seconds: 240 },
  { maxMinutes: 2880, seconds: 480 },
  { maxMinutes: 10080, seconds: 1200 },
  { maxMinutes: 43200, seconds: 7200 },
  { maxMinutes: 129600, seconds: 21600 },
  { maxMinutes: 267840, seconds: 43200 },
];
const X_AXIS_TICK_OPTIONS = [
  60, 120, 240, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 21600,
  28800, 43200, 86400, 172800, 259200, 432000, 604800, 1209600, 1296000,
];
const CHINA_UTC_OFFSET_SECONDS = 8 * 60 * 60;
const CURRENT_METRICS_LOOKBACK_MS = 3 * 60 * 60 * 1000;

const rangeStart = ref(null);
const rangeEnd = ref(null);
const quickRangeId = ref('3h');
const trendDataAsOf = ref(null);
const lastRefreshAt = ref(null);
const draftStart = ref('');
const draftEnd = ref('');
const quickSearch = ref('');
const panelCollapsed = ref(true);
const meanVisible = ref(true);
const openTip = ref('');
const loading = ref(true);
const trendLoading = ref(true);
const currentStatsReady = ref(false);
const error = ref('');
const toast = ref('');
const nodes = ref([]);
const bots = ref([]);
const series = ref({ times: [], xpu: [], memory: [], lock: [] });
const lockStateComplete = ref(true);
const failedStateBotIds = ref([]);
const lockTrendComplete = ref(true);
const lockTrendFailureCount = ref(0);
const currentMetricsError = ref('');

const xpuCanvas = ref(null);
const memoryCanvas = ref(null);
const lockCanvas = ref(null);
const xpuTooltip = ref(null);
const memoryTooltip = ref(null);
const lockTooltip = ref(null);
const dashboardLoadStartedAt = performance.now();
let requestSequence = 0;
let refreshTimer;
let toastTimer;
let resizeHandler;
let initialLoadLogged = false;
const listenerCleanup = [];

const filteredQuickRanges = computed(() => {
  const filter = quickSearch.value.trim().toLowerCase();
  return QUICK_RANGES.filter(range => !filter || range.label.toLowerCase().includes(filter));
});
const timeLabel = computed(() => {
  return QUICK_RANGES.find(range => range.id === quickRangeId.value)?.label || '自定义时间范围';
});
function formatClock(value) {
  if (!value) return '--:--';
  return formatChinaClock(value);
}

const dataAsOf = computed(() => trendDataAsOf.value
  ? `数据统计截止 ${formatClock(trendDataAsOf.value * 1000)}`
  : '数据统计截止 --:--');
const refreshStatus = computed(() => lastRefreshAt.value ? `已刷新 ${formatClock(lastRefreshAt.value)}` : '尚未刷新');
const rangeSummary = computed(() => rangeStart.value && rangeEnd.value
  ? `${formatDateTimeLabel(rangeStart.value)} 至 ${formatDateTimeLabel(rangeEnd.value)}`
  : '');
const stats = computed(() => currentStatsReady.value
  ? buildStats(nodes.value, series.value.xpu, series.value.memory, lockStateComplete.value)
  : buildLoadingStats());
const dataWarning = computed(() => {
  const messages = [];
  if (!lockStateComplete.value) messages.push(`当前 Lock Bot 状态不完整（${failedStateBotIds.value.length} 个 Bot 请求失败），锁定相关统计暂不显示`);
  if (currentMetricsError.value) messages.push('当前 XPU/显存指标暂缺，系统将在下次自动刷新时重试');
  if (!lockTrendComplete.value) messages.push(`历史 Lock Bot 数据不完整（${lockTrendFailureCount.value} 个请求失败），锁定趋势暂不显示`);
  return messages.join('；');
});

function trendIntervalSeconds(minutes) {
  return TREND_INTERVALS.find(interval => minutes <= interval.maxMinutes).seconds;
}

function subtractChinaMonths(value, months) {
  const chinaDate = new Date(new Date(value).getTime() + CHINA_UTC_OFFSET_SECONDS * 1000);
  const year = chinaDate.getUTCFullYear();
  const month = chinaDate.getUTCMonth();
  const targetMonthIndex = month - months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const timestamp = Date.UTC(
    targetYear,
    targetMonth,
    Math.min(chinaDate.getUTCDate(), lastDay),
    chinaDate.getUTCHours(),
    chinaDate.getUTCMinutes(),
    chinaDate.getUTCSeconds(),
  );
  return new Date(timestamp - CHINA_UTC_OFFSET_SECONDS * 1000);
}

function exceedsMaximumTrendRange(start, end) {
  return start < subtractChinaMonths(end, 6);
}

function floorToInterval(value, intervalSeconds) {
  const intervalMs = intervalSeconds * 1000;
  return new Date(Math.floor(new Date(value).getTime() / intervalMs) * intervalMs);
}

function normalizeRange(start, end) {
  const rawEnd = end || new Date();
  const rawStart = start || rawEnd;
  const intervalSeconds = trendIntervalSeconds(Math.max(0, (rawEnd - rawStart) / 60_000));
  const queryEnd = floorToInterval(rawEnd, intervalSeconds);
  let queryStart = floorToInterval(rawStart, intervalSeconds);
  if (queryStart >= queryEnd) queryStart = new Date(queryEnd.getTime() - intervalSeconds * 1000);
  return { queryStart, queryEnd, intervalSeconds };
}

function formatMonqueryDateTime(date) {
  return formatChinaMonqueryDateTime(date);
}

function formatDateTimeLabel(date) {
  return formatChinaDateTime(date);
}

function toDatetimeLocalValue(date) {
  return formatChinaDatetimeLocal(date).slice(0, 16);
}

function dateKey(date) {
  return formatChinaDate(date);
}

function buildBuckets(start, end) {
  const buckets = [];
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 5 * 60_000) buckets.push(Math.floor(timestamp / 1000));
  return buckets;
}

function pointIntervalSeconds(times) {
  const intervals = times.slice(1).map((timestamp, index) => timestamp - times[index]).filter(interval => interval > 0);
  return intervals.length ? Math.min(...intervals) : 60;
}

function xAxisTickSeconds(times, maxLabels) {
  if (times.length < 2) return 60;
  const start = times[0];
  const end = times[times.length - 1];
  const pointInterval = pointIntervalSeconds(times);
  const target = Math.max((end - start) / Math.max(1, maxLabels - 1), pointInterval <= 60 ? 300 : pointInterval);
  return X_AXIS_TICK_OPTIONS.find(interval => interval >= target && interval % pointInterval === 0)
    || Math.ceil(target / pointInterval) * pointInterval;
}

function buildXAxisTicks(times, maxLabels) {
  if (times.length < 2) return { ticks: times, interval: 60 };
  const start = times[0];
  const end = times[times.length - 1];
  const interval = xAxisTickSeconds(times, maxLabels);
  const firstAligned = Math.ceil((start + CHINA_UTC_OFFSET_SECONDS) / interval) * interval - CHINA_UTC_OFFSET_SECONDS;
  const ticks = [start];
  for (let timestamp = firstAligned; timestamp < end; timestamp += interval) {
    if (timestamp > start) ticks.push(timestamp);
  }
  if (ticks.at(-1) !== end) ticks.push(end);
  return { ticks, interval };
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

function aggregateSeries(times, xpu, memory, lock) {
  return { times, xpu, memory, lock };
}

function currentSlot() {
  return chinaSlotIndex();
}

function adaptStates(stateResults, monqueryData, sampleSlot) {
  const merged = mergeLockBotStates(stateResults);
  return {
    nodes: adaptNodeData(merged.deviceState, monqueryData, sampleSlot, 'DEVICE'),
    lockStateComplete: merged.lockStateComplete,
    failedBotIds: merged.failedBotIds,
  };
}

function average(values) {
  const populated = values.filter(Number.isFinite);
  return populated.length ? populated.reduce((sum, value) => sum + value, 0) / populated.length : null;
}

function buildLoadingStats() {
  return [
    { label: '总节点', value: '--', tone: 'total' },
    { label: '总卡数', value: '--', tone: 'total' },
    { label: '节点使用率', value: '--', tone: 'locked' },
    { label: 'XPU卡平均利用率/峰值利用率', value: '--/--', tone: 'xpu-avg' },
    { label: '显存平均利用率/峰值利用率', value: '--/--', tone: 'mem-avg' },
  ];
}

function buildStats(currentNodes, xpu, memory, isLockStateComplete) {
  let lockedCards = 0;
  for (const node of currentNodes) {
    lockedCards += node.cardHasActiveLock?.filter(Boolean).length || 0;
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
    { label: '节点使用率', value: isLockStateComplete ? percent(totalCards ? lockedCards / totalCards * 100 : null) : '--', tone: 'locked', tip: '当前已通过 Lock Bot 锁定的 XPU 卡占 46 个计算节点总卡数的比例，反映计算资源已分配给任务的规模。' },
    { label: 'XPU卡平均利用率/峰值利用率', value: pair(xpu), tone: 'xpu-avg', tip: '平均利用率反映所选时段内集群整体计算负载；峰值利用率反映该时段最高负载水平。' },
    { label: '显存平均利用率/峰值利用率', value: pair(memory), tone: 'mem-avg', tip: '平均利用率反映所选时段内集群整体显存压力；峰值利用率反映该时段最高显存压力。' },
  ];
}

function setRange(start, end) {
  rangeStart.value = start;
  rangeEnd.value = end;
  draftStart.value = toDatetimeLocalValue(start);
  draftEnd.value = toDatetimeLocalValue(end);
}

function setQuickRange(range) {
  quickRangeId.value = range.id;
  const intervalSeconds = range.months ? 43200 : trendIntervalSeconds(range.minutes);
  const end = floorToInterval(new Date(), intervalSeconds);
  const start = range.months
    ? subtractChinaMonths(end, range.months)
    : new Date(end.getTime() - range.minutes * 60_000);
  setRange(start, end);
}

function refreshData() {
  const quickRange = QUICK_RANGES.find(range => range.id === quickRangeId.value);
  if (quickRange) setQuickRange(quickRange);
  load();
}

function resetRange() {
  setQuickRange(QUICK_RANGES.find(range => range.id === '3h'));
  load();
}

function applyRange() {
  const start = parseChinaDatetimeLocal(draftStart.value);
  const end = parseChinaDatetimeLocal(draftEnd.value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    showToast('请选择有效的开始和结束时间');
    return;
  }
  if (start.getSeconds() || end.getSeconds()) {
    showToast('时间范围仅支持分钟精度');
    return;
  }
  if (exceedsMaximumTrendRange(start, end)) {
    showToast('时间范围最长为 6 个月');
    return;
  }
  const { queryStart, queryEnd } = normalizeRange(start, end);
  setRange(queryStart, queryEnd);
  quickRangeId.value = null;
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

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${minutes} min ${((milliseconds % 60_000) / 1_000).toFixed(1)} s`;
}

function logInitialLoad(result, details) {
  if (initialLoadLogged) return;
  initialLoadLogged = true;
  window.requestAnimationFrame(() => {
    const completedAt = performance.now();
    const status = result === 'success' ? '完成' : '失败';
    const stages = {
      '页面初始化': formatDuration(completedAt - dashboardLoadStartedAt),
      '数据请求与渲染': formatDuration(completedAt - details.dataLoadStartedAt),
      'Lock Bot 列表': formatDuration(details.botListEndedAt - details.dataLoadStartedAt),
      '并行数据请求': formatDuration(details.requestsEndedAt - details.requestsStartedAt),
      'Lock Bot 状态': formatDuration(details.requestTimings.lockStates),
      '当前 Monquery': formatDuration(details.requestTimings.currentMonquery),
      '趋势请求': formatDuration(details.requestTimings.trend),
      '图表渲染': formatDuration(completedAt - details.renderStartedAt),
      '状态': status,
      '结果': result === 'success' ? '成功' : details.errorMessage,
    };
    console.groupCollapsed(`[cluster] 首屏加载${status} · ${stages['页面初始化']}`);
    console.table(stages);
    console.groupEnd();
  });
}

async function load() {
  if (!rangeStart.value || !rangeEnd.value) return;
  const sequence = ++requestSequence;
  const dataLoadStartedAt = performance.now();
  let botListEndedAt = dataLoadStartedAt;
  let requestsStartedAt = dataLoadStartedAt;
  let requestsEndedAt = dataLoadStartedAt;
  let renderStartedAt = dataLoadStartedAt;
  const requestTimings = { lockStates: 0, currentMonquery: 0, trend: 0 };
  loading.value = true;
  trendLoading.value = true;
  error.value = '';
  currentMetricsError.value = '';
  try {
    if (!bots.value.length) bots.value = await fetchLockBotList(props.token);
    botListEndedAt = performance.now();
    const { queryStart, queryEnd, intervalSeconds } = normalizeRange(rangeStart.value, rangeEnd.value);
    const today = new Date();
    const todayStart = startOfChinaDay(today);
    const currentMetricsStart = new Date(Math.max(todayStart.getTime(), today.getTime() - CURRENT_METRICS_LOOKBACK_MS));
    const currentSlotAtRequest = chinaSlotIndex(today);
    requestsStartedAt = performance.now();
    const lockStatesStartedAt = performance.now();
    const statePromise = fetchAllBotStates(props.token)
      .then(states => bots.value.map(bot => ({
        bot,
        ok: true,
        state: states[String(bot.id)] ?? states[bot.id] ?? {},
      })))
      .catch(caught => bots.value.map(bot => ({
        bot,
        ok: false,
        error: caught?.message || '状态请求失败',
      })))
      .finally(() => { requestTimings.lockStates = performance.now() - lockStatesStartedAt; });
    const currentMonqueryStartedAt = performance.now();
    const currentPromise = fetchMonqueryUtilization(
      formatMonqueryDateTime(currentMetricsStart),
      formatMonqueryDateTime(today),
      { timeoutMs: CURRENT_MONQUERY_TIMEOUT_MS },
    )
      .then(data => ({ ok: true, data }))
      .catch(caught => ({ ok: false, caught }))
      .finally(() => { requestTimings.currentMonquery = performance.now() - currentMonqueryStartedAt; });
    const trendStartedAt = performance.now();
    const trendPromise = fetchClusterTrend(queryStart, queryEnd, props.token, intervalSeconds)
      .finally(() => { requestTimings.trend = performance.now() - trendStartedAt; });
    const trendOutcome = trendPromise.then(
      data => ({ ok: true, data }),
      caught => ({ ok: false, caught }),
    );
    const [stateResults, currentOutcome] = await Promise.all([statePromise, currentPromise]);
    if (sequence !== requestSequence) return;
    if (!currentOutcome.ok) {
      currentMetricsError.value = currentOutcome.caught?.message || '当前 Monquery 指标请求失败';
    }
    const currentState = adaptStates(stateResults, currentOutcome.ok ? currentOutcome.data : [], currentSlotAtRequest);
    lastRefreshAt.value = Date.now();
    nodes.value = currentState.nodes;
    lockStateComplete.value = currentState.lockStateComplete;
    failedStateBotIds.value = currentState.failedBotIds;
    currentStatsReady.value = true;
    await nextTick();

    const trendResult = await trendOutcome;
    requestsEndedAt = performance.now();
    if (!trendResult.ok) throw trendResult.caught;
    if (sequence !== requestSequence) return;
    const rawTrend = trendResult.data;
    trendDataAsOf.value = rawTrend.dataAsOf;
    lockTrendComplete.value = rawTrend.lockStatus?.complete !== false;
    lockTrendFailureCount.value = rawTrend.lockStatus?.failureCount || 0;
    series.value = aggregateSeries(
      rawTrend.times,
      rawTrend.xpu,
      rawTrend.memory,
      rawTrend.lock,
    );
    await nextTick();
    renderStartedAt = performance.now();
    drawAllCharts();
    trendLoading.value = false;
    logInitialLoad('success', { dataLoadStartedAt, botListEndedAt, requestsStartedAt, requestsEndedAt, renderStartedAt, requestTimings });
  } catch (caught) {
    if (sequence !== requestSequence) return;
    requestsEndedAt = performance.now();
    if (/401|403/.test(String(caught?.message))) emit('expired');
    error.value = caught?.message || '加载全集群趋势数据失败';
    await nextTick();
    renderStartedAt = performance.now();
    drawAllCharts();
    trendLoading.value = false;
    logInitialLoad('failure', {
      dataLoadStartedAt,
      botListEndedAt,
      requestsStartedAt,
      requestsEndedAt,
      renderStartedAt,
      requestTimings,
      errorMessage: error.value,
    });
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function drawAllCharts() {
  drawChart(xpuCanvas.value, series.value.xpu, '#7c3aed', 35, XPU_TICKS, 'XPU 利用率');
  drawChart(memoryCanvas.value, series.value.memory, '#ea580c', 70, MEM_TICKS, '显存利用率');
  drawChart(lockCanvas.value, series.value.lock, '#d97706', 100, [0, 25, 50, 75, 100], '节点使用率');
}

function drawChart(canvas, values, color, defaultYMax, defaultTicks, label) {
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
  const yAxis = resolveYAxis(values, defaultYMax, defaultTicks, 100);
  const yMax = yAxis.yMax;
  const ticks = yAxis.ticks;
  const hasSamples = hasFiniteSamples(values);
  const plotWidth = width - AVG_MARGIN.left - AVG_MARGIN.right;
  const plotHeight = height - AVG_MARGIN.top - AVG_MARGIN.bottom;
  const xFor = index => AVG_MARGIN.left + index / Math.max(1, count - 1) * plotWidth;
  const yFor = value => AVG_MARGIN.top + (1 - Math.max(0, Math.min(yMax, value || 0)) / yMax) * plotHeight;

  context.save();
  context.strokeStyle = '#94a3b8'; context.lineWidth = .8; context.setLineDash([4, 4]);
  ticks.forEach(value => { const y = yFor(value); context.beginPath(); context.moveTo(AVG_MARGIN.left, y); context.lineTo(width - AVG_MARGIN.right, y); context.stroke(); });
  const maxLabels = Math.max(3, Math.floor(plotWidth / 95) + 1);
  const xAxis = buildXAxisTicks(series.value.times, maxLabels);
  const xTicks = xAxis.ticks;
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
  const tickInterval = xAxis.interval;
  const sameDay = series.value.times.length && isSameChinaDay(rangeStart * 1000, rangeEnd * 1000);
  const labelCandidates = xTicks.map(timestamp => {
    const date = chinaTimeParts(timestamp * 1000);
    const seconds = tickInterval < 300 ? `:${date.second}` : '';
    const clock = `${date.hour}:${date.minute}${seconds}`;
    const text = sameDay ? clock : `${date.month}-${date.day} ${clock}`;
    const x = AVG_MARGIN.left + (timestamp - rangeStart) / rangeSeconds * plotWidth;
    return { text, x, width: context.measureText(text).width };
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

  if (!hasSamples) {
    context.save(); context.fillStyle = '#94a3b8'; context.font = '600 14px -apple-system,"PingFang SC",sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('暂无有效采样', AVG_MARGIN.left + plotWidth / 2, AVG_MARGIN.top + plotHeight / 2); context.restore();
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
    const targetIndex = plotX / meta.plotWidth * (meta.values.length - 1);
    const index = nearestFiniteIndex(meta.values, targetIndex);
    if (index < 0) { tooltipElement.style.display = 'none'; restoreSnapshot(canvas); return; }
    const crosshairX = meta.margins.left + index / Math.max(1, meta.values.length - 1) * meta.plotWidth;
    restoreSnapshot(canvas);
    const context = canvas.getContext('2d'); context.save(); context.beginPath(); context.rect(meta.margins.left, meta.margins.top, meta.plotWidth, meta.plotHeight); context.clip(); context.strokeStyle = 'rgba(100,116,139,.5)'; context.lineWidth = 1; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(crosshairX, meta.margins.top); context.lineTo(crosshairX, meta.margins.top + meta.plotHeight); context.stroke(); context.setLineDash([]); const value = meta.values[index]; const y = meta.margins.top + (1 - value / meta.yMax) * meta.plotHeight; context.beginPath(); context.arc(crosshairX, y, 4, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = meta.color; context.lineWidth = 2; context.stroke(); context.restore();
    const date = chinaTimeParts(series.value.times[index] * 1000);
    tooltipElement.innerHTML = `<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">${date.month}-${date.day} ${date.hour}:${date.minute}</div><div style="display:grid;grid-template-columns:12px 48px 48px;align-items:center;gap:6px;margin:1px 0;"><span style="width:7px;height:7px;border-radius:50%;background:${meta.color};justify-self:center;"></span><span style="font-size:10px;color:#cbd5e1;">${meta.label}</span><span style="font-weight:600;color:${meta.color};text-align:right;font-variant-numeric:tabular-nums;">${value.toFixed(1)}%</span></div>${meta.mean === null ? '' : `<div style="display:grid;grid-template-columns:12px 48px 48px;align-items:center;gap:6px;margin:1px 0;"><span style="width:12px;height:2px;background:#dc2626;justify-self:center;"></span><span style="font-size:10px;color:#cbd5e1;">范围均值</span><span style="font-weight:600;color:#dc2626;text-align:right;font-variant-numeric:tabular-nums;">${meta.mean.toFixed(1)}%</span></div>`}`;
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

function scheduleAutoRefresh() {
  refreshTimer = window.setTimeout(() => {
    if (!document.hidden && !loading.value && shouldAutoRefresh(rangeStart.value, rangeEnd.value)) refreshData();
    scheduleAutoRefresh();
  }, nextAutoRefreshDelay());
}

onMounted(async () => {
  setQuickRange(QUICK_RANGES.find(range => range.id === '3h'));
  scheduleAutoRefresh();
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
  window.clearTimeout(refreshTimer); window.clearTimeout(toastTimer);
  window.removeEventListener('resize', resizeHandler); document.removeEventListener('click', closeTips);
  listenerCleanup.splice(0).forEach(cleanup => cleanup());
});
</script>

<template>
  <main class="cluster-dashboard">
    <header class="cluster-page-header"><h1>开发机资源监控面板</h1></header>
    <section class="stats-bar" aria-label="全集群统计">
      <div v-for="row in [stats.slice(0, 2), stats.slice(2)]" :key="row[0].label" class="stats-bar-row" :class="{ 'stats-bar-row-top': row.length === 2 }">
        <article v-for="card in row" :key="card.label" class="stat-card" :class="card.tone">
          <div class="label">{{ card.label }}</div><div class="value" :class="[card.tone, { pct: card.value.includes('%') }]">{{ card.value }}</div>
          <button v-if="card.tip" type="button" class="tip-icon" aria-label="查看计算说明" @click.stop="openTip = openTip === card.label ? '' : card.label">?</button>
          <div v-if="card.tip" class="tip-popup" :class="{ show: openTip === card.label }">{{ card.tip }}</div>
        </article>
      </div>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>
    <p v-if="dataWarning" class="data-warning">{{ dataWarning }}</p>
    <section id="average-view">
      <div class="cluster-filter-head">
        <div class="gtp-trigger-bar">
          <span class="gtp-time-label">{{ timeLabel }}</span>
          <button type="button" class="gtp-zoom-btn" :title="panelCollapsed ? '点击筛选' : '隐藏筛选'" :aria-label="panelCollapsed ? '点击筛选' : '隐藏筛选'" aria-controls="cluster-range-panel" :aria-expanded="!panelCollapsed" @click="panelCollapsed = !panelCollapsed">{{ panelCollapsed ? '点击筛选' : '隐藏筛选' }}</button>
          <button type="button" class="gtp-refresh-btn" :disabled="loading" @click="refreshData()">{{ loading ? '正在加载…' : '⟲ 刷新' }}</button>
          <span class="data-as-of"><span class="data-as-of-dot" aria-hidden="true"></span><span>{{ dataAsOf }}</span><span class="refresh-status">{{ refreshStatus }}</span></span>
        </div>
      </div>
      <div id="cluster-range-panel" class="cluster-range-panel" :class="{ hidden: panelCollapsed }">
        <div class="cluster-range-grid">
          <div class="cluster-range-absolute">
            <div class="cluster-range-title">时间范围筛选</div>
            <div class="cluster-field"><label for="cluster-start-time">开始时间</label><input id="cluster-start-time" v-model="draftStart" type="datetime-local" step="60" /></div>
            <div class="cluster-field"><label for="cluster-end-time">结束时间</label><input id="cluster-end-time" v-model="draftEnd" type="datetime-local" step="60" /></div>
            <div class="cluster-range-actions"><button type="button" class="cluster-icon-btn" title="复制时间范围" @click="copyRange">复制区间</button><button type="button" class="cluster-icon-btn" title="重置为最近 3 小时" @click="resetRange">默认筛选</button><button type="button" class="cluster-apply-btn" :disabled="loading" @click="applyRange">筛选</button></div>
          </div>
          <div class="cluster-range-quick"><input v-model="quickSearch" class="cluster-quick-search" type="search" placeholder="搜索快捷时间" /><div class="cluster-quick-list"><button v-for="quick in filteredQuickRanges" :key="quick.id" type="button" class="cluster-quick-item" :class="{ active: quickRangeId === quick.id }" :disabled="loading" @click="setQuickRange(quick); load()">{{ quick.label }}</button></div></div>
        </div>
      </div>

      <section class="charts-row">
        <article class="chart-panel"><div class="chart-panel-head"><div class="chart-panel-title chart-title-with-tip">节点使用率趋势<button type="button" class="tip-icon" aria-label="查看绘图规则" @click.stop="openTip = openTip === 'lock-chart' ? '' : 'lock-chart'">?</button><div class="tip-popup" :class="{ show: openTip === 'lock-chart' }"><div>展示所选时段内已锁定 XPU 卡占 46 个计算节点总卡数的变化。</div><div>用于观察计算资源分配规模及任务排期趋势。</div></div></div><button type="button" class="avg-mean-toggle" :class="{ active: meanVisible }" :aria-pressed="meanVisible" @click="meanVisible = !meanVisible; drawAllCharts()">均值线</button></div><div class="chart-wrap"><canvas ref="lockCanvas"></canvas><div v-if="trendLoading" class="chart-loading">正在加载趋势数据</div><div ref="lockTooltip" class="chart-tooltip"></div></div></article>
        <article class="chart-panel"><div class="chart-panel-title">XPU卡利用率趋势</div><div class="chart-wrap"><canvas ref="xpuCanvas"></canvas><div v-if="trendLoading" class="chart-loading">正在加载趋势数据</div><div ref="xpuTooltip" class="chart-tooltip"></div></div></article>
        <article class="chart-panel"><div class="chart-panel-title">显存利用率趋势</div><div class="chart-wrap"><canvas ref="memoryCanvas"></canvas><div v-if="trendLoading" class="chart-loading">正在加载趋势数据</div><div ref="memoryTooltip" class="chart-tooltip"></div></div></article>
      </section>
    </section>
  </main>
  <div class="cluster-dashboard-toast" :class="{ show: toast }">{{ toast }}</div>
</template>
