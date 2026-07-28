<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchTeamDashboard } from '../services/api.js';
import { formatChinaDatetimeLocal, formatChinaDateTime, parseChinaDatetimeLocal } from '../services/china-time.js';
import '../team-dashboard.css';

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(['expired']);

const QUICK_RANGES = [
  { id: '3h', label: '最近 3 小时', minutes: 180 },
  { id: '6h', label: '最近 6 小时', minutes: 360 },
  { id: '12h', label: '最近 12 小时', minutes: 720 },
  { id: '24h', label: '最近 24 小时', minutes: 1440 },
  { id: '2d', label: '最近 2 天', minutes: 2880 },
  { id: '7d', label: '最近 7 天', minutes: 10080 },
];
const CHART = { width: 1000, height: 280, left: 50, right: 18, top: 14, bottom: 34 };

const rangeStart = ref(null);
const rangeEnd = ref(null);
const quickRangeId = ref('7d');
const draftStart = ref('');
const draftEnd = ref('');
const panelCollapsed = ref(true);
const selectedTeamId = ref('general-research');
const dashboard = ref(null);
const loading = ref(false);
const error = ref('');
const rangeError = ref('');
let refreshTimer;
let requestSequence = 0;

const teams = computed(() => dashboard.value?.teams || []);
const selectedTeam = computed(() => teams.value.find(team => team.id === selectedTeamId.value) || teams.value.at(-1) || null);
const selectedTrend = computed(() => selectedTeam.value?.trend || []);
const selectedCurrent = computed(() => selectedTeam.value?.current || null);
const timeLabel = computed(() => QUICK_RANGES.find(range => range.id === quickRangeId.value)?.label || '自定义时间范围');
const rangeSummary = computed(() => rangeStart.value && rangeEnd.value
  ? `${formatChinaDateTime(rangeStart.value)} 至 ${formatChinaDateTime(rangeEnd.value)}`
  : '尚未选择时间范围');
