<template>
  <div class="policy-editor">
    <div v-for="(policy, index) in policies" :key="index" class="policy-row">
      <el-time-picker
        :model-value="policy.start_time"
        format="HH:mm"
        value-format="HH:mm"
        :clearable="false"
        class="policy-time"
        @update:model-value="updatePolicy(index, 'start_time', $event)"
      />
      <span class="policy-separator">-</span>
      <el-time-picker
        :model-value="policy.end_time"
        format="HH:mm"
        value-format="HH:mm"
        :clearable="false"
        class="policy-time"
        @update:model-value="updatePolicy(index, 'end_time', $event)"
      />
      <el-input-number
        :model-value="policy.max_lock_count"
        :min="-1"
        :max="16"
        :step="1"
        :value-on-clear="-1"
        controls-position="right"
        class="policy-count"
        @update:model-value="updatePolicy(index, 'max_lock_count', $event)"
      />
      <el-input-number
        :model-value="policy.max_lock_duration"
        :min="-1"
        :max="604800"
        :step="300"
        :value-on-clear="-1"
        controls-position="right"
        class="policy-duration"
        @update:model-value="updatePolicy(index, 'max_lock_duration', $event)"
      />
      <el-button
        :icon="Delete"
        text
        type="danger"
        :aria-label="$t('botCreate.removeLockPolicy')"
        @click="removePolicy(index)"
      />
    </div>
    <div v-if="policies.length" class="policy-column-labels">
      <span></span>
      <span></span>
      <span>{{ $t('botCreate.maxLockCount') }}</span>
      <span>{{ $t('botCreate.maxLockDuration') }}</span>
      <span></span>
    </div>
    <el-button class="policy-add" @click="addPolicy">
      <el-icon><Plus /></el-icon>
      {{ $t('botCreate.addLockPolicy') }}
    </el-button>
    <div v-if="error" class="policy-error">{{ error }}</div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Delete, Plus } from '@element-plus/icons-vue'

const { t } = useI18n()
const props = defineProps({
  modelValue: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])
const error = ref('')
const policies = computed(() => props.modelValue || [])

function updatePolicy(index, key, value) {
  const next = policies.value.map((policy) => ({ ...policy }))
  next[index][key] = value
  error.value = ''
  emit('update:modelValue', next)
}

function addPolicy() {
  emit('update:modelValue', [
    ...policies.value,
    { start_time: '08:00', end_time: '22:00', max_lock_count: 2, max_lock_duration: 7200 },
  ])
  error.value = ''
}

function removePolicy(index) {
  emit(
    'update:modelValue',
    policies.value.filter((_, policyIndex) => policyIndex !== index)
  )
  error.value = ''
}

function parseMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function parts(start, end) {
  return start < end
    ? [[start, end]]
    : [
        [start, 1440],
        [0, end],
      ]
}

function validate() {
  const ranges = []
  for (let i = 0; i < policies.value.length; i++) {
    const policy = policies.value[i]
    const start = parseMinutes(policy.start_time)
    const end = parseMinutes(policy.end_time)
    const count = policy.max_lock_count
    const duration = policy.max_lock_duration
    if (start == null || end == null || start === end) {
      error.value = t('botCreate.invalidLockPolicyTime')
      return false
    }
    if (!(count === -1 || Number.isInteger(count) && count >= 1 && count <= 16)) {
      error.value = t('botCreate.invalidLockPolicyCount')
      return false
    }
    if (!(duration === -1 || Number.isInteger(duration) && duration >= 300 && duration <= 604800)) {
      error.value = t('botCreate.invalidLockPolicyDuration')
      return false
    }
    const current = parts(start, end)
    const overlaps = ranges.some((previous) =>
      previous.some(([left, leftEnd]) =>
        current.some(([right, rightEnd]) => left < rightEnd && right < leftEnd)
      )
    )
    if (overlaps) {
      error.value = t('botCreate.overlappingLockPolicies')
      return false
    }
    ranges.push(current)
  }
  error.value = ''
  return true
}

defineExpose({ validate })
</script>

<style scoped>
.policy-editor {
  width: 100%;
}
.policy-row,
.policy-column-labels {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 16px minmax(120px, 1fr) minmax(110px, 1fr) minmax(140px, 1.2fr) 32px;
  align-items: center;
  gap: 8px;
}
.policy-row {
  margin-bottom: 8px;
}
.policy-time,
.policy-count,
.policy-duration {
  width: 100%;
}
.policy-separator {
  text-align: center;
  color: var(--lb-text-secondary);
}
.policy-column-labels {
  color: var(--lb-text-secondary);
  font-size: 12px;
  margin: -2px 0 8px;
}
.policy-add {
  margin-top: 4px;
}
.policy-error {
  color: var(--el-color-danger);
  font-size: 13px;
  margin-top: 8px;
}
@media (max-width: 680px) {
  .policy-row {
    grid-template-columns: 1fr 16px 1fr 32px;
  }
  .policy-count,
  .policy-duration {
    grid-column: span 2;
  }
  .policy-column-labels {
    display: none;
  }
}
</style>
