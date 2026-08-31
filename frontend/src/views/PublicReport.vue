<template>
  <main v-loading="loading" class="report-page">
    <section v-if="error" class="report-error">
      <el-result icon="warning" :title="$t('publicReport.unavailable')" :sub-title="error">
        <template #extra><el-button type="primary" @click="loadReport()">{{ $t('common.refresh') }}</el-button></template>
      </el-result>
    </section>

    <template v-else-if="report">
      <section class="report-hero" :class="`report-hero--${overallTone}`">
        <div class="hero-orb hero-orb--one"></div><div class="hero-orb hero-orb--two"></div>
        <div class="hero-content">
          <div class="hero-title-row"><div class="report-brand"><el-icon><Connection /></el-icon> LockBot</div><span class="live-indicator"><i></i>{{ $t('publicReport.live') }}</span></div>
          <div class="hero-heading">
            <div class="hero-status-icon"><el-icon><component :is="overallIcon" /></el-icon></div>
            <div><p class="report-kicker">{{ report.bot.type }} · {{ $t('publicReport.machineReport') }}</p><h1>{{ report.bot.name }}</h1><p class="overall-message">{{ overallLabel }}</p></div>
          </div>
        </div>
        <div class="hero-actions"><p>{{ $t('publicReport.updatedAt') }}</p><strong>{{ formatDate(report.generated_at) }}</strong><div class="hero-action-row"><el-tag v-if="report.cached" size="small" effect="dark">{{ $t('publicReport.cached') }}</el-tag><el-button plain :loading="refreshing" @click="loadReport(true)"><el-icon><Refresh /></el-icon>{{ $t('publicReport.refreshNow') }}</el-button></div></div>
      </section>

      <section class="summary-grid" :aria-label="$t('publicReport.summary')">
        <article class="summary-card"><div class="summary-icon summary-icon--slate"><el-icon><Cpu /></el-icon></div><div><span>{{ $t('publicReport.total') }}</span><strong>{{ report.summary.total_resources }}</strong></div><p>{{ $t('publicReport.totalHint') }}</p></article>
        <article class="summary-card summary-card--idle"><div class="summary-icon summary-icon--blue"><el-icon><CircleCheckFilled /></el-icon></div><div><span>{{ $t('publicReport.unlocked') }}</span><strong>{{ report.summary.unlocked_resources }}</strong></div><p>{{ $t('publicReport.unlockedHint', { percent: unlockedPercent }) }}</p></article>
        <article class="summary-card summary-card--free"><div class="summary-icon summary-icon--green"><el-icon><DataAnalysis /></el-icon></div><div><span>{{ $t('publicReport.gpuFree') }}</span><strong>{{ report.summary.free_resources }}</strong></div><p>{{ $t('publicReport.gpuFreeHint', { percent: freePercent }) }}</p></article>
      </section>

      <div class="section-heading"><div><p class="section-eyebrow">{{ $t('publicReport.resourceStatus') }}</p><h2>{{ $t('publicReport.machineOverview') }}</h2></div><p class="report-note"><el-icon><Clock /></el-icon>{{ $t('publicReport.refreshHint', { seconds: report.cache_seconds }) }}</p></div>

      <section v-if="report.bot.type === 'DEVICE'" class="node-grid">
        <article v-for="node in report.nodes" :key="node.name" class="node-card">
          <header class="node-header"><div class="node-identity"><div class="node-icon"><el-icon><Monitor /></el-icon></div><div><h3>{{ node.name }}</h3><span>{{ node.ip || $t('publicReport.ipUnavailable') }}</span></div></div><div class="node-status"><StatusTag :status="node.lock_status" /><StatusTag :status="node.gpu_status" /><small>{{ $t('publicReport.memory') }} <b>{{ formatPercent(node.mem) }}</b></small></div></header>
          <div class="device-grid">
            <article v-for="device in node.devices" :key="device.id" class="device-item" :class="`device-item--${device.lock_status}`">
              <div class="device-topline"><strong>GPU {{ device.id }}</strong><span class="device-tags"><StatusTag :status="device.lock_status" /><StatusTag :status="device.gpu_status" /></span></div><p class="device-model">{{ device.model || $t('publicReport.modelUnavailable') }}</p>
              <div class="device-user"><el-icon><UserFilled /></el-icon><span>{{ formatUsers(device.users) }}</span></div>
              <div class="device-metrics"><span><i class="metric-dot metric-dot--util"></i>{{ $t('publicReport.utilization') }} <b>{{ formatPercent(device.util) }}</b></span><span><i class="metric-dot metric-dot--memory"></i>{{ $t('publicReport.memory') }} <b>{{ formatPercent(device.mem) }}</b></span></div>
              <footer class="device-footer"><span><el-icon><Timer /></el-icon>{{ formatRemaining(device.remaining_seconds) }}</span><span :title="device.container">{{ device.container || '--' }}</span></footer>
            </article>
          </div>
        </article>
      </section>

      <section v-else class="node-table-wrap">
        <el-table :data="report.nodes" class="report-table">
          <el-table-column :label="$t('publicReport.node')" min-width="180"><template #default="{ row }"><div class="table-node"><span class="table-node-icon"><el-icon><Monitor /></el-icon></span><span><b>{{ row.name }}</b><small>{{ row.ip || '-' }}</small></span></div></template></el-table-column>
          <el-table-column :label="$t('publicReport.status')" min-width="115"><template #default="{ row }"><StatusTag :status="row.lock_status" /></template></el-table-column>
          <el-table-column :label="$t('publicReport.lockedBy')" min-width="160"><template #default="{ row }"><span class="table-users">{{ formatUsers(row.users) }}</span></template></el-table-column>
          <el-table-column v-if="report.bot.type === 'QUEUE'" :label="$t('publicReport.booking')" min-width="150"><template #default="{ row }">{{ formatUsers(row.bookings) }}</template></el-table-column>
          <el-table-column :label="$t('publicReport.remaining')" min-width="110"><template #default="{ row }"><span class="remaining"><el-icon><Timer /></el-icon>{{ formatRemaining(firstRemaining(row.users)) }}</span></template></el-table-column>
          <el-table-column label="XPU / MEM" min-width="130"><template #default="{ row }"><span class="table-metrics">{{ formatPercent(row.util) }} <i></i> {{ formatPercent(row.mem) }}</span></template></el-table-column>
          <el-table-column :label="$t('publicReport.container')" min-width="170"><template #default="{ row }"><span class="container-name">{{ row.container || '--' }}</span></template></el-table-column>
        </el-table>
      </section>
      <footer class="report-footer"><span><i></i>{{ $t('publicReport.autoRefresh') }}</span><span>{{ $t('publicReport.refreshHint', { seconds: report.cache_seconds }) }}</span></footer>
    </template>
  </main>