const mappingStatus = computed(() => {
  const membership = dashboard.value?.membership;
  if (!membership?.generatedAt) return '尚未生成自动映射，未映射使用者暂归通用研发并标记待确认。';
  if (membership.lastError) return `最近映射更新失败：${membership.lastError.message}`;
  return `模拟映射更新于 ${formatChinaDateTime(membership.generatedAt)}，按最近七天负载特征生成。`;
});
const selectedRankings = computed(() => (dashboard.value?.rankings || []).filter(row => row.team === selectedTeamId.value));
const trendHasSamples = computed(() => selectedTrend.value.some(point => Number.isFinite(point.xpu) || Number.isFinite(point.memory) || Number.isFinite(point.lockRate)));
const chartPaths = computed(() => ({
  lock: buildPath(selectedTrend.value, 'lockRate'),
  xpu: buildPath(selectedTrend.value, 'xpu'),
  memory: buildPath(selectedTrend.value, 'memory'),
}));

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
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || duration < 3 * 60 * 60 * 1000 || duration > 7 * 24 * 60 * 60 * 1000) {
    rangeError.value = '团队视图仅支持 3 小时至 7 天的有效时间范围。';
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

function formatCardHours(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} 卡时` : '暂无有效样本';
}

function formatConfidence(value) {
  return Number.isFinite(value) && value > 0 ? `${Math.round(value * 100)}%` : '待确认';
}

function buildPath(points, field) {
  const valid = points.map((point, index) => ({ value: Number(point[field]), index })).filter(point => Number.isFinite(point.value));
  if (!valid.length) return '';
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const segments = [];
  let current = [];
  points.forEach((point, index) => {
    const value = Number(point[field]);
    if (Number.isFinite(value)) current.push({ value, index });
    else if (current.length) { segments.push(current); current = []; }
  });
  if (current.length) segments.push(current);
  return segments.map(segment => segment.map((point, index) => {
    const x = CHART.left + point.index / Math.max(1, points.length - 1) * plotWidth;
    const y = CHART.top + (1 - Math.min(100, Math.max(0, point.value)) / 100) * plotHeight;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ')).join(' ');
}

onMounted(() => {
  setQuickRange(QUICK_RANGES.find(range => range.id === '7d'), false);
  void load();
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) void load();
  }, 60 * 60 * 1000);
});

onBeforeUnmount(() => {
  requestSequence += 1;
  window.clearInterval(refreshTimer);
});
</script>

<template>
  <main class="team-dashboard">
    <header class="team-page-header">
      <div>
        <h1>团队资源效率</h1>
        <p>按当前模拟团队映射汇总成员持锁资源；历史数据使用当前映射归属。</p>
      </div>
      <div class="team-selection">
        <label for="team-select">查看团队</label>
        <select id="team-select" v-model="selectedTeamId" :disabled="loading || !teams.length">
          <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.label }}</option>
        </select>
      </div>
    </header>

    <section class="team-source-notice" :class="{ warning: !dashboard?.membership?.generatedAt || dashboard?.membership?.lastError }" aria-live="polite">
      {{ mappingStatus }}
    </section>

    <section class="team-filter-section" aria-label="团队时间范围筛选">
      <div class="team-filter-head">
        <div><span class="team-time-label">{{ timeLabel }}</span><p>{{ rangeSummary }}</p></div>
        <div class="team-filter-controls">
          <button type="button" class="team-secondary-button" :aria-expanded="!panelCollapsed" aria-controls="team-range-panel" @click="panelCollapsed = !panelCollapsed">{{ panelCollapsed ? '点击筛选' : '隐藏筛选' }}</button>
          <button type="button" class="team-primary-button" :disabled="loading" @click="load">{{ loading ? '正在加载…' : '刷新' }}</button>
        </div>
      </div>
      <div v-show="!panelCollapsed" id="team-range-panel" class="team-range-panel">
        <div class="team-date-fields">
          <label>开始时间<input v-model="draftStart" type="datetime-local" step="60" /></label>
          <label>结束时间<input v-model="draftEnd" type="datetime-local" step="60" /></label>
        </div>
        <div class="team-quick-ranges" aria-label="快捷时间范围">
          <button v-for="quick in QUICK_RANGES" :key="quick.id" type="button" :class="{ active: quickRangeId === quick.id }" :disabled="loading" @click="setQuickRange(quick)">{{ quick.label }}</button>
        </div>
        <div class="team-range-actions"><button type="button" class="team-secondary-button" :disabled="loading" @click="resetRange">默认筛选</button><button type="button" class="team-primary-button" :disabled="loading" @click="applyRange">应用时间范围</button></div>
        <p v-if="rangeError" class="team-range-error">{{ rangeError }}</p>
      </div>
    </section>

    <p v-if="error" class="team-error">{{ error }}</p>

    <section class="team-section" aria-labelledby="team-efficiency-title">
      <div class="team-section-head"><div><h2 id="team-efficiency-title">团队效率</h2><p>卡时与两项利用率均只统计团队成员持锁的有效卡级样本。</p></div></div>
      <div class="team-table-wrap">
        <table>
          <thead><tr><th>团队</th><th>区间总卡时</th><th>XPU 利用率</th><th>显存利用率</th><th>使用者</th><th>待确认</th></tr></thead>
          <tbody>
            <tr v-for="team in teams" :key="team.id" :class="{ selected: team.id === selectedTeamId }" @click="selectedTeamId = team.id">
              <td>{{ team.label }}</td><td>{{ formatCardHours(team.cardHours) }}</td><td>{{ formatPercent(team.xpu) }}</td><td>{{ formatPercent(team.memory) }}</td><td>{{ team.userCount }}</td><td>{{ team.pendingUserCount }}</td>
            </tr>
            <tr v-if="!loading && !teams.length"><td colspan="6">暂无团队数据</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="team-section" aria-labelledby="team-snapshot-title">
      <div class="team-section-head"><div><h2 id="team-snapshot-title">{{ selectedTeam?.label || '团队' }}实时快照</h2><p>取当前范围内最新的有效卡级采样点。</p></div></div>
      <div class="team-snapshot-grid">
        <article v-for="metric in [
          ['锁定节点数', formatCount(selectedCurrent?.lockedNodes)],
          ['锁定卡数', formatCount(selectedCurrent?.lockedCards)],
          ['锁定人数', formatCount(selectedCurrent?.lockedUsers)],
          ['人均锁定卡数', selectedCurrent?.lockedUsers ? (selectedCurrent.lockedCards / selectedCurrent.lockedUsers).toFixed(1) : '暂无有效样本'],
          ['XPU 利用率', formatPercent(selectedCurrent?.xpu)],
          ['显存利用率', formatPercent(selectedCurrent?.memory)],
        ]" :key="metric[0]" class="team-metric-card"><p>{{ metric[0] }}</p><strong>{{ metric[1] }}</strong></article>
      </div>
    </section>

    <section class="team-section" aria-labelledby="team-trend-title">
      <div class="team-section-head"><div><h2 id="team-trend-title">{{ selectedTeam?.label || '团队' }}三指标趋势</h2><p>节点使用率为团队锁定卡数占当时全集群有效卡数的比例；三线统一使用 0 至 100% 坐标。</p></div></div>
      <div class="team-chart-wrap">
        <svg v-if="trendHasSamples" class="team-chart" :viewBox="`0 0 ${CHART.width} ${CHART.height}`" role="img" :aria-label="`${selectedTeam?.label || '团队'} 三指标趋势`">
          <g class="team-chart-grid"><line v-for="tick in [0, 20, 40, 60, 80, 100]" :key="tick" :x1="CHART.left" :x2="CHART.width - CHART.right" :y1="CHART.top + (100 - tick) / 100 * (CHART.height - CHART.top - CHART.bottom)" :y2="CHART.top + (100 - tick) / 100 * (CHART.height - CHART.top - CHART.bottom)" /><text v-for="tick in [0, 20, 40, 60, 80, 100]" :key="`label-${tick}`" x="4" :y="CHART.top + (100 - tick) / 100 * (CHART.height - CHART.top - CHART.bottom) + 4">{{ tick }}%</text></g>
          <path class="team-chart-line lock" :d="chartPaths.lock" /><path class="team-chart-line xpu" :d="chartPaths.xpu" /><path class="team-chart-line memory" :d="chartPaths.memory" />
          <text class="team-chart-time" :x="CHART.left" :y="CHART.height - 8">{{ rangeStart ? formatChinaDateTime(rangeStart) : '' }}</text><text class="team-chart-time end" :x="CHART.width - CHART.right" :y="CHART.height - 8">{{ rangeEnd ? formatChinaDateTime(rangeEnd) : '' }}</text>
        </svg>
        <div v-else class="team-chart-empty">{{ loading ? '正在加载趋势数据' : '所选团队在此范围内暂无有效卡级样本' }}</div>
      </div>
      <div class="team-legend"><span><i class="lock"></i>节点使用率</span><span><i class="xpu"></i>XPU 利用率</span><span><i class="memory"></i>显存利用率</span></div>
    </section>

    <section class="team-section" aria-labelledby="team-ranking-title">
      <div class="team-section-head"><div><h2 id="team-ranking-title">{{ selectedTeam?.label || '团队' }}持锁人资源使用排名</h2><p>按 XPU 利用率从低到高排列，用于定位持锁但低计算负载的使用者。</p></div></div>
      <div class="team-table-wrap">
        <table>
          <thead><tr><th>持锁人</th><th>区间总卡时</th><th>XPU 利用率</th><th>显存利用率</th><th>置信度</th><th>归属状态</th></tr></thead>
          <tbody>
            <tr v-for="row in selectedRankings" :key="row.userId"><td>{{ row.userId }}</td><td>{{ formatCardHours(row.cardHours) }}</td><td>{{ formatPercent(row.xpu) }}</td><td>{{ formatPercent(row.memory) }}</td><td>{{ formatConfidence(row.confidence) }}</td><td>{{ row.pending ? '待确认' : (row.source === 'manual' ? '人工指定' : '自动归类') }}</td></tr>
            <tr v-if="!loading && !selectedRankings.length"><td colspan="6">所选团队在此范围内暂无持锁人有效样本</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <p v-if="dashboard?.dataQuality?.conflictCardSamples || dashboard?.dataQuality?.occupancyFailureCount || dashboard?.dataQuality?.stateFailureCount" class="team-quality-warning">已排除 {{ dashboard.dataQuality.conflictCardSamples }} 个多人冲突卡样本；{{ dashboard.dataQuality.occupancyFailureCount }} 个 Lock Bot 历史请求未完成；{{ dashboard.dataQuality.stateFailureCount }} 个当前状态请求未完成。</p>
  </main>
</template>
