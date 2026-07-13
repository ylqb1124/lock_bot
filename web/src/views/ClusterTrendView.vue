<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchLockBotList, fetchLockBotOccupancy, fetchLockBotState, fetchMonqueryUtilization } from '@legacy/api.js';
import { adaptNodeData } from '@legacy/adapter.js';
import { aggregateMetric, lockedCardsFromNodes, occupancyValues, replaceLiveBucket, summarize } from '../domain/clusterTrend.js';
import { buildBuckets, enumerateDates, formatMonqueryDateTime, normalizeRange, rangeForMinutes } from '../domain/timeRange.js';
import StatsCards from '../components/StatsCards.vue';
import TimeRangePicker from '../components/TimeRangePicker.vue';
import TrendChart from '../components/TrendChart.vue';

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(['expired']);

const initialRange = rangeForMinutes(24 * 60);
const range = ref(initialRange);
const loading = ref(true);
const error = ref('');
const bots = ref([]);
const meanVisible = ref(true);
const series = ref({ times: [], xpu: [], memory: [], lock: [] });
const stats = ref({ totalNodes: 0, totalCards: 0, lockedNodes: 0, busyNodes: 0, busyCards: 0, lockUtilization: null, xpu: null, memory: null });
let requestSequence = 0;
let timer;

function extractBotType(bot) {
  return String(bot.bot_type || bot.type || 'NODE').toUpperCase();
}

function uniqueNodes(nodes) {
  const byName = new Map();
  for (const node of nodes) if (!byName.has(node.name)) byName.set(node.name, node);
  return [...byName.values()];
}

function activeNode(node) {
  return Boolean(node.hasActiveLock || node.cardHasActiveLock?.some(Boolean));
}

async function load() {
  const sequence = ++requestSequence;
  loading.value = true;
  error.value = '';
  try {
    if (!bots.value.length) bots.value = await fetchLockBotList(props.token);
    const { start, end } = normalizeRange(range.value.start, range.value.end);
    const buckets = buildBuckets(start, end);
    const [stateResults, occupancyResults, monqueryResponse] = await Promise.all([
      Promise.all(bots.value.map(async bot => ({ bot, state: await fetchLockBotState(bot.id, props.token) }))),
      Promise.all(enumerateDates(start, end).flatMap(date => bots.value.map(bot => fetchLockBotOccupancy(bot.id, date, props.token).catch(() => [])))),
      fetchMonqueryUtilization(formatMonqueryDateTime(start), formatMonqueryDateTime(end)),
    ]);
    if (sequence !== requestSequence) return;

    const nowIndex = new Date().getHours() * 12 + Math.floor(new Date().getMinutes() / 5);
    const adapted = [];
    for (const { bot, state } of stateResults) {
      adapted.push(...adaptNodeData(state, monqueryResponse, nowIndex, extractBotType(bot)));
    }
    const nodes = uniqueNodes(adapted);
    const totalCards = nodes.length * 8;
    const lockedCards = lockedCardsFromNodes(nodes);
    const occupancy = occupancyResults.flat();
    const lock = replaceLiveBucket(occupancyValues(buckets, occupancy, nodes), buckets, lockedCards, totalCards);
    const xpu = aggregateMetric(monqueryResponse, 'XPU_AVERAGE_UTILIZATION', buckets);
    const memoryByCard = Array.from({ length: 8 }, (_, card) =>
      aggregateMetric(monqueryResponse, `XPU${card}_MEM_UTILIZATION`, buckets)
    );
    const memory = buckets.map((_, index) => {
      const cardValues = memoryByCard.map(values => values[index]).filter(Number.isFinite);
      return cardValues.length ? cardValues.reduce((sum, value) => sum + value, 0) / cardValues.length : null;
    });
    const xpuSummary = summarize(xpu);
    const memorySummary = summarize(memory);

    series.value = { times: buckets, xpu, memory, lock };
    stats.value = {
      totalNodes: nodes.length,
      totalCards,
      lockedNodes: nodes.filter(activeNode).length,
      busyNodes: nodes.filter(node => node.status === 'BUSY').length,
      busyCards: nodes.reduce((count, node) => count + (node.cardUtils || []).filter(card => card[Math.max(0, nowIndex - 1)] >= 10).length, 0),
      lockUtilization: totalCards ? lockedCards / totalCards * 100 : null,
      xpu: xpuSummary.average,
      memory: memorySummary.average,
    };
  } catch (caught) {
    if (sequence !== requestSequence) return;
    if (/401|403/.test(String(caught?.message))) emit('expired');
    error.value = caught?.message || '加载全集群趋势数据失败';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function changeRange(change) {
  range.value = 'minutes' in change ? rangeForMinutes(change.minutes) : normalizeRange(change.start, change.end);
  load();
}

const status = computed(() => loading.value ? '正在刷新数据' : error.value ? error.value : `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);

onMounted(() => {
  load();
  timer = window.setInterval(() => { if (!document.hidden) load(); }, 60_000);
});
onBeforeUnmount(() => { window.clearInterval(timer); requestSequence += 1; });
</script>

<template>
  <main class="dashboard">
    <header class="page-header">
      <div>
        <p class="eyebrow">开发机集群资源监控</p>
        <h1>全集群趋势</h1>
      </div>
      <div class="header-actions">
        <label class="mean-control"><input v-model="meanVisible" type="checkbox" /> 显示均值线</label>
        <span class="status" :class="{ error: error }">{{ status }}</span>
      </div>
    </header>

    <TimeRangePicker :start="range.start" :end="range.end" :loading="loading" @change="changeRange" @refresh="load" />
    <StatsCards :stats="stats" />

    <p v-if="error" class="error-message">{{ error }}</p>
    <section class="chart-stack">
      <TrendChart title="XPU 利用率趋势" :times="series.times" :values="series.xpu" color="#4f46e5" :y-max="100" :show-mean="meanVisible" :loading="loading" />
      <TrendChart title="显存利用率趋势" :times="series.times" :values="series.memory" color="#d97706" :y-max="100" :show-mean="meanVisible" :loading="loading" />
      <TrendChart title="节点利用率趋势" detail="每个五分钟桶的节点利用率等于锁定卡数除以总卡数。历史点来自 Lock Bot 占用记录；当前桶由实时 Lock Bot 状态覆盖。整机锁定按 8 张卡计算。" :times="series.times" :values="series.lock" color="#0891b2" :y-max="100" :show-mean="meanVisible" :loading="loading" />
    </section>
  </main>
</template>
