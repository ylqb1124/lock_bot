<template>
  <main v-loading="loading" class="report-page">
    <section v-if="error" class="report-error">
      <el-result icon="warning" :title="$t('publicReport.unavailable')" :sub-title="error">
        <template #extra><el-button type="primary" @click="loadReport()">{{ $t('common.refresh') }}</el-button></template>
      </el-result>
    </section>

    <template v-else-if="report">
      <header class="report-header">
        <div>
          <p class="report-kicker">LockBot · {{ report.bot.type }}</p>
          <h1>{{ report.bot.name }}</h1>
          <p class="report-updated">
            {{ $t('publicReport.updatedAt') }} {{ formatDate(report.generated_at) }}
            <el-tag v-if="report.cached" size="small" type="info" effect="plain">{{ $t('publicReport.cached') }}</el-tag>
          </p>
        </div>
        <el-button type="primary" :loading="refreshing" @click="loadReport(true)">
          <el-icon><Refresh /></el-icon>{{ $t('publicReport.refreshNow') }}
        </el-button>
      </header>

      <section class="summary-grid">
        <article class="summary-card"><span>{{ $t('publicReport.total') }}</span><strong>{{ report.summary.total_resources }}</strong></article>
        <article class="summary-card summary-card--idle"><span>{{ $t('publicReport.unlocked') }}</span><strong>{{ report.summary.unlocked_resources }}</strong></article>
        <article class="summary-card summary-card--free"><span>{{ $t('publicReport.gpuFree') }}</span><strong>{{ report.summary.free_resources }}</strong></article>
      </section>

      <p class="report-note">{{ $t('publicReport.refreshHint', { seconds: report.cache_seconds }) }}</p>

      <section v-if="report.bot.type === 'DEVICE'" class="node-grid">
        <article v-for="node in report.nodes" :key="node.name" class="node-card">
          <header class="node-header">
            <div>
              <h2><el-icon><Monitor /></el-icon>{{ node.name }}</h2>
              <span>{{ node.ip || '-' }}</span>
            </div>
            <StatusTag :status="node.gpu_status" />
          </header>
          <div class="device-grid">
            <div v-for="device in node.devices" :key="device.id" class="device-item">
              <div class="device-title"><b>dev{{ device.id }}</b><span>{{ device.model }}</span><StatusTag :status="device.gpu_status" /></div>
              <div class="device-meta"><span>{{ formatUsers(device.users) }}</span><span>{{ formatRemaining(device.remaining_seconds) }}</span></div>
              <div class="device-meta"><span>{{ formatPercent(device.util) }}/{{ formatPercent(device.mem) }}</span><span>{{ device.container || '--' }}</span></div>
            </div>
          </div>
        </article>
      </section>

      <section v-else class="node-table-wrap">
        <el-table :data="report.nodes" stripe>
          <el-table-column :label="$t('publicReport.node')" min-width="160"><template #default="{ row }"><b>{{ row.name }}</b><br /><span class="muted">{{ row.ip || '-' }}</span></template></el-table-column>
          <el-table-column :label="$t('publicReport.lockedBy')" min-width="150"><template #default="{ row }">{{ formatUsers(row.users) }}</template></el-table-column>
          <el-table-column v-if="report.bot.type === 'QUEUE'" :label="$t('publicReport.booking')" min-width="150"><template #default="{ row }">{{ formatUsers(row.bookings) }}</template></el-table-column>
          <el-table-column :label="$t('publicReport.remaining')" min-width="100"><template #default="{ row }">{{ formatRemaining(firstRemaining(row.users)) }}</template></el-table-column>
          <el-table-column label="XPU/MEM" min-width="110"><template #default="{ row }">{{ formatPercent(row.util) }}/{{ formatPercent(row.mem) }}</template></el-table-column>
          <el-table-column :label="$t('publicReport.container')" min-width="160"><template #default="{ row }">{{ row.container || '--' }}</template></el-table-column>
        </el-table>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Monitor, Refresh } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()
const report = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const now = ref(Date.now())
let pollTimer
let clockTimer

const StatusTag = defineComponent({
  props: { status: { type: String, default: 'na' } },
  setup(props) {
    return () => h('span', { class: ['status-tag', `status-tag--${props.status}`] }, props.status.toUpperCase())
  },
})

