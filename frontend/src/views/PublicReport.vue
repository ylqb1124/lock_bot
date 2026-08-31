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
        <article class="summary-card summary-card--total"><div class="summary-icon summary-icon--slate"><el-icon><Cpu /></el-icon></div><div><span>{{ $t('publicReport.total') }}</span><strong>{{ resourceTotal }}</strong></div><p>{{ $t('publicReport.totalHint') }}</p></article>
        <article class="summary-card summary-card--unoccupied"><div class="summary-icon summary-icon--blue"><el-icon><CircleCheckFilled /></el-icon></div><div><span>{{ $t('publicReport.unoccupied') }}</span><strong>{{ unoccupiedResources }}</strong></div><p>{{ $t('publicReport.unoccupiedHint', { percent: unoccupiedPercent }) }}</p></article>
      </section>

      <section class="availability-board" :aria-label="$t('publicReport.resourceUsageOverview')">
        <header class="availability-heading">
          <div><p class="section-eyebrow">{{ $t('publicReport.quickView') }}</p><h2>{{ $t('publicReport.resourceUsageOverview') }}</h2></div>
          <p>{{ $t('publicReport.resourcesTracked', { count: resourceTotal }) }}</p>
        </header>
        <div class="availability-panels">
          <article class="availability-panel availability-panel--unoccupied">
            <header><span class="availability-panel-icon"><el-icon><CircleCheckFilled /></el-icon></span><div><h3>{{ $t('publicReport.unoccupiedList') }}</h3><p>{{ $t('publicReport.unoccupiedListHint') }}</p></div><strong>{{ unoccupiedResources }}</strong></header>
            <div v-if="unoccupiedResourceGroups.length" class="resource-pill-grid">
              <button v-for="group in unoccupiedResourceGroups" :key="group.key" type="button" class="resource-pill resource-pill--unoccupied" :disabled="!quickViewNavigationEnabled" @click="openResourceGroup(group.nodeName)">
                <span>{{ group.label }}</span>
              </button>
            </div>
            <p v-else class="resource-empty">{{ $t('publicReport.noUnoccupied') }}</p>
          </article>
          <article class="availability-panel availability-panel--occupied">
            <header><span class="availability-panel-icon"><el-icon><Cpu /></el-icon></span><div><h3>{{ $t('publicReport.occupiedList') }}</h3><p>{{ $t('publicReport.occupiedListHint') }}</p></div><strong>{{ occupiedResources }}</strong></header>
            <div v-if="occupiedResourceGroups.length" class="resource-pill-grid">
              <button v-for="group in occupiedResourceGroups" :key="group.key" type="button" class="resource-pill resource-pill--occupied" :disabled="!quickViewNavigationEnabled" @click="openResourceGroup(group.nodeName)">
                <span>{{ group.label }}</span>
              </button>
            </div>
            <p v-else class="resource-empty">{{ $t('publicReport.noOccupied') }}</p>
          </article>
        </div>
        <p v-if="report.bot.type === 'DEVICE'" class="availability-tip">{{ $t('publicReport.clickToDetails') }}</p>
        <p v-else-if="report.bot.type === 'QUEUE'" class="availability-tip">{{ $t('publicReport.clickToQueueDetails') }}</p>
      </section>

      <div class="section-heading"><div><p class="section-eyebrow">{{ $t('publicReport.resourceStatus') }}</p><h2>{{ $t('publicReport.machineOverview') }}</h2></div><p class="report-note"><el-icon><Clock /></el-icon>{{ $t('publicReport.refreshHint', { seconds: report.cache_seconds }) }}</p></div>

      <section v-if="report.bot.type === 'DEVICE'" class="node-grid">
        <details v-for="node in report.nodes" :id="nodeAnchorId(node.name)" :key="node.name" class="node-card node-card--collapsible" :open="isNodeExpanded(node.name)" @toggle="setNodeExpanded(node.name, $event)">
          <summary class="node-summary">
            <div class="node-identity"><div class="node-icon"><el-icon><Monitor /></el-icon></div><div><h3>{{ node.name }}</h3><span>{{ node.ip || $t('publicReport.ipUnavailable') }}</span></div></div>
            <div class="node-summary-meta">
              <div class="device-map" :aria-label="$t('publicReport.deviceMap')">
                <span v-for="device in node.devices" :key="device.id" class="device-map-item" :class="`device-map-item--${resourceTone(device)}`" :title="deviceMapTitle(device)">{{ device.id }}</span>
              </div>
              <span class="details-hint">{{ $t('publicReport.showDeviceDetails', { count: node.devices.length }) }}</span><span class="summary-chevron"><el-icon><ArrowDown /></el-icon></span>
            </div>
          </summary>
          <div class="node-detail-toolbar"><p>{{ $t('publicReport.deviceDetails', { count: node.devices.length }) }}</p><div class="node-status"><StatusTag :status="node.lock_status" /><StatusTag v-if="node.usage_status && node.usage_status !== 'na'" category="usage" :status="node.usage_status" /><small>{{ $t('publicReport.memory') }} <b>{{ formatPercent(node.mem) }}</b></small></div></div>
          <div class="device-grid">
            <article v-for="device in node.devices" :key="device.id" class="device-item" :class="`device-item--${device.lock_status}`">
              <div class="device-topline"><strong>GPU {{ device.id }}</strong><span class="device-tags"><StatusTag :status="device.lock_status" /><StatusTag v-if="device.usage_status && device.usage_status !== 'na'" category="usage" :status="device.usage_status" /></span></div><p class="device-model">{{ device.model || $t('publicReport.modelUnavailable') }}</p>
              <div class="device-user"><el-icon><UserFilled /></el-icon><span>{{ formatUsers(device.users) }}</span></div>
              <div class="device-metrics"><span><i class="metric-dot metric-dot--util"></i>{{ $t('publicReport.utilization') }} <b>{{ formatPercent(device.util) }}</b></span><span><i class="metric-dot metric-dot--memory"></i>{{ $t('publicReport.memory') }} <b>{{ formatPercent(device.mem) }}</b></span></div>
              <footer class="device-footer"><span><el-icon><Timer /></el-icon>{{ formatRemaining(device.remaining_seconds) }}</span><span :title="device.container">{{ device.container || '--' }}</span></footer>
            </article>
          </div>
        </details>
      </section>

      <section v-else class="node-table-wrap">
        <el-table ref="reportTable" :data="sortedNodes" :row-class-name="tableRowClassName" class="report-table">
          <el-table-column :label="$t('publicReport.node')" min-width="180"><template #default="{ row }"><div class="table-node"><span class="table-node-icon"><el-icon><Monitor /></el-icon></span><span><b>{{ row.name }}</b><small>{{ row.ip || '-' }}</small></span></div></template></el-table-column>
          <el-table-column :label="$t('publicReport.status')" min-width="150"><template #default="{ row }"><span class="table-status"><StatusTag :status="row.lock_status" /><StatusTag v-if="row.usage_status && row.usage_status !== 'na'" category="usage" :status="row.usage_status" /></span></template></el-table-column>
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
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowDown, CircleCheckFilled, Clock, Connection, Cpu, Monitor, Refresh, Timer, UserFilled, WarningFilled } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()
const report = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const now = ref(Date.now())
const expandedNodes = ref({})
const reportTable = ref(null)
const highlightedNodeName = ref('')
let pollTimer
let clockTimer
let highlightTimer