</template>

<script setup>
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { CircleCheckFilled, Clock, Connection, Cpu, DataAnalysis, Monitor, Refresh, Timer, UserFilled, WarningFilled } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'
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

const botId = computed(() => route.params.botId)
const resourceTotal = computed(() => report.value?.summary.total_resources || 0)
const unlockedPercent = computed(() => resourceTotal.value ? Math.round((report.value.summary.unlocked_resources / resourceTotal.value) * 100) : 0)
const freePercent = computed(() => resourceTotal.value ? Math.round((report.value.summary.free_resources / resourceTotal.value) * 100) : 0)
const overallTone = computed(() => {
  if (!resourceTotal.value) return 'neutral'
  if (unlockedPercent.value === 100) return 'healthy'
  if (unlockedPercent.value === 0) return 'busy'
  return 'partial'
})
const overallIcon = computed(() => overallTone.value === 'healthy' ? CircleCheckFilled : WarningFilled)
const overallLabel = computed(() => t(`publicReport.overall.${overallTone.value}`))

const StatusTag = defineComponent({
  props: { status: { type: String, default: 'na' } },
  setup(props) { return () => h('span', { class: ['status-tag', `status-tag--${props.status}`] }, t(`publicReport.statuses.${props.status}`, props.status.toUpperCase())) },
})

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
  } catch (err) { error.value = err.message || t('publicReport.loadFailed') } finally { loading.value = false; refreshing.value = false }
}

function formatDate(value) { return value ? new Date(value).toLocaleString() : '--' }
function formatPercent(value) { return typeof value === 'number' ? `${value.toFixed(1)}%` : '--' }
function formatUsers(users) { return users?.length ? users.map((user) => user.id || '--').join('、') : t('publicReport.noUser') }
function firstRemaining(users) { const values = (users || []).map((user) => user.remaining_seconds).filter((value) => value !== null && value !== undefined); return values.length ? Math.min(...values) : null }
function formatRemaining(seconds) {
  void now.value
  if (seconds === null || seconds === undefined) return t('publicReport.noDeadline')
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(report.value?.generated_at || Date.now()).getTime()) / 1000))
  const remaining = Math.max(0, seconds - elapsed)
  if (remaining < 60) return `${remaining}s`
  if (remaining < 3600) return `${Math.ceil(remaining / 60)}m`
  return `${(remaining / 3600).toFixed(1)}h`
}