const botId = computed(() => route.params.botId)

async function loadReport(manual = false) {
  if (!botId.value) return
  if (manual) refreshing.value = true
  else loading.value = !report.value
  error.value = ''
  try {
    const response = await fetch(`/api/public/reports/${encodeURIComponent(botId.value)}${manual ? '/refresh' : ''}`, { method: manual ? 'POST' : 'GET' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.detail || t('publicReport.loadFailed'))
    report.value = body
  } catch (err) {
    error.value = err.message || t('publicReport.loadFailed')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '--'
}

function formatPercent(value) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '--'
}

function formatUsers(users) {
  if (!users?.length) return '--'
  return users.map((user) => user.id || '--').join('、')
}

function firstRemaining(users) {
  const values = (users || []).map((user) => user.remaining_seconds).filter((value) => value !== null && value !== undefined)
  return values.length ? Math.min(...values) : null
}

function formatRemaining(seconds) {
  // Depend on the local clock so an already loaded report still counts down.
  void now.value
  if (seconds === null || seconds === undefined) return '--'
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(report.value?.generated_at || Date.now()).getTime()) / 1000))
  const remaining = Math.max(0, seconds - elapsed)
  if (remaining < 60) return `${remaining}s`
  if (remaining < 3600) return `${Math.ceil(remaining / 60)}m`
  return `${(remaining / 3600).toFixed(1)}h`
}

onMounted(() => {
  loadReport()
  pollTimer = window.setInterval(() => loadReport(), 30_000)
  clockTimer = window.setInterval(() => { now.value = Date.now() }, 1_000)
})

onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  window.clearInterval(clockTimer)
})
</script>

<style scoped>
.report-page { max-width: 1360px; margin: 0 auto; min-height: 100vh; padding: 32px 24px 56px; background: #f6f8fc; color: #1f2937; }
.report-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 20px; }
.report-kicker { margin: 0 0 6px; color: #64748b; font-size: 13px; font-weight: 600; letter-spacing: .06em; }
h1 { margin: 0; font-size: 30px; } .report-updated { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; color: #64748b; font-size: 14px; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.summary-card { padding: 20px; border-radius: 14px; background: #fff; box-shadow: 0 4px 16px rgb(15 23 42 / 6%); }.summary-card span { color: #64748b; font-size: 14px; }.summary-card strong { display: block; margin-top: 6px; font-size: 30px; }.summary-card--idle strong { color: #2563eb; }.summary-card--free strong { color: #16a34a; }
.report-note { margin: 14px 0 22px; color: #64748b; font-size: 13px; }.node-grid { display: grid; gap: 18px; }.node-card, .node-table-wrap { overflow: hidden; border-radius: 14px; background: #fff; box-shadow: 0 4px 16px rgb(15 23 42 / 6%); }.node-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e5e7eb; }.node-header h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; font-size: 18px; }.node-header span { color: #64748b; font-size: 13px; }
.device-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }.device-item { min-width: 0; padding: 13px 16px; border-right: 1px solid #edf0f5; border-bottom: 1px solid #edf0f5; }.device-title, .device-meta { display: flex; align-items: center; gap: 8px; justify-content: space-between; }.device-title span, .device-meta { color: #64748b; font-size: 13px; }.device-meta { margin-top: 7px; overflow: hidden; }.device-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.status-tag { padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; }.status-tag--free { color: #15803d; background: #dcfce7; }.status-tag--partial { color: #b45309; background: #fef3c7; }.status-tag--busy, .status-tag--exclusive { color: #b91c1c; background: #fee2e2; }.status-tag--na, .status-tag--idle { color: #475569; background: #e2e8f0; }.status-tag--shared { color: #a16207; background: #fef9c3; }.muted { color: #64748b; font-size: 12px; }
@media (max-width: 700px) { .report-page { padding: 20px 14px 36px; }.report-header { align-items: stretch; flex-direction: column; }.summary-grid { gap: 10px; }.summary-card { padding: 14px; }.summary-card strong { font-size: 24px; }.device-grid { grid-template-columns: 1fr; }.device-item { border-right: 0; }.node-table-wrap { overflow-x: auto; } }
</style>
