<template>
  <div class="policy-editor">
    <div v-for="(policy, index) in policies" :key="index" class="policy-row">
      <div class="policy-main-row">
        <div class="policy-field policy-time-field">
          <span class="policy-field-label">{{ $t('botCreate.policyStartTime') }}</span>
          <div class="policy-time-range">
            <el-time-picker
              :model-value="policy.start_time"
              format="HH:mm"
              value-format="HH:mm"
              :clearable="false"
              @update:model-value="updatePolicy(index, 'start_time', $event)"
            />
            <span class="policy-separator">-</span>
            <el-time-picker
              :model-value="policy.end_time"
              format="HH:mm"
              value-format="HH:mm"
              :clearable="false"
              @update:model-value="updatePolicy(index, 'end_time', $event)"
            />
          </div>
        </div>
        <div class="policy-field">
          <span class="policy-field-label">{{ $t('botCreate.maxLockCount') }}</span>
          <el-input-number
            :model-value="policy.max_lock_count"
            :min="-1"
            :max="16"
            :step="1"
            :value-on-clear="-1"
            controls-position="right"
            @update:model-value="updatePolicy(index, 'max_lock_count', $event)"
          />
        </div>
        <div class="policy-field">
          <span class="policy-field-label">{{ $t('botCreate.lockPolicyDurationHours') }}</span>
          <el-input-number
            :model-value="secondsToHours(policy.max_lock_duration)"
            :min="-1"
            :max="168"
            :step="0.5"
            :value-on-clear="-1"
            controls-position="right"
            @update:model-value="updateDuration(index, $event)"
          />
        </div>
        <el-button
          :icon="Delete"
          text
          type="danger"
          :aria-label="$t('botCreate.removeLockPolicy')"
          @click="removePolicy(index)"
        />
      </div>
      <div class="policy-weekdays-row">
        <span class="policy-field-label">{{ $t('botCreate.policyWeekdays') }}</span>
        <el-checkbox-group
          :model-value="policy.weekdays || weekdays"
          class="policy-weekdays"
          @update:model-value="updatePolicy(index, 'weekdays', $event)"
        >
          <el-checkbox-button v-for="day in weekdays" :key="day" :value="day">
            {{ $t(`botCreate.weekday${day[0].toUpperCase()}${day.slice(1)}`) }}
          </el-checkbox-button>
        </el-checkbox-group>
      </div>
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
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function updatePolicy(index, key, value) {
  const next = policies.value.map((policy) => ({ ...policy }))
  next[index][key] = value
  error.value = ''
  emit('update:modelValue', next)
}

function secondsToHours(seconds) {
  return seconds === -1 ? -1 : Number((seconds / 3600).toFixed(4))
}

function updateDuration(index, hours) {
  updatePolicy(index, 'max_lock_duration', hours === -1 ? -1 : Math.round(hours * 3600))
}

function addPolicy() {
  emit('update:modelValue', [
    ...policies.value,
    {
      start_time: '08:00',
      end_time: '22:00',
      weekdays: [...weekdays],
      max_lock_count: 2,
      max_lock_duration: 7200,
    },
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

function parts(start, end, selectedWeekdays) {
  return selectedWeekdays.flatMap((day) => {
    const dayIndex = weekdays.indexOf(day)
    if (start < end) return [[dayIndex, start, end]]
    return [
      [dayIndex, start, 1440],
      [(dayIndex + 1) % 7, 0, end],
    ]
  })
}

function validate() {
  const ranges = []
  for (let i = 0; i < policies.value.length; i++) {
    const policy = policies.value[i]
    const start = parseMinutes(policy.start_time)
    const end = parseMinutes(policy.end_time)
    const count = policy.max_lock_count
    const duration = policy.max_lock_duration
    const selectedWeekdays = policy.weekdays || weekdays
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
    if (!Array.isArray(selectedWeekdays) || !selectedWeekdays.length || new Set(selectedWeekdays).size !== selectedWeekdays.length || selectedWeekdays.some((day) => !weekdays.includes(day))) {
      error.value = t('botCreate.invalidLockPolicyWeekdays')
      return false
    }
    const current = parts(start, end, selectedWeekdays)
    const overlaps = ranges.some((previous) =>
      previous.some(([leftDay, left, leftEnd]) =>
        current.some(([rightDay, right, rightEnd]) => leftDay === rightDay && left < rightEnd && right < leftEnd)
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
.policy-row {
  border: 1px solid var(--el-border-color-light);
  margin-bottom: 10px;
  padding: 12px;
}
.policy-main-row,
.policy-weekdays-row,
.policy-time-range { display: flex; align-items: end; gap: 10px; }
.policy-main-row { display: grid; grid-template-columns: minmax(260px, 1.5fr) minmax(110px, 0.6fr) minmax(140px, 0.8fr) 32px; }
.policy-field { display: grid; gap: 5px; min-width: 0; }
.policy-time-field { min-width: 260px; }
.policy-time-range { gap: 6px; }
.policy-time-range :deep(.el-date-editor),
.policy-field :deep(.el-input-number) { width: 100%; }
.policy-field-label { color: var(--lb-text-secondary); font-size: 12px; }
.policy-weekdays {
  display: flex;
  flex-wrap: wrap;
}
.policy-separator {
  text-align: center;
  color: var(--lb-text-secondary);
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
  .policy-main-row { grid-template-columns: 1fr 32px; }
  .policy-time-field { grid-column: 1 / -1; min-width: 0; }
  .policy-weekdays-row { align-items: start; flex-direction: column; }
}
</style>