const botId = computed(() => route.params.botId)
const resourceTotal = computed(() => report.value?.summary.total_resources || 0)
const reportResources = computed(() => {
  if (!report.value) return []
  const isDeviceReport = report.value.bot.type === 'DEVICE'
  return report.value.nodes.flatMap((node) => {
    const resources = isDeviceReport ? node.devices : [node]
    return resources.map((resource, index) => ({
      ...resource,
      key: `${node.name}-${resource.id ?? index}`,
      nodeName: node.name,
    }))
  })
})
const unoccupiedResourceItems = computed(() => reportResources.value.filter((resource) => !resourceIsOccupied(resource)))
const occupiedResourceItems = computed(() => reportResources.value.filter((resource) => resourceIsOccupied(resource)))
const unoccupiedResources = computed(() => unoccupiedResourceItems.value.length)
const unoccupiedPercent = computed(() => resourceTotal.value ? Math.round((unoccupiedResources.value / resourceTotal.value) * 100) : 0)
const occupiedResources = computed(() => occupiedResourceItems.value.length)
const quickViewNavigationEnabled = computed(() => ['DEVICE', 'QUEUE'].includes(report.value?.bot.type))
const unoccupiedResourceGroups = computed(() => groupResourcesForQuickView(unoccupiedResourceItems.value))
const occupiedResourceGroups = computed(() => groupResourcesForQuickView(occupiedResourceItems.value))
const sortedNodes = computed(() => {
  if (!report.value) return []
  return [...report.value.nodes].sort((left, right) => {
    const leftAvailable = resourceAvailabilityRank(left)
    const rightAvailable = resourceAvailabilityRank(right)
    return leftAvailable - rightAvailable || left.name.localeCompare(right.name, undefined, { numeric: true })
  })
})
const overallTone = computed(() => {
  if (!resourceTotal.value) return 'neutral'
  if (unoccupiedPercent.value === 100) return 'healthy'
  if (unoccupiedPercent.value === 0) return 'busy'
  return 'partial'
})
const overallIcon = computed(() => overallTone.value === 'healthy' ? CircleCheckFilled : WarningFilled)
const overallLabel = computed(() => t(`publicReport.overall.${overallTone.value}`))

