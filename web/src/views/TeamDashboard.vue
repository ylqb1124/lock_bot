<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fetchTeamDashboard } from '../services/api.js';
import { chinaTimeParts, formatChinaDatetimeLocal, formatChinaDateTime, isSameChinaDay, parseChinaDatetimeLocal } from '../services/china-time.js';
import '../team-dashboard.css';

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(['expired']);

const DAY_MINUTES = 24 * 60;
const QUICK_RANGES = [
  { id: '3h', label: '最近 3 小时', minutes: 3 * 60 },
  { id: '1d', label: '最近 1 天', minutes: DAY_MINUTES },
  { id: '2d', label: '最近 2 天', minutes: 2 * DAY_MINUTES },
  { id: '7d', label: '最近 7 天', minutes: 7 * DAY_MINUTES },
  { id: '30d', label: '最近 30 天', minutes: 30 * DAY_MINUTES },
  { id: '90d', label: '最近 90 天', minutes: 90 * DAY_MINUTES },
];
const TREND_MARGIN = { top: 28, right: 64, bottom: 40, left: 58 };
const TREND_Y_TICKS = [0, 20, 40, 60, 80, 100];
const X_AXIS_TICK_OPTIONS = [
  60, 120, 240, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 21600,
  28800, 43200, 86400, 172800, 259200, 432000, 604800, 1209600, 1296000,
];
const CHINA_UTC_OFFSET_SECONDS = 8 * 60 * 60;
const TREND_SERIES = [
  { field: 'xpu', label: 'XPU 利用率', color: '#7c3aed', axis: 'rate' },
  { field: 'memory', label: '显存利用率', color: '#38bdf8', axis: 'rate' },
  { field: 'lockedCards', label: '占用卡数', color: '#f97316', axis: 'cards' },
];
const TEAM_COLORS = {
  'operator-testing': '#ea580c',
  inference: '#3b82f6',
  training: '#16a34a',
  'general-research': '#8b5cf6',
};
const PIE_CIRCUMFERENCE = 2 * Math.PI * 42;

const rangeStart = ref(null);
const rangeEnd = ref(null);
const quickRangeId = ref('7d');
const draftStart = ref('');
const draftEnd = ref('');
const panelCollapsed = ref(true);
const efficiencyCollapsed = ref(false);
const selectedTeamId = ref('general-research');
const hoveredTrendIndex = ref(null);
const trendCanvas = ref(null);
const trendTooltip = ref(null);
const trendTooltipStyle = ref({});
const dashboard = ref(null);
const loading = ref(false);
const error = ref('');
const rangeError = ref('');
let refreshTimer;
let requestSequence = 0;
let resizeHandler;

const teams = computed(() => dashboard.value?.teams || []);
const selectedTeam = computed(() => teams.value.find(team => team.id === selectedTeamId.value) || teams.value.at(-1) || null);
const selectedTrend = computed(() => selectedTeam.value?.trend || []);
const selectedRankings = computed(() => (dashboard.value?.rankings || []).filter(row => row.team === selectedTeamId.value));
const timeLabel = computed(() => QUICK_RANGES.find(range => range.id === quickRangeId.value)?.label || '自定义时间范围');
const averagePeriodLabel = computed(() => QUICK_RANGES.find(range => range.id === quickRangeId.value)?.label.replace('最近 ', '近 ') || '所选范围');
const rangeSummary = computed(() => rangeStart.value && rangeEnd.value
  ? `${formatChinaDateTime(rangeStart.value)} 至 ${formatChinaDateTime(rangeEnd.value)}`
  : '尚未选择时间范围');
