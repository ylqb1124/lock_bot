<script setup>
import InfoTooltip from './InfoTooltip.vue';

const props = defineProps({ stats: { type: Object, required: true } });

function count(value) {
  return Number.isFinite(value) ? String(value) : '--';
}

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
}

const cards = () => [
  { label: '总节点', value: count(props.stats.totalNodes), tone: 'neutral' },
  { label: '总卡数', value: count(props.stats.totalCards), tone: 'neutral' },
  { label: 'LOCKED 节点', value: count(props.stats.lockedNodes), tone: 'locked' },
  { label: 'BUSY 节点', value: count(props.stats.busyNodes), tone: 'busy', tip: '当前 5 分钟桶内，XPU 使用率或显存利用率达到 10% 及以上的节点数。' },
  { label: 'BUSY 卡数', value: count(props.stats.busyCards), tone: 'busy', tip: '当前 5 分钟桶内，XPU 使用率或显存利用率达到 10% 及以上的卡数。' },
  { label: '节点利用率', value: percent(props.stats.lockUtilization), tone: 'primary', tip: '总 LOCKED 卡数除以总卡数。整机锁定按 8 张卡计算，单卡锁定按 1 张卡计算。' },
  { label: 'XPU', value: percent(props.stats.xpu), tone: 'metric', tip: '所选时间范围内，所有监控节点 XPU 平均利用率的均值。' },
  { label: '显存', value: percent(props.stats.memory), tone: 'metric', tip: '所选时间范围内，所有监控节点显存平均利用率的均值。' },
];
</script>

<template>
  <section class="stats-grid" aria-label="全集群统计">
    <article v-for="card in cards()" :key="card.label" class="stat-card" :class="`stat-${card.tone}`">
      <div class="stat-label">{{ card.label }}</div>
      <div class="stat-value">{{ card.value }}</div>
      <InfoTooltip v-if="card.tip" :text="card.tip" />
    </article>
  </section>
</template>