const StatusTag = defineComponent({
  props: { status: { type: String, default: 'na' }, category: { type: String, default: 'lock' } },
  setup(props) {
    return () => {
      const isUsage = props.category === 'usage'
      const prefix = isUsage ? 'usage-tag' : 'status-tag'
      const translationKey = isUsage ? 'usageStatuses' : 'statuses'
      return h('span', { class: [prefix, `${prefix}--${props.status}`] }, t(`publicReport.${translationKey}.${props.status}`, props.status.toUpperCase()))
    }
  },
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
function resourceIsOccupied(resource) { return resource.lock_status !== 'idle' || Boolean(resource.bookings?.length) }
function remainingAfterElapsed(seconds) {
  if (seconds === null || seconds === undefined) return null
  const generatedAt = new Date(report.value?.generated_at || now.value).getTime()
  const elapsed = Math.max(0, Math.floor((now.value - generatedAt) / 1000))
  return Math.max(0, seconds - elapsed)
}
function formatRemaining(seconds) {
  const remaining = remainingAfterElapsed(seconds)
  if (remaining === null) return t('publicReport.noDeadline')
  if (remaining < 60) return `${remaining}s`
  if (remaining < 3600) return `${Math.ceil(remaining / 60)}m`
  return `${(remaining / 3600).toFixed(1)}h`
}
function resourceTone(resource) {
  return resource.usage_status || 'na'
}
function deviceMapTitle(device) {
  const lockStatus = t(`publicReport.statuses.${device.lock_status}`)
  const usageStatus = device.usage_status ? t(`publicReport.usageStatuses.${device.usage_status}`) : '--'
  return `GPU ${device.id} · ${lockStatus} · ${usageStatus}`
}
function resourceAvailabilityRank(resource) {
  return resourceIsOccupied(resource) ? 1 : 0
}
function groupResourcesForQuickView(resources) {
  if (report.value?.bot.type === 'QUEUE') {
    return resources.map((resource) => ({ key: resource.key, nodeName: resource.nodeName, label: resource.nodeName }))
  }
  return groupResourcesByNode(resources)
}
function groupResourcesByNode(resources) {
  const groups = new Map()
  for (const resource of resources) {
    const group = groups.get(resource.nodeName) || { key: resource.nodeName, nodeName: resource.nodeName, resources: [] }
    group.resources.push(resource)
    groups.set(resource.nodeName, group)
  }
  return [...groups.values()].map((group) => {
    const deviceIds = group.resources.map((resource) => resource.id).filter((id) => id !== null && id !== undefined)
    return {
      ...group,
      label: deviceIds.length ? `${group.nodeName} · GPU ${formatDeviceIds(deviceIds)}` : group.nodeName,
    }
  })
}
function formatDeviceIds(ids) {
  const uniqueIds = new Map()
  for (const id of ids) {
    const numericId = Number(id)
    const key = Number.isFinite(numericId) ? `number:${numericId}` : `value:${String(id)}`
    if (!uniqueIds.has(key)) uniqueIds.set(key, { label: String(id), numericId })
  }
  const sorted = [...uniqueIds.values()].sort((left, right) => {
    if (Number.isFinite(left.numericId) && Number.isFinite(right.numericId)) return left.numericId - right.numericId
    return left.label.localeCompare(right.label, undefined, { numeric: true })
  })
  const ranges = []
  let start = sorted[0]
  let end = sorted[0]
  for (const id of sorted.slice(1)) {
    if (Number.isFinite(id.numericId) && id.numericId === end.numericId + 1) end = id
    else { ranges.push(start === end ? start.label : `${start.label}–${end.label}`); start = id; end = id }
  }
  if (start !== undefined) ranges.push(start === end ? start.label : `${start.label}–${end.label}`)
  return ranges.join(', ')
}
function nodeAnchorId(name) { return `report-node-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}` }
function isNodeExpanded(name) { return Boolean(expandedNodes.value[name]) }
function setNodeExpanded(name, event) { expandedNodes.value = { ...expandedNodes.value, [name]: event.currentTarget.open } }
function tableRowClassName({ row }) { return row.name === highlightedNodeName.value ? 'report-table-row--highlight' : '' }
async function openNode(name) {
  if (report.value?.bot.type !== 'DEVICE') return
  if (!isNodeExpanded(name)) expandedNodes.value = { ...expandedNodes.value, [name]: true }
  await nextTick()
  document.getElementById(nodeAnchorId(name))?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
async function openResourceGroup(name) {
  if (report.value?.bot.type === 'DEVICE') {
    await openNode(name)
  } else if (report.value?.bot.type === 'QUEUE') {
    await highlightQueueNode(name)
  }
}
async function highlightQueueNode(name) {
  highlightedNodeName.value = name
  await nextTick()
  const nodeIndex = sortedNodes.value.findIndex((node) => node.name === name)
  const rows = reportTable.value?.$el?.querySelectorAll('.el-table__body tbody > tr')
  rows?.[nodeIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => { highlightedNodeName.value = '' }, 2_500)
}

onMounted(() => { loadReport(); pollTimer = window.setInterval(() => loadReport(), 30_000); clockTimer = window.setInterval(() => { now.value = Date.now() }, 1_000) })
onBeforeUnmount(() => { window.clearInterval(pollTimer); window.clearInterval(clockTimer); window.clearTimeout(highlightTimer) })
</script>

<style scoped>
.report-page{min-height:100vh;padding:32px max(24px,calc((100vw - 1280px)/2)) 52px;background:#f4f7fb;color:#172033}.report-error{min-height:70vh;display:grid;place-items:center}.report-hero{--hero-start:#0b1f3a;--hero-end:#153b6d;position:relative;display:flex;justify-content:space-between;gap:32px;overflow:hidden;padding:30px 34px;border-radius:22px;color:#fff;background:linear-gradient(118deg,var(--hero-start),var(--hero-end));box-shadow:0 18px 40px rgb(15 43 79 / 20%)}.report-hero--healthy{--hero-start:#064e3b;--hero-end:#08745b}.report-hero--partial{--hero-start:#78350f;--hero-end:#b45309}.report-hero--busy{--hero-start:#7f1d1d;--hero-end:#b91c1c}.hero-orb{position:absolute;border-radius:50%;opacity:.14;background:#fff;pointer-events:none}.hero-orb--one{width:280px;height:280px;top:-160px;right:12%}.hero-orb--two{width:170px;height:170px;bottom:-105px;right:-20px}.hero-content,.hero-actions{position:relative;z-index:1}.hero-content{min-width:0}.hero-title-row{display:flex;align-items:center;gap:14px;margin-bottom:28px}.report-brand{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:750;letter-spacing:.02em}.live-indicator{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid rgb(255 255 255 / 24%);border-radius:999px;color:rgb(255 255 255 / 82%);font-size:11px}.live-indicator i,.report-footer i{width:6px;height:6px;border-radius:50%;background:#6ee7b7;box-shadow:0 0 0 3px rgb(110 231 183 / 20%)}.hero-heading{display:flex;align-items:center;gap:15px}.hero-status-icon{display:grid;width:48px;height:48px;place-items:center;border-radius:14px;background:rgb(255 255 255 / 15%);font-size:25px}.report-kicker{margin:0 0 5px;color:rgb(255 255 255 / 68%);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.hero-heading h1{margin:0;font-size:clamp(25px,3vw,34px);line-height:1.18;letter-spacing:-.035em}.overall-message{margin:7px 0 0;color:rgb(255 255 255 / 78%);font-size:14px}.hero-actions{flex:0 0 auto;align-self:flex-end;text-align:right}.hero-actions p{margin:0 0 4px;color:rgb(255 255 255 / 64%);font-size:12px}.hero-actions strong{font-size:13px;font-weight:600}.hero-action-row{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px}.hero-action-row :deep(.el-tag){border:0;background:rgb(255 255 255 / 16%)}.hero-action-row :deep(.el-button){border:0;color:#173052;background:#fff;font-weight:650}.hero-action-row :deep(.el-button:hover){color:#173052;background:#eaf2ff}
.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:20px}.summary-card{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:13px;min-height:130px;padding:20px;border:1px solid #e8edf5;border-radius:17px;background:#fff;box-shadow:0 4px 14px rgb(31 54 88 / 5%)}.summary-icon{display:grid;width:40px;height:40px;place-items:center;border-radius:12px;font-size:20px}.summary-icon--blue{color:#2563eb;background:#e4efff}.summary-icon--red{color:#c24141;background:#ffe7e7}.summary-icon--purple{color:#6d4bc3;background:#eee9ff}.summary-icon--slate{color:#475569;background:#e9eef5}.summary-card span{color:#69768a;font-size:13px}.summary-card strong{display:block;margin-top:2px;color:#172033;font-size:30px;line-height:1;letter-spacing:-.04em}.summary-card--available strong{color:#2563eb}.summary-card--occupied strong{color:#c24141}.summary-card--in-use strong{color:#6d4bc3}.summary-card--total strong{color:#475569}.summary-card p{grid-column:1/-1;margin:14px 0 0;padding-top:12px;border-top:1px solid #eef2f7;color:#8a96a8;font-size:12px}
.availability-board{margin-top:18px;padding:21px 22px 16px;border:1px solid #dfe9f7;border-radius:17px;background:linear-gradient(135deg,#f9fbff,#f4f8ff);box-shadow:0 4px 14px rgb(31 54 88 / 4%)}.availability-heading{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:15px}.availability-heading h2,.section-heading h2{margin:0;color:#1b2940;font-size:20px;letter-spacing:-.02em}.availability-heading > p{margin:0;color:#7b8799;font-size:12px}.availability-panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.availability-panel{min-width:0;padding:15px 16px;border:1px solid #e5ebf4;border-radius:14px;background:#fff}.availability-panel--in-use{border-color:#e1d8ff}.availability-panel--idle{border-color:#d4eddf}.availability-panel header{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px}.availability-panel-icon{display:grid;width:32px;height:32px;place-items:center;border-radius:10px;font-size:16px}.availability-panel--in-use .availability-panel-icon{color:#6d4bc3;background:#eee9ff}.availability-panel--idle .availability-panel-icon{color:#087858;background:#ddf8ed}.availability-panel h3{margin:0;color:#23324a;font-size:14px}.availability-panel header p{margin:3px 0 0;color:#8490a2;font-size:11px}.availability-panel header strong{color:#1b2940;font-size:24px;letter-spacing:-.04em}.resource-pill-grid{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.resource-pill{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:6px 7px 6px 9px;border:1px solid transparent;border-radius:9px;background:#f6f8fc;color:#3e4d65;cursor:pointer;font:inherit;font-size:12px;line-height:1.1;text-align:left;transition:border-color .16s,box-shadow .16s,transform .16s}.resource-pill:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 3px 8px rgb(31 54 88 / 9%)}.resource-pill:focus-visible{outline:2px solid #4d87e5;outline-offset:2px}.resource-pill:disabled{cursor:default}.resource-pill--in-use{border-color:#e1d8ff;background:#faf8ff}.resource-pill--idle{border-color:#d4eddf;background:#f4fcf7}.resource-pill > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.resource-pill small{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;white-space:nowrap}.resource-pill--in-use small{color:#6d4bc3}.resource-pill--idle small{color:#087858}.resource-empty{margin:15px 0 2px;color:#8a96a8;font-size:12px}.availability-tip{margin:14px 0 0;color:#758399;font-size:11px}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:38px 2px 14px}.section-eyebrow{margin:0 0 5px;color:#3772cc;font-size:11px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.report-note{display:flex;align-items:center;gap:6px;margin:0;color:#7b8799;font-size:12px}
.node-grid{display:grid;gap:12px}.node-card,.node-table-wrap{overflow:hidden;border:1px solid #e7edf5;border-radius:17px;background:#fff;box-shadow:0 4px 14px rgb(31 54 88 / 5%)}.node-summary{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px 20px;cursor:pointer;list-style:none;transition:background .16s}.node-summary::-webkit-details-marker{display:none}.node-summary:hover{background:#fbfdff}.node-summary:focus-visible{outline:2px solid #4d87e5;outline-offset:-3px}.node-card[open] .node-summary{border-bottom:1px solid #edf1f6;background:#fbfdff}.node-identity{display:flex;align-items:center;gap:11px;min-width:0}.node-icon,.table-node-icon{display:grid;flex:0 0 auto;place-items:center;width:35px;height:35px;border-radius:10px;color:#3271d4;background:#eaf2ff}.node-identity h3{margin:0 0 3px;font-size:16px;letter-spacing:-.01em}.node-identity span{color:#8490a2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.node-summary-meta{display:flex;justify-content:flex-end;align-items:center;gap:9px;min-width:0}.node-count{padding:4px 7px;border-radius:999px;font-size:11px;font-weight:750;white-space:nowrap}.node-count--available{color:#087858;background:#ddf8ed}.node-count--occupied{color:#bd3636;background:#ffe5e5}.device-map{display:flex;align-items:center;gap:4px;padding:0 2px}.device-map-item{display:grid;width:22px;height:22px;place-items:center;border-radius:6px;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:750}.device-map-item--idle{background:#20a77b}.device-map-item--in_use{background:#7656c6}.device-map-item--partial{background:#d99119}.device-map-item--na{background:#a0acbc}.details-hint{color:#718096;font-size:11px;white-space:nowrap}.summary-chevron{display:grid;place-items:center;color:#8794a8;transition:transform .18s}.node-card[open] .summary-chevron{transform:rotate(180deg)}.node-detail-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:13px 20px;border-bottom:1px solid #edf1f6;background:#fbfdff}.node-detail-toolbar p{margin:0;color:#627088;font-size:12px;font-weight:650}.node-status{display:flex;align-items:center;gap:12px}.node-status small{color:#758196;font-size:12px}.node-status b{color:#36455d;font-weight:650}
.device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.device-item{min-width:0;padding:16px 18px;border-right:1px solid #edf1f6;border-bottom:1px solid #edf1f6}.device-item:nth-child(2n){border-right:0}.device-item:last-child:nth-child(odd){border-bottom:0}.device-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}.device-topline strong{color:#1e2b42;font-size:14px}.device-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}.device-model{min-height:18px;margin:5px 0 12px;overflow:hidden;color:#8590a2;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.device-user{display:flex;align-items:center;gap:6px;min-width:0;color:#4d5c72;font-size:13px}.device-user .el-icon{flex:0 0 auto;color:#7a8ba6}.device-user span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-metrics{display:flex;gap:14px;margin-top:12px;color:#8591a3;font-size:11px}.device-metrics span{white-space:nowrap}.device-metrics b{color:#526177;font-weight:650}.metric-dot{display:inline-block;width:5px;height:5px;margin:0 4px 1px 0;border-radius:50%}.metric-dot--util{background:#5b8def}.metric-dot--memory{background:#33b887}.device-footer{display:flex;justify-content:space-between;gap:12px;margin-top:13px;padding-top:10px;border-top:1px dashed #e6ebf2;color:#8a96a8;font-size:11px}.device-footer span{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-footer span:last-child{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.status-tag,.usage-tag{display:inline-flex;align-items:center;min-height:22px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:750;letter-spacing:.02em}.status-tag--free,.status-tag--idle{color:#087858;background:#ddf8ed}.status-tag--partial,.status-tag--shared{color:#a45b03;background:#fff2d7}.status-tag--busy,.status-tag--exclusive{color:#bd3636;background:#ffe5e5}.status-tag--na{color:#66758a;background:#e9edf3}.usage-tag--idle{color:#66758a;background:#e9edf3}.usage-tag--in_use{color:#5d3fa9;background:#eee9ff}.usage-tag--partial{color:#a45b03;background:#fff2d7}.usage-tag--na{color:#66758a;background:#e9edf3}
.report-table{--el-table-header-bg-color:#f8fafd;--el-table-border-color:#edf1f6;--el-table-row-hover-bg-color:#f8fbff;--el-table-text-color:#526177}.report-table :deep(th.el-table__cell){color:#7a879a;font-size:11px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.report-table :deep(td.el-table__cell){padding:14px 0}.table-node{display:flex;align-items:center;gap:9px}.table-node-icon{width:30px;height:30px;font-size:15px}.table-node b,.table-node small{display:block}.table-node b{color:#25334a;font-size:13px}.table-node small{margin-top:3px;color:#8c98a9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.table-status{display:flex;flex-wrap:wrap;gap:4px}.table-users{color:#46556c}.remaining{display:inline-flex;align-items:center;gap:5px;color:#627088}.table-metrics{color:#66768c;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.table-metrics i{display:inline-block;width:3px;height:3px;margin:0 5px 2px;border-radius:50%;background:#b6c1ce}.container-name{color:#7c8798;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.report-footer{display:flex;justify-content:space-between;gap:16px;margin:18px 2px 0;color:#8b96a7;font-size:11px}.report-footer span:first-child{display:flex;align-items:center;gap:6px}
.report-table :deep(.report-table-row--highlight > td.el-table__cell){background:#fff3c9}
@media (max-width:1080px){.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){.report-page{padding:14px 14px 34px}.report-hero{display:block;padding:23px 20px;border-radius:18px}.hero-title-row{margin-bottom:22px}.hero-actions{margin-top:22px;text-align:left}.hero-action-row{justify-content:flex-start}.summary-grid{gap:10px;margin-top:12px}.summary-card{min-height:116px;padding:15px;border-radius:14px}.summary-card strong{font-size:25px}.summary-card p{margin-top:10px;padding-top:9px}.availability-board{margin-top:12px;padding:17px 15px 14px;border-radius:14px}.availability-heading{display:block}.availability-heading > p{margin-top:8px}.availability-panels{grid-template-columns:1fr;gap:10px}.availability-panel{padding:14px}.section-heading{display:block;margin-top:28px}.report-note{margin-top:10px;line-height:1.4}.node-summary{align-items:flex-start;padding:15px}.node-summary-meta{flex-wrap:wrap;justify-content:flex-start;margin-left:46px}.details-hint{display:none}.node-detail-toolbar{align-items:flex-start;padding:12px 15px}.node-status{align-items:flex-end;flex-direction:column;gap:5px}.device-grid{grid-template-columns:1fr}.device-item,.device-item:nth-child(2n){border-right:0}.device-item:last-child:nth-child(odd){border-bottom:1px solid #edf1f6}.device-item:last-child{border-bottom:0}.node-table-wrap{overflow-x:auto}.report-table{min-width:840px}.report-footer{display:block;line-height:1.55}.report-footer span + span{display:block;margin-top:5px}}@media (max-width:440px){.summary-grid{grid-template-columns:1fr}.summary-card{min-height:92px}.hero-heading h1{font-size:24px}.node-summary{display:block}.node-summary-meta{margin:12px 0 0}.device-map{order:-1;width:100%}.node-status small{display:none}}
.report-hero{gap:24px;padding:24px 28px}.hero-title-row{gap:10px;margin-bottom:20px}.report-brand{font-size:13px}.live-indicator{gap:5px;padding:3px 7px;font-size:10px}.hero-heading{gap:12px}.hero-status-icon{width:42px;height:42px;border-radius:12px;font-size:22px}.report-kicker{margin-bottom:4px;font-size:10px}.hero-heading h1{font-size:clamp(22px,2.4vw,28px)}.overall-message{margin-top:5px;font-size:13px}.hero-actions p{font-size:11px}.hero-actions strong{font-size:12px}.hero-action-row{margin-top:10px}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.summary-card--unoccupied strong{color:#2563eb}.availability-panel--unoccupied{border-color:#d4eddf}.availability-panel--occupied{border-color:#f5d3d3}.availability-panel--unoccupied .availability-panel-icon{color:#087858;background:#ddf8ed}.availability-panel--occupied .availability-panel-icon{color:#bd3636;background:#ffe5e5}.resource-pill--unoccupied{border-color:#d4eddf;background:#f4fcf7}.resource-pill--occupied{border-color:#f5d3d3;background:#fff8f8}@media (max-width:440px){.hero-heading h1{font-size:22px}}
</style>
