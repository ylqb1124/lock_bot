<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import InfoTooltip from './InfoTooltip.vue';

const props = defineProps({
  title: { type: String, required: true },
  detail: String,
  times: { type: Array, required: true },
  values: { type: Array, required: true },
  color: { type: String, required: true },
  yMax: { type: Number, default: 100 },
  showMean: Boolean,
  loading: Boolean,
});

const canvas = ref(null);
const hover = ref(null);
let observer;
const padding = { top: 18, right: 22, bottom: 32, left: 44 };
const mean = computed(() => {
  const values = props.values.filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
});
const peak = computed(() => {
  const values = props.values.filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
});

function dimensions() {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  element.width = Math.max(1, Math.floor(rect.width * dpr));
  element.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = element.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function xAt(index, width) {
  const plotWidth = width - padding.left - padding.right;
  return padding.left + (props.values.length <= 1 ? 0 : index / (props.values.length - 1) * plotWidth);
}

function yAt(value, height) {
  const plotHeight = height - padding.top - padding.bottom;
  return padding.top + (1 - Math.max(0, Math.min(props.yMax, value)) / props.yMax) * plotHeight;
}

function draw() {
  const surface = dimensions();
  if (!surface) return;
  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.strokeStyle = '#e2e8f0';
  ctx.fillStyle = '#64748b';
  ctx.lineWidth = 1;
  for (let value = 0; value <= props.yMax; value += props.yMax / 4) {
    const y = yAt(value, height);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'right'; ctx.fillText(`${Math.round(value)}%`, padding.left - 7, y + 4);
  }

  if (props.showMean && mean.value !== null) {
    const y = yAt(mean.value, height);
    ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
  }

  let started = false;
  ctx.strokeStyle = props.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  props.values.forEach((value, index) => {
    if (!Number.isFinite(value)) { started = false; return; }
    const x = xAt(index, width); const y = yAt(value, height);
    if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
  });
  ctx.stroke();

  if (hover.value !== null && Number.isFinite(props.values[hover.value])) {
    const x = xAt(hover.value, width); const y = yAt(props.values[hover.value], height);
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padding.top); ctx.lineTo(x, height - padding.bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = props.color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

function handleMove(event) {
  if (!props.times.length || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const ratio = (event.clientX - rect.left - padding.left) / (rect.width - padding.left - padding.right);
  hover.value = Math.max(0, Math.min(props.times.length - 1, Math.round(ratio * (props.times.length - 1))));
  draw();
}

function handleLeave() { hover.value = null; draw(); }

const hoverLabel = computed(() => {
  if (hover.value === null || !Number.isFinite(props.values[hover.value])) return null;
  return `${new Date(props.times[hover.value] * 1000).toLocaleString('zh-CN', { hour12: false })} ${props.values[hover.value].toFixed(1)}%`;
});

watch(() => [props.times, props.values, props.showMean], () => nextTick(draw), { deep: true });
onMounted(() => { observer = new ResizeObserver(draw); observer.observe(canvas.value); draw(); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="chart-panel">
    <header class="chart-header">
      <h2 class="chart-title">{{ title }} <InfoTooltip v-if="detail" :text="detail" /></h2>
      <div class="chart-metrics">
        <span>峰值 {{ peak === null ? '--' : `${peak.toFixed(1)}%` }}</span>
        <span v-if="showMean" class="mean-legend"><i />均值线 {{ mean === null ? '--' : `${mean.toFixed(1)}%` }}</span>
      </div>
    </header>
    <div class="chart-canvas-wrap">
      <canvas ref="canvas" @mousemove="handleMove" @mouseleave="handleLeave" />
      <div v-if="loading" class="chart-overlay">加载中...</div>
      <div v-else-if="!values.some(Number.isFinite)" class="chart-overlay">所选范围暂无数据</div>
      <div v-if="hoverLabel" class="chart-hover">{{ hoverLabel }}</div>
    </div>
  </section>
</template>