const dataAsOf = computed(() => Number.isFinite(dashboard.value?.dataAsOf) ? new Date(dashboard.value.dataAsOf * 1000) : null);
const dataAsOfLabel = computed(() => dataAsOf.value ? formatChinaDateTime(dataAsOf.value) : '暂无可对齐采样点');
const sampleSeconds = computed(() => dashboard.value?.range?.sampleSeconds || null);
const sampleLabel = computed(() => {
  if (!Number.isFinite(sampleSeconds.value)) return '等待采样信息';
  if (sampleSeconds.value < 3600) return `${sampleSeconds.value / 60} 分钟采样`;
  if (sampleSeconds.value % 3600 === 0) return `${sampleSeconds.value / 3600} 小时采样`;
  if (sampleSeconds.value % 60 === 0) return `${sampleSeconds.value / 60} 分钟采样`;
  return `${sampleSeconds.value} 秒采样`;
});
const cacheLabel = computed(() => dashboard.value?.cache?.hit ? '已命中一小时聚合缓存' : '已更新聚合数据');
const mappingStatus = computed(() => {
  const membership = dashboard.value?.membership;
  if (!membership?.generatedAt) return '尚未保存固定团队映射，未映射使用者暂归通用研发并标记待确认。';
  return `固定团队映射保存于 ${formatChinaDateTime(membership.generatedAt)}；切换筛选区间不会改变团队归属。`;
});
const totalCardHours = computed(() => teams.value.reduce((total, team) => total + (Number.isFinite(team.cardHours) ? team.cardHours : 0), 0));
const pieSegments = computed(() => {
  let offset = 0;
  return teams.value.map(team => {
    const percent = totalCardHours.value ? Math.max(0, team.cardHours || 0) / totalCardHours.value : 0;
    const segment = {
      id: team.id,
      label: team.label,
      color: TEAM_COLORS[team.id] || '#64748b',
      percent,
      dasharray: `${percent * PIE_CIRCUMFERENCE} ${PIE_CIRCUMFERENCE}`,
      dashoffset: -offset * PIE_CIRCUMFERENCE,
    };
    offset += percent;
    return segment;
  });
});
const historicalMetrics = computed(() => [
  { label: `${averagePeriodLabel.value}平均节点占用率`, value: formatPercent(selectedTeam.value?.averages?.lockRate), tone: 'node-util' },
  { label: `${averagePeriodLabel.value}平均 XPU 利用率`, value: formatPercent(selectedTeam.value?.averages?.xpu), tone: 'xpu' },
  { label: `${averagePeriodLabel.value}平均显存利用率`, value: formatPercent(selectedTeam.value?.averages?.memory), tone: 'memory' },
  { label: `${averagePeriodLabel.value}平均活跃人数`, value: formatAverageCount(selectedTeam.value?.averages?.activeUsers), tone: 'locked-users' },
  { label: `${averagePeriodLabel.value}人均锁定卡数`, value: formatAverageCount(selectedTeam.value?.averages?.lockedCardsPerUser), tone: 'cards-per-user' },
]);
const trendHasSamples = computed(() => selectedTrend.value.some(hasTrendValue));
const hoveredTrendPoint = computed(() => {
  const index = hoveredTrendIndex.value;
  return Number.isInteger(index) ? selectedTrend.value[index] || null : null;
});

function setRange(start, end, nextQuickRangeId = null) {
  rangeStart.value = start;
  rangeEnd.value = end;
  draftStart.value = formatChinaDatetimeLocal(start).slice(0, 16);
  draftEnd.value = formatChinaDatetimeLocal(end).slice(0, 16);
  quickRangeId.value = nextQuickRangeId;
  rangeError.value = '';
}

function setQuickRange(range, refresh = true) {
  const end = new Date();
  setRange(new Date(end.getTime() - range.minutes * 60_000), end, range.id);
  if (refresh) void load();
}

function applyRange() {
  const start = parseChinaDatetimeLocal(draftStart.value);
  const end = parseChinaDatetimeLocal(draftEnd.value);
  const duration = end.getTime() - start.getTime();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || duration < 3 * 60 * 60 * 1000 || duration > 90 * 24 * 60 * 60 * 1000) {
    rangeError.value = '团队视图仅支持 3 小时至 90 天的有效时间范围。';
    return;
  }
  setRange(start, end);
  void load();
}

function resetRange() {
  setQuickRange(QUICK_RANGES.find(range => range.id === '7d'));
}

