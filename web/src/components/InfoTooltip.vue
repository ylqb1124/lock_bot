<script setup>
import { ref } from 'vue';

defineProps({ text: { type: String, required: true } });
const open = ref(false);
</script>

<template>
  <span class="info-tooltip">
    <button
      type="button"
      class="info-trigger"
      aria-label="查看计算说明"
      :aria-expanded="open"
      @click.stop="open = !open"
      @blur="open = false"
    >?</button>
    <span v-if="open" class="info-popup" role="tooltip">{{ text }}</span>
  </span>
</template>