onMounted(() => { loadReport(); pollTimer = window.setInterval(() => loadReport(), 30_000); clockTimer = window.setInterval(() => { now.value = Date.now() }, 1_000) })
onBeforeUnmount(() => { window.clearInterval(pollTimer); window.clearInterval(clockTimer) })
</script>

<style scoped>
.report-page{min-height:100vh;padding:32px max(24px,calc((100vw - 1280px)/2)) 52px;background:#f4f7fb;color:#172033}.report-error{min-height:70vh;display:grid;place-items:center}.report-hero{--hero-start:#0b1f3a;--hero-end:#153b6d;position:relative;display:flex;justify-content:space-between;gap:32px;overflow:hidden;padding:30px 34px;border-radius:22px;color:#fff;background:linear-gradient(118deg,var(--hero-start),var(--hero-end));box-shadow:0 18px 40px rgb(15 43 79 / 20%)}.report-hero--healthy{--hero-start:#064e3b;--hero-end:#08745b}.report-hero--partial{--hero-start:#78350f;--hero-end:#b45309}.report-hero--busy{--hero-start:#7f1d1d;--hero-end:#b91c1c}.hero-orb{position:absolute;border-radius:50%;opacity:.14;background:#fff;pointer-events:none}.hero-orb--one{width:280px;height:280px;top:-160px;right:12%}.hero-orb--two{width:170px;height:170px;bottom:-105px;right:-20px}.hero-content,.hero-actions{position:relative;z-index:1}.hero-content{min-width:0}.hero-title-row{display:flex;align-items:center;gap:14px;margin-bottom:28px}.report-brand{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:750;letter-spacing:.02em}.live-indicator{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid rgb(255 255 255 / 24%);border-radius:999px;color:rgb(255 255 255 / 82%);font-size:11px}.live-indicator i,.report-footer i{width:6px;height:6px;border-radius:50%;background:#6ee7b7;box-shadow:0 0 0 3px rgb(110 231 183 / 20%)}.hero-heading{display:flex;align-items:center;gap:15px}.hero-status-icon{display:grid;width:48px;height:48px;place-items:center;border-radius:14px;background:rgb(255 255 255 / 15%);font-size:25px}.report-kicker{margin:0 0 5px;color:rgb(255 255 255 / 68%);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.hero-heading h1{margin:0;font-size:clamp(25px,3vw,34px);line-height:1.18;letter-spacing:-.035em}.overall-message{margin:7px 0 0;color:rgb(255 255 255 / 78%);font-size:14px}.hero-actions{flex:0 0 auto;align-self:flex-end;text-align:right}.hero-actions p{margin:0 0 4px;color:rgb(255 255 255 / 64%);font-size:12px}.hero-actions strong{font-size:13px;font-weight:600}.hero-action-row{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px}.hero-action-row :deep(.el-tag){border:0;background:rgb(255 255 255 / 16%)}.hero-action-row :deep(.el-button){border:0;color:#173052;background:#fff;font-weight:650}.hero-action-row :deep(.el-button:hover){color:#173052;background:#eaf2ff}
.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:20px}.summary-card{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:13px;min-height:130px;padding:20px;border:1px solid #e8edf5;border-radius:17px;background:#fff;box-shadow:0 4px 14px rgb(31 54 88 / 5%)}.summary-icon{display:grid;width:40px;height:40px;place-items:center;border-radius:12px;font-size:20px}.summary-icon--slate{color:#475569;background:#e9eef5}.summary-icon--blue{color:#2563eb;background:#e4efff}.summary-icon--green{color:#059669;background:#ddf8ed}.summary-card span{color:#69768a;font-size:13px}.summary-card strong{display:block;margin-top:2px;color:#172033;font-size:30px;line-height:1;letter-spacing:-.04em}.summary-card--idle strong{color:#2563eb}.summary-card--free strong{color:#059669}.summary-card p{grid-column:1/-1;margin:14px 0 0;padding-top:12px;border-top:1px solid #eef2f7;color:#8a96a8;font-size:12px}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:38px 2px 14px}.section-eyebrow{margin:0 0 5px;color:#3772cc;font-size:11px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.section-heading h2{margin:0;color:#1b2940;font-size:20px;letter-spacing:-.02em}.report-note{display:flex;align-items:center;gap:6px;margin:0;color:#7b8799;font-size:12px}.node-grid{display:grid;gap:16px}.node-card,.node-table-wrap{overflow:hidden;border:1px solid #e7edf5;border-radius:17px;background:#fff;box-shadow:0 4px 14px rgb(31 54 88 / 5%)}.node-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px;border-bottom:1px solid #edf1f6}.node-identity{display:flex;align-items:center;gap:11px;min-width:0}.node-icon,.table-node-icon{display:grid;flex:0 0 auto;place-items:center;width:35px;height:35px;border-radius:10px;color:#3271d4;background:#eaf2ff}.node-identity h3{margin:0 0 3px;font-size:16px;letter-spacing:-.01em}.node-identity span{color:#8490a2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.node-status{display:flex;align-items:center;gap:12px}.node-status small{color:#758196;font-size:12px}.node-status b{color:#36455d;font-weight:650}
.device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.device-item{min-width:0;padding:16px 18px;border-right:1px solid #edf1f6;border-bottom:1px solid #edf1f6}.device-item:nth-child(2n){border-right:0}.device-item:last-child:nth-child(odd){border-bottom:0}.device-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}.device-topline strong{color:#1e2b42;font-size:14px}.device-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}.device-model{min-height:18px;margin:5px 0 12px;overflow:hidden;color:#8590a2;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.device-user{display:flex;align-items:center;gap:6px;min-width:0;color:#4d5c72;font-size:13px}.device-user .el-icon{flex:0 0 auto;color:#7a8ba6}.device-user span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-metrics{display:flex;gap:14px;margin-top:12px;color:#8591a3;font-size:11px}.device-metrics span{white-space:nowrap}.device-metrics b{color:#526177;font-weight:650}.metric-dot{display:inline-block;width:5px;height:5px;margin:0 4px 1px 0;border-radius:50%}.metric-dot--util{background:#5b8def}.metric-dot--memory{background:#33b887}.device-footer{display:flex;justify-content:space-between;gap:12px;margin-top:13px;padding-top:10px;border-top:1px dashed #e6ebf2;color:#8a96a8;font-size:11px}.device-footer span{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-footer span:last-child{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.status-tag{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:750;letter-spacing:.02em}.status-tag--free,.status-tag--idle{color:#087858;background:#ddf8ed}.status-tag--partial,.status-tag--shared{color:#a45b03;background:#fff2d7}.status-tag--busy,.status-tag--exclusive{color:#bd3636;background:#ffe5e5}.status-tag--na{color:#66758a;background:#e9edf3}
.report-table{--el-table-header-bg-color:#f8fafd;--el-table-border-color:#edf1f6;--el-table-row-hover-bg-color:#f8fbff;--el-table-text-color:#526177}.report-table :deep(th.el-table__cell){color:#7a879a;font-size:11px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.report-table :deep(td.el-table__cell){padding:14px 0}.table-node{display:flex;align-items:center;gap:9px}.table-node-icon{width:30px;height:30px;font-size:15px}.table-node b,.table-node small{display:block}.table-node b{color:#25334a;font-size:13px}.table-node small{margin-top:3px;color:#8c98a9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.table-users{color:#46556c}.remaining{display:inline-flex;align-items:center;gap:5px;color:#627088}.table-metrics{color:#66768c;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.table-metrics i{display:inline-block;width:3px;height:3px;margin:0 5px 2px;border-radius:50%;background:#b6c1ce}.container-name{color:#7c8798;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.report-footer{display:flex;justify-content:space-between;gap:16px;margin:18px 2px 0;color:#8b96a7;font-size:11px}.report-footer span:first-child{display:flex;align-items:center;gap:6px}
@media (max-width:760px){.report-page{padding:14px 14px 34px}.report-hero{display:block;padding:23px 20px;border-radius:18px}.hero-title-row{margin-bottom:22px}.hero-actions{margin-top:22px;text-align:left}.hero-action-row{justify-content:flex-start}.summary-grid{gap:10px;margin-top:12px}.summary-card{min-height:116px;padding:15px;border-radius:14px}.summary-card strong{font-size:25px}.summary-card p{margin-top:10px;padding-top:9px}.section-heading{display:block;margin-top:28px}.report-note{margin-top:10px;line-height:1.4}.node-header{align-items:flex-start;padding:15px}.node-status{align-items:flex-end;flex-direction:column;gap:5px}.device-grid{grid-template-columns:1fr}.device-item,.device-item:nth-child(2n){border-right:0}.device-item:last-child:nth-child(odd){border-bottom:1px solid #edf1f6}.device-item:last-child{border-bottom:0}.node-table-wrap{overflow-x:auto}.report-table{min-width:840px}.report-footer{display:block;line-height:1.55}.report-footer span + span{display:block;margin-top:5px}}@media (max-width:440px){.summary-grid{grid-template-columns:1fr}.summary-card{min-height:92px}.hero-heading h1{font-size:24px}.node-status small{display:none}}
</style>