async function load() {
  if (!rangeStart.value || !rangeEnd.value) return;
  const sequence = ++requestSequence;
  loading.value = true;
  error.value = '';
  try {
    const result = await fetchTeamDashboard(rangeStart.value, rangeEnd.value, props.token);
    if (sequence !== requestSequence) return;
    dashboard.value = result;
    if (!result.teams?.some(team => team.id === selectedTeamId.value)) selectedTeamId.value = result.teams?.[0]?.id || 'general-research';
  } catch (caught) {
    if (sequence !== requestSequence) return;
    if (/401|403/.test(String(caught?.message))) emit('expired');
    error.value = caught?.message || '加载团队监控数据失败';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '暂无有效样本';
}

function formatCount(value) {
  return Number.isFinite(value) ? String(value) : '暂无有效样本';
}

function formatCards(value) {
  return Number.isFinite(value) ? `${value} 张` : '暂无有效样本';
}

function formatAverageCount(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '暂无有效样本';
}

function formatCardHours(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} 卡时` : '暂无有效样本';
}

function formatTrendTime(point) {
  return point?.timestamp ? formatChinaDateTime(new Date(point.timestamp * 1000)).slice(5, 16) : '';
}

function hasTrendValue(point) {
  return TREND_SERIES.some(series => Number.isFinite(point?.[series.field]));
}

function trendTimes(points) {
  return points.map((point, index) => Number.isFinite(point?.timestamp) ? point.timestamp : index);
}

function pointIntervalSeconds(times) {
  const intervals = times.slice(1).map((timestamp, index) => timestamp - times[index]).filter(interval => interval > 0);
  return intervals.length ? Math.min(...intervals) : 60;
}

function buildXAxisTicks(times, maxLabels) {
  if (times.length < 2) return { ticks: times, interval: 60 };
  const start = times[0];
  const end = times.at(-1);
  const pointInterval = pointIntervalSeconds(times);
  const target = Math.max((end - start) / Math.max(1, maxLabels - 1), pointInterval <= 60 ? 300 : pointInterval);
  const interval = X_AXIS_TICK_OPTIONS.find(candidate => candidate >= target && candidate % pointInterval === 0)
    || Math.ceil(target / pointInterval) * pointInterval;
  const firstAligned = Math.ceil((start + CHINA_UTC_OFFSET_SECONDS) / interval) * interval - CHINA_UTC_OFFSET_SECONDS;
  const ticks = [start];
  for (let timestamp = firstAligned; timestamp < end; timestamp += interval) {
    if (timestamp > start) ticks.push(timestamp);
  }
  if (ticks.at(-1) !== end) ticks.push(end);
  return { ticks, interval };
}

function resolveCardAxis(points) {
  const peak = points.reduce((maximum, point) => Number.isFinite(point?.lockedCards)
    ? Math.max(maximum, point.lockedCards)
    : maximum, 0);
  const rawStep = Math.max(1, peak / 5);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = Math.max(1, (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude);
  const max = Math.max(step, Math.ceil(peak / step) * step);
  return {
    max,
    ticks: Array.from({ length: Math.floor(max / step) + 1 }, (_, index) => index * step),
  };
}

function formatTrendTick(timestamp, interval, sameDay) {
  const date = chinaTimeParts(timestamp * 1000);
  const seconds = interval < 300 ? `:${date.second}` : '';
  const clock = `${date.hour}:${date.minute}${seconds}`;
  return sameDay ? clock : `${date.month}-${date.day} ${clock}`;
}

function drawSmoothedLine(context, segment, series, xFor, yForSeries) {
  const coordinates = segment.map(point => ({
    x: xFor(point.timestamp),
    y: yForSeries(series, point.point[series.field]),
  }));
  if (!coordinates.length) return;
  context.beginPath();
  context.moveTo(coordinates[0].x, coordinates[0].y);
  const tension = .14;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const previous = coordinates[index - 1] || coordinates[index];
    const current = coordinates[index];
    const next = coordinates[index + 1];
    const after = coordinates[index + 2] || next;
    context.bezierCurveTo(
      current.x + (next.x - previous.x) * tension,
      current.y + (next.y - previous.y) * tension,
      next.x - (after.x - current.x) * tension,
      next.y - (after.y - current.y) * tension,
      next.x,
      next.y,
    );
  }
}

function drawTrendChart() {
  const canvas = trendCanvas.value;
  const points = selectedTrend.value;
  if (!canvas || !points.length) return;
  const surface = canvas.parentElement;
  const width = surface.clientWidth || surface.offsetWidth || 600;
  const height = surface.clientHeight || surface.offsetHeight || 330;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const plotWidth = Math.max(1, width - TREND_MARGIN.left - TREND_MARGIN.right);
  const plotHeight = Math.max(1, height - TREND_MARGIN.top - TREND_MARGIN.bottom);
  const times = trendTimes(points);
  const start = times[0];
  const end = times.at(-1);
  const rangeSeconds = Math.max(1, end - start);
  const xFor = timestamp => TREND_MARGIN.left + (timestamp - start) / rangeSeconds * plotWidth;
  const rateYFor = value => TREND_MARGIN.top + (1 - Math.max(0, Math.min(100, value)) / 100) * plotHeight;
  const cardAxis = resolveCardAxis(points);
  const cardsYFor = value => TREND_MARGIN.top + (1 - Math.max(0, Math.min(cardAxis.max, value)) / cardAxis.max) * plotHeight;
  const yForSeries = (series, value) => series.axis === 'cards' ? cardsYFor(value) : rateYFor(value);
  const xAxis = buildXAxisTicks(times, Math.max(3, Math.floor(plotWidth / 95) + 1));

  context.save();
  context.strokeStyle = '#e5e7eb';
  context.lineWidth = .8;
  TREND_Y_TICKS.forEach(value => {
    const y = rateYFor(value);
    context.beginPath();
    context.moveTo(TREND_MARGIN.left, y);
    context.lineTo(width - TREND_MARGIN.right, y);
    context.stroke();
  });
  context.restore();

  context.save();
  context.fillStyle = '#6d28d9';
  context.font = '11px "SF Mono", "JetBrains Mono", monospace';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  TREND_Y_TICKS.forEach(value => context.fillText(`${value}%`, TREND_MARGIN.left - 8, rateYFor(value)));
  context.fillStyle = '#ea580c';
  context.textAlign = 'left';
  cardAxis.ticks.forEach(value => context.fillText(`${value} 张`, width - TREND_MARGIN.right + 8, cardsYFor(value)));
  context.font = '600 11px -apple-system, "PingFang SC", sans-serif';
  context.textBaseline = 'top';
  context.fillStyle = '#6d28d9';
  context.textAlign = 'left';
  context.fillText('利用率 (%)', 0, 5);
  context.fillStyle = '#ea580c';
  context.textAlign = 'right';
  context.fillText('占用卡数', width, 5);
  context.restore();

  context.save();
  context.lineWidth = 1.25;
  context.beginPath();
  context.strokeStyle = '#6d28d9';
  context.moveTo(TREND_MARGIN.left, TREND_MARGIN.top);
  context.lineTo(TREND_MARGIN.left, TREND_MARGIN.top + plotHeight);
  context.stroke();
  context.beginPath();
  context.strokeStyle = '#ea580c';
  context.moveTo(width - TREND_MARGIN.right, TREND_MARGIN.top);
  context.lineTo(width - TREND_MARGIN.right, TREND_MARGIN.top + plotHeight);
  context.stroke();
  context.beginPath();
  context.strokeStyle = '#94a3b8';
  context.moveTo(TREND_MARGIN.left, TREND_MARGIN.top + plotHeight);
  context.lineTo(width - TREND_MARGIN.right, TREND_MARGIN.top + plotHeight);
  context.stroke();
  context.restore();

  context.save();
  context.fillStyle = '#475569';
  context.font = '11px "SF Mono", "JetBrains Mono", monospace';
  context.textBaseline = 'top';
  const sameDay = isSameChinaDay(start * 1000, end * 1000);
  const labels = xAxis.ticks.map(timestamp => {
    const text = formatTrendTick(timestamp, xAxis.interval, sameDay);
    return { timestamp, text, x: xFor(timestamp), width: context.measureText(text).width };
  });
  const lastLabel = labels.at(-1);
  const lastLabelLeft = lastLabel ? width - TREND_MARGIN.right - lastLabel.width : Infinity;
  let occupiedRight = TREND_MARGIN.left;
  labels.forEach((label, index) => {
    const first = index === 0;
    const last = index === labels.length - 1;
    const left = first ? TREND_MARGIN.left : last ? lastLabelLeft : label.x - label.width / 2;
    const right = left + label.width;
    if (!first && !last && (left < occupiedRight + 12 || right > lastLabelLeft - 12)) return;
    context.textAlign = first ? 'left' : last ? 'right' : 'center';
    context.fillText(label.text, first ? TREND_MARGIN.left : last ? width - TREND_MARGIN.right : label.x, TREND_MARGIN.top + plotHeight + 7);
    occupiedRight = right;
  });
  context.restore();

  context.save();
  context.beginPath();
  context.rect(TREND_MARGIN.left, TREND_MARGIN.top, plotWidth, plotHeight);
  context.clip();
  TREND_SERIES.forEach(series => {
    let segment = [];
    const stroke = () => {
      if (!segment.length) return;
      drawSmoothedLine(context, segment, series, xFor, yForSeries);
      context.strokeStyle = series.color;
      context.lineWidth = 2.25;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.stroke();
      segment = [];
    };
    points.forEach((point, index) => {
      if (Number.isFinite(point?.[series.field])) segment.push({ point, timestamp: times[index] });
      else stroke();
    });
    stroke();
  });
  context.restore();

  canvas._teamTrendMeta = { points, times, width, height, plotWidth, plotHeight, start, rangeSeconds, xFor, yForSeries };
  canvas._teamTrendSnapshot = context.getImageData(0, 0, canvas.width, canvas.height);
}

function restoreTrendSnapshot() {
  const canvas = trendCanvas.value;
  if (!canvas?._teamTrendSnapshot) return;
  const context = canvas.getContext('2d');
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.putImageData(canvas._teamTrendSnapshot, 0, 0);
  context.restore();
}

function nearestTrendIndex(points, times, timestamp) {
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  points.forEach((point, index) => {
    if (!hasTrendValue(point)) return;
    const distance = Math.abs(times[index] - timestamp);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex;
}

function positionTrendTooltip(event, crosshairX) {
  const canvas = trendCanvas.value;
  const tooltip = trendTooltip.value;
  if (!canvas || !tooltip) return;
  const bounds = canvas.getBoundingClientRect();
  const gap = 10;
  const edge = 8;
  const tooltipWidth = Math.min(tooltip.offsetWidth, Math.max(0, bounds.width - edge * 2));
  const tooltipHeight = Math.min(tooltip.offsetHeight, Math.max(0, bounds.height - edge * 2));
  const preferredLeft = crosshairX + gap;
  const fallbackLeft = crosshairX - tooltipWidth - gap;
  const left = preferredLeft + tooltipWidth <= bounds.width - edge ? preferredLeft : fallbackLeft;
  const pointerY = event.clientY - bounds.top;
  trendTooltipStyle.value = {
    left: `${Math.max(edge, Math.min(left, bounds.width - tooltipWidth - edge))}px`,
    top: `${Math.max(edge, Math.min(pointerY - tooltipHeight - gap, bounds.height - tooltipHeight - edge))}px`,
  };
}

function handleTrendPointer(event) {
  const canvas = trendCanvas.value;
  const meta = canvas?._teamTrendMeta;
  if (!canvas || !meta) return;
  const bounds = canvas.getBoundingClientRect();
  const plotX = event.clientX - bounds.left - TREND_MARGIN.left;
  if (plotX < 0 || plotX > meta.plotWidth) {
    clearTrendHover();
    return;
  }
  const timestamp = meta.start + plotX / meta.plotWidth * meta.rangeSeconds;
  const index = nearestTrendIndex(meta.points, meta.times, timestamp);
  if (index < 0) {
    clearTrendHover();
    return;
  }
  const crosshairX = meta.xFor(meta.times[index]);
  restoreTrendSnapshot();
  const context = canvas.getContext('2d');
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  context.save();
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.beginPath();
  context.rect(TREND_MARGIN.left, TREND_MARGIN.top, meta.plotWidth, meta.plotHeight);
  context.clip();
  context.strokeStyle = 'rgba(71,85,105,.7)';
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(crosshairX, TREND_MARGIN.top);
  context.lineTo(crosshairX, TREND_MARGIN.top + meta.plotHeight);
  context.stroke();
  context.setLineDash([]);
  TREND_SERIES.forEach(series => {
    const value = meta.points[index]?.[series.field];
    if (!Number.isFinite(value)) return;
    context.beginPath();
    context.arc(crosshairX, meta.yForSeries(series, value), 4.5, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.strokeStyle = series.color;
    context.lineWidth = 2;
    context.stroke();
  });
  context.restore();
  hoveredTrendIndex.value = index;
  void nextTick(() => positionTrendTooltip(event, crosshairX));
}

function clearTrendHover() {
  hoveredTrendIndex.value = null;
  trendTooltipStyle.value = {};
  restoreTrendSnapshot();
}

function scheduleTrendDraw() {
  void nextTick(() => drawTrendChart());
}

watch(selectedTeamId, () => {
  clearTrendHover();
  scheduleTrendDraw();
});

watch(selectedTrend, () => {
  clearTrendHover();
  scheduleTrendDraw();
}, { flush: 'post' });

onMounted(() => {
  setQuickRange(QUICK_RANGES.find(range => range.id === '7d'), false);
  void load();
  resizeHandler = () => {
    if (selectedTrend.value.length) drawTrendChart();
  };
  window.addEventListener('resize', resizeHandler);
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) void load();
  }, 60 * 60 * 1000);
});

onBeforeUnmount(() => {
  requestSequence += 1;
  window.clearInterval(refreshTimer);
  window.removeEventListener('resize', resizeHandler);
});
</script>

<template>
  <main class="team-dashboard">
    <header class="team-page-header">
      <div>
        <h1>团队资源效率</h1>
        <p>按固定团队映射汇总成员持锁资源；历史数据使用同一份映射归属。</p>
      </div>
      <div class="team-data-as-of" aria-live="polite">
        <span>数据截至 {{ dataAsOfLabel }}</span>
        <span>{{ sampleLabel }} · {{ cacheLabel }}</span>
      </div>
    </header>

    <section class="team-source-notice" :class="{ warning: !dashboard?.membership?.generatedAt || dashboard?.membership?.lastError }" aria-live="polite">
      {{ mappingStatus }}
    </section>

    <section class="team-filter-section" aria-label="团队时间范围筛选">
      <div class="team-filter-trigger">
        <div>
          <span class="team-time-label">{{ timeLabel }}</span>
          <p>{{ rangeSummary }}</p>
        </div>
        <div class="team-filter-controls">
          <button type="button" class="team-secondary-button" :aria-expanded="!panelCollapsed" aria-controls="team-range-panel" @click="panelCollapsed = !panelCollapsed">{{ panelCollapsed ? '筛选' : '隐藏筛选' }}</button>
          <button type="button" class="team-primary-button" :disabled="loading" @click="load">{{ loading ? '正在加载…' : '刷新' }}</button>
        </div>
      </div>
      <div v-show="!panelCollapsed" id="team-range-panel" class="team-range-panel">
        <div class="team-quick-panel">
          <p>快捷范围</p>
          <div class="team-quick-ranges" aria-label="快捷时间范围">
            <button v-for="quick in QUICK_RANGES" :key="quick.id" type="button" :class="{ active: quickRangeId === quick.id }" :disabled="loading" @click="setQuickRange(quick)">{{ quick.label }}</button>
          </div>
        </div>
        <div class="team-absolute-panel">
          <p>时间范围</p>
          <div class="team-date-fields">
            <label>开始时间<input v-model="draftStart" type="datetime-local" step="60" /></label>
            <label>结束时间<input v-model="draftEnd" type="datetime-local" step="60" /></label>
          </div>
          <div class="team-range-actions"><button type="button" class="team-secondary-button" :disabled="loading" @click="resetRange">默认筛选</button><button type="button" class="team-primary-button" :disabled="loading" @click="applyRange">筛选</button></div>
        </div>
        <p v-if="rangeError" class="team-range-error">{{ rangeError }}</p>
      </div>
    </section>

    <p v-if="error" class="team-error">{{ error }}</p>

    <section class="team-section team-efficiency-section" aria-labelledby="team-efficiency-title">
      <div class="team-section-head">
        <div><h2 id="team-efficiency-title">团队效率</h2><p>总卡时、XPU 和显存利用率均只统计成员持锁的有效卡级样本。</p></div>
        <button type="button" class="team-secondary-button" :aria-expanded="!efficiencyCollapsed" aria-controls="team-efficiency-body" @click="efficiencyCollapsed = !efficiencyCollapsed">{{ efficiencyCollapsed ? '展开' : '收起' }}</button>
      </div>
      <div v-show="!efficiencyCollapsed" id="team-efficiency-body" class="team-efficiency-layout">
        <article class="team-efficiency-table-panel">
          <div class="team-panel-title">区间范围资源统计</div>
          <div class="team-table-wrap team-efficiency-table-wrap">
            <table>
              <thead><tr><th>团队</th><th>总卡时</th><th>XPU 利用率</th><th>显存利用率</th></tr></thead>
              <tbody>
                <tr v-for="team in teams" :key="team.id" :class="{ selected: team.id === selectedTeamId }" tabindex="0" :aria-selected="team.id === selectedTeamId" @click="selectedTeamId = team.id" @keydown.enter.prevent="selectedTeamId = team.id" @keydown.space.prevent="selectedTeamId = team.id">
                  <td>{{ team.label }}</td><td>{{ formatCardHours(team.cardHours) }}</td><td>{{ formatPercent(team.xpu) }}</td><td>{{ formatPercent(team.memory) }}</td>
                </tr>
                <tr v-if="!loading && !teams.length"><td colspan="4">暂无团队数据</td></tr>
              </tbody>
            </table>
          </div>
          <p v-if="!totalCardHours && !loading" class="team-empty-inline">该范围内暂无可用于团队归属的有效卡级样本。</p>
        </article>
        <aside class="team-pie-card" aria-label="团队总卡时占比">
          <div class="team-panel-title">团队总卡时占比</div>
          <svg v-if="totalCardHours" class="team-pie-chart" viewBox="0 0 160 160" role="img" aria-label="按团队划分的总卡时占比">
            <circle v-for="segment in pieSegments" :key="segment.id" cx="80" cy="80" r="42" fill="none" :stroke="segment.color" stroke-width="22" :stroke-dasharray="segment.dasharray" :stroke-dashoffset="segment.dashoffset" transform="rotate(-90 80 80)" />
            <text x="80" y="76" class="team-pie-total">{{ totalCardHours.toFixed(1) }}</text><text x="80" y="94" class="team-pie-caption">卡时</text>
          </svg>
          <p v-else class="team-pie-empty">暂无有效卡时数据</p>
          <div v-if="totalCardHours" class="team-pie-legend">
            <span v-for="segment in pieSegments" :key="segment.id"><i :style="{ backgroundColor: segment.color }"></i>{{ segment.label }} {{ (segment.percent * 100).toFixed(1) }}%</span>
          </div>
        </aside>
      </div>
    </section>

    <section class="team-team-control" aria-label="当前团队选择">
      <label for="team-select">选择团队</label>
      <select id="team-select" v-model="selectedTeamId" :disabled="loading || !teams.length">
        <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.label }}</option>
      </select>
      <span>历史平均指标截至 {{ dataAsOfLabel }}</span>
    </section>

    <section class="team-snapshot-section" :aria-label="`${selectedTeam?.label || '团队'} ${averagePeriodLabel}历史平均指标`">
      <div class="team-snapshot-grid team-snapshot-primary">
        <article v-for="metric in historicalMetrics.slice(0, 3)" :key="metric.label" class="team-metric-card" :class="metric.tone"><p>{{ metric.label }}</p><strong>{{ metric.value }}</strong></article>
      </div>
      <div class="team-snapshot-grid team-snapshot-secondary">
        <article v-for="metric in historicalMetrics.slice(3)" :key="metric.label" class="team-metric-card" :class="metric.tone"><p>{{ metric.label }}</p><strong>{{ metric.value }}</strong></article>
      </div>
    </section>

    <section class="team-section" aria-labelledby="team-trend-title">
      <div class="team-section-head"><div><h2 id="team-trend-title">{{ selectedTeam?.label || '团队' }} 资源利用率 / 占用卡数趋势</h2><p>{{ timeLabel }}，截至 {{ dataAsOfLabel }}，{{ sampleLabel }}；XPU 与显存利用率使用左侧百分比轴，占用卡数使用右侧数量轴。</p></div></div>
      <div class="team-chart-wrap">
        <div v-if="trendHasSamples" class="team-chart-surface">
          <canvas ref="trendCanvas" class="team-chart" role="img" :aria-label="`${selectedTeam?.label || '团队'} XPU 利用率、显存利用率和占用卡数趋势`" @pointerdown="handleTrendPointer" @pointermove="handleTrendPointer" @pointerleave="clearTrendHover"></canvas>
          <div v-if="hoveredTrendPoint" ref="trendTooltip" class="team-chart-tooltip" :style="trendTooltipStyle">
            <strong class="team-tooltip-time">{{ formatTrendTime(hoveredTrendPoint) }}</strong>
            <div class="team-tooltip-section" aria-label="资源趋势">
              <div class="team-tooltip-row"><span><i class="xpu"></i>XPU 利用率</span><b class="xpu">{{ formatPercent(hoveredTrendPoint.xpu) }}</b></div>
              <div class="team-tooltip-row"><span><i class="memory"></i>显存利用率</span><b class="memory">{{ formatPercent(hoveredTrendPoint.memory) }}</b></div>
              <div class="team-tooltip-row"><span><i class="cards"></i>占用卡数</span><b class="cards">{{ formatCards(hoveredTrendPoint.lockedCards) }}</b></div>
            </div>
            <div class="team-tooltip-section team-tooltip-locks" aria-label="锁定资源">
              <div class="team-tooltip-row"><span>锁定节点数</span><b>{{ formatCount(hoveredTrendPoint.lockedNodes) }}</b></div>
              <div class="team-tooltip-row"><span>锁定人数</span><b>{{ formatCount(hoveredTrendPoint.lockedUsers) }}</b></div>
            </div>
          </div>
        </div>
        <div v-else class="team-chart-empty">{{ loading ? '正在加载趋势数据' : '所选团队在此范围内暂无有效卡级样本' }}</div>
      </div>
      <div class="team-legend"><span><i class="xpu"></i>XPU 利用率</span><span><i class="memory"></i>显存利用率</span><span><i class="cards"></i>占用卡数</span></div>
    </section>

    <section class="team-section" aria-labelledby="team-ranking-title">
      <div class="team-section-head"><div><h2 id="team-ranking-title">{{ selectedTeam?.label || '团队' }} 持锁人资源使用排名 <span class="team-range-badge">{{ timeLabel }}</span></h2><p>按 XPU 利用率从低到高排列，用于定位持锁但低计算负载的使用者。</p></div></div>
      <div class="team-table-wrap">
        <table>
          <thead><tr><th>持锁人</th><th>区间总卡时</th><th>XPU 利用率</th><th>显存利用率</th></tr></thead>
          <tbody>
            <tr v-for="row in selectedRankings" :key="row.userId"><td>{{ row.userId }}</td><td>{{ formatCardHours(row.cardHours) }}</td><td>{{ formatPercent(row.xpu) }}</td><td>{{ formatPercent(row.memory) }}</td></tr>
            <tr v-if="!loading && !selectedRankings.length"><td colspan="4">所选团队在此范围内暂无持锁人有效样本</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <p v-if="dashboard?.dataQuality?.conflictCardSamples || dashboard?.dataQuality?.occupancyFailureCount || dashboard?.dataQuality?.stateFailureCount" class="team-quality-warning">已排除 {{ dashboard.dataQuality.conflictCardSamples }} 个多人冲突卡样本；{{ dashboard.dataQuality.occupancyFailureCount }} 个 Lock Bot 历史请求未完成；{{ dashboard.dataQuality.stateFailureCount }} 个当前状态请求未完成。</p>
  </main>
</template>
