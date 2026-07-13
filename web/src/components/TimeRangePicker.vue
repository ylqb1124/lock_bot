<script setup>
import { computed, ref, watch } from 'vue';
import { QUICK_RANGES, toDatetimeLocalValue } from '../domain/timeRange.js';

const props = defineProps({ start: { type: Date, required: true }, end: { type: Date, required: true }, loading: Boolean });
const emit = defineEmits(['change', 'refresh']);
const draftStart = ref(toDatetimeLocalValue(props.start));
const draftEnd = ref(toDatetimeLocalValue(props.end));

watch(() => [props.start, props.end], ([start, end]) => {
  draftStart.value = toDatetimeLocalValue(start);
  draftEnd.value = toDatetimeLocalValue(end);
});

const summary = computed(() => `${props.start.toLocaleString('zh-CN', { hour12: false })} 至 ${props.end.toLocaleString('zh-CN', { hour12: false })}`);

function apply() {
  const start = new Date(draftStart.value);
  const end = new Date(draftEnd.value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return;
  emit('change', { start, end });
}

function reset() {
  draftStart.value = toDatetimeLocalValue(props.start);
  draftEnd.value = toDatetimeLocalValue(props.end);
}
</script>

<template>
  <section class="range-panel" aria-label="全集群趋势筛选">
    <div class="range-panel-main">
      <div class="range-absolute">
        <h2>自定义时间范围</h2>
        <div class="range-inputs">
          <label>开始时间<input v-model="draftStart" type="datetime-local" :disabled="loading" /></label>
          <label>结束时间<input v-model="draftEnd" type="datetime-local" :disabled="loading" /></label>
        </div>
        <div class="range-actions">
          <button type="button" title="还原输入" :disabled="loading" @click="reset">还原</button>
          <button type="button" class="primary-button" :disabled="loading" @click="apply">应用范围</button>
        </div>
      </div>
      <div class="range-quick">
        <h2>快捷范围</h2>
        <div class="quick-buttons">
          <button v-for="range in QUICK_RANGES" :key="range.minutes" type="button" :disabled="loading" @click="emit('change', { minutes: range.minutes })">{{ range.label }}</button>
        </div>
      </div>
    </div>
    <footer class="range-footer">
      <span>当前范围：{{ summary }}</span>
      <button type="button" class="refresh-button" :disabled="loading" @click="emit('refresh')">{{ loading ? '刷新中...' : '刷新' }}</button>
    </footer>
  </section>
</template>
