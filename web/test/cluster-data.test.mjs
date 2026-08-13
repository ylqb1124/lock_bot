import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import clusterScope from '../shared/cluster-scope.json' with { type: 'json' };
import { adaptNodeData } from '../src/services/adapter.js';
import { AUTO_REFRESH_INTERVAL_MS, nextAutoRefreshDelay, shouldAutoRefresh } from '../src/services/auto-refresh.js';
import { hasFiniteSamples, nearestFiniteIndex, resolveYAxis } from '../src/services/chart-data.js';
import { buildClusterStats } from '../src/services/cluster-stats.js';
import { CARD_COUNT, mergeLockBotStates } from '../src/services/cluster-state.js';
import { CURRENT_MONQUERY_TIMEOUT_MS, DEFAULT_MONQUERY_TIMEOUT_MS, metricNodeIdsAt } from '../src/services/api.js';
import { currentOffsetMs, now, syncServerTimeOffset } from '../src/services/server-time.js';
import { formatAverageUserCount } from '../src/services/team-metrics.js';

const require = createRequire(import.meta.url);
const { createTrendService, _private } = require('../server/trend-service.cjs');
const { pruneLockHistoryCache } = _private;
const { createTeamService, _private: teamPrivate } = require('../server/team-service.cjs');
const { createTeamAccessService } = require('../server/team-access.cjs');
const { createAppAuthService } = require('../server/app-auth.cjs');
const { createLockBotLiveCache } = require('../server/lockbot-live-cache.cjs');
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function emptyDeviceState() {
  return Array.from({ length: CARD_COUNT }, (_, devId) => ({ dev_id: devId, status: 'idle', current_users: [] }));
}

test('cluster scope uses the current 73-node, 584-card computation denominator', () => {
  assert.equal(clusterScope.nodeIds.length, 73);
  assert.equal(clusterScope.cardsPerNode, 8);
  assert.equal(clusterScope.nodeIds.length * clusterScope.cardsPerNode, 584);
  assert.equal(clusterScope.nodeIds.includes(15), false);
  assert.equal(clusterScope.nodeIds.includes(16), false);
  assert.equal(clusterScope.nodeIds.includes(60), true);
  assert.equal(clusterScope.nodeIds.includes(69), true);
  assert.equal(clusterScope.nodeIds.includes(70), true);
  assert.equal(clusterScope.nodeIds.includes(79), true);
  assert.equal(clusterScope.nodeIds.includes(83), true);
  assert.equal(clusterScope.nodeIds.includes(84), true);
});

test('nodeGroups in cluster scope stay consistent with the flat nodeIds list', () => {
  const groupIds = clusterScope.nodeGroups.flatMap(group => group.nodeIds).slice().sort((a, b) => a - b);
  const flatIds = [...clusterScope.nodeIds].sort((a, b) => a - b);
  assert.deepEqual(groupIds, flatIds);
});

test('metric monitoring keeps the 73-node scope but excludes node38, node68, and node69 from Beijing 08:00', () => {
  const { buildMetricUsageScopeTimeline, nodeIdsAt } = require('../shared/cluster-scope-timeline.cjs');
  const before = Math.floor(new Date('2026-08-11T07:59:59+08:00').getTime() / 1000);
  const effectiveFrom = Math.floor(new Date('2026-08-11T08:00:00+08:00').getTime() / 1000);
  const timeline = buildMetricUsageScopeTimeline(clusterScope, clusterScope.nodeIds);

  assert.equal(clusterScope.nodeIds.length, 73);
  assert.deepEqual(clusterScope.metricUsageExclusions, [{
    effectiveFrom: '2026-08-11T08:00:00+08:00',
    nodeIds: [38, 68, 69],
  }]);
  // node83、node84 于 2026-08-12 才生效，08-11 的历史时间点仍不包含这两台节点。
  assert.equal(nodeIdsAt(timeline, before).length, 71);
  assert.equal(nodeIdsAt(timeline, effectiveFrom).length, 68);
  assert.deepEqual(nodeIdsAt(timeline, effectiveFrom).filter(nodeId => [38, 68, 69].includes(nodeId)), []);
  assert.equal(metricNodeIdsAt(new Date('2026-08-11T07:59:59+08:00')).length, 73);
  assert.deepEqual(metricNodeIdsAt(new Date('2026-08-11T08:00:00+08:00')).filter(nodeId => [38, 68, 69].includes(nodeId)), []);
});

test('new nodes enter the cluster scope at Beijing midnight on August 6', () => {
  const { buildNodeTimeline, nodeCountAt, totalCardsAt } = require('../shared/cluster-scope-timeline.cjs');
  const timeline = buildNodeTimeline(clusterScope, clusterScope.nodeIds);
  const before = Math.floor(new Date('2026-08-05T23:59:59+08:00').getTime() / 1000);
  const effectiveFrom = Math.floor(new Date('2026-08-06T00:00:00+08:00').getTime() / 1000);
  assert.equal(nodeCountAt(timeline, before), 66);
  assert.equal(totalCardsAt(timeline, clusterScope.cardsPerNode, before), 528);
  assert.equal(nodeCountAt(timeline, effectiveFrom), 71);
  assert.equal(totalCardsAt(timeline, clusterScope.cardsPerNode, effectiveFrom), 568);
});

test('cluster node average usage card averages valid lock trend points in the selected range', () => {
  const stats = buildClusterStats([{}, {}], {
    lock: [10, null, 30],
    xpu: [5, 15],
    memory: [20, 40],
  }, true, CARD_COUNT);

  assert.equal(stats.find(card => card.label === '节点平均使用率').value, '20.0%');
  assert.equal(stats.find(card => card.label === 'XPU卡平均利用率/峰值利用率').value, '10.0%/15.0%');
  assert.equal(stats.find(card => card.label === '显存平均利用率/峰值利用率').value, '30.0%/40.0%');
});

test('cluster node average usage card stays unavailable for incomplete or missing lock trends', () => {
  const incomplete = buildClusterStats([{}], { lock: [10, 30] }, false, CARD_COUNT);
  const missing = buildClusterStats([{}], { lock: [null, null] }, true, CARD_COUNT);

  assert.equal(incomplete.find(card => card.label === '节点平均使用率').value, '--');
  assert.equal(missing.find(card => card.label === '节点平均使用率').value, '--');
});

test('backend endpoints are injected from named environment variables instead of stored in configuration', () => {
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
  const exampleConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.example.json'), 'utf8'));
  const proxy = fs.readFileSync(path.join(PROJECT_ROOT, 'web/server/proxy.cjs'), 'utf8');

  for (const config of [runtimeConfig, exampleConfig]) {
    assert.deepEqual(config.backend.lockbot, { hostEnv: 'LOCKBOT_HOST', portEnv: 'LOCKBOT_PORT' });
    assert.deepEqual(config.backend.monquery, { hostEnv: 'MONQUERY_HOST', portEnv: 'MONQUERY_PORT' });
  }
  assert.match(proxy, /function injectBackendEnvironment\(name, defaults\)/);
  assert.match(proxy, /process\.env\[hostEnv\]/);
});

test('cluster dashboard uses a six-minute trend interval for the 24-hour range', () => {
  const dashboard = fs.readFileSync(path.join(PROJECT_ROOT, 'web/src/views/ClusterDashboard.vue'), 'utf8');
  const proxy = fs.readFileSync(path.join(PROJECT_ROOT, 'web/server/proxy.cjs'), 'utf8');

  assert.match(dashboard, /\{ maxMinutes: 1440, seconds: 360 \}/);
  assert.match(proxy, /new Set\(\[60, 120, 240, 300, 360, 480/);
});

test('legacy static dashboard requests the same 73-node scope and namespaces as the Vue dashboard', () => {
  const legacyApi = fs.readFileSync(path.join(PROJECT_ROOT, 'api.js'), 'utf8');
  const monitored = legacyApi.match(/const MONITORED_NODES = \[([\s\S]*?)\];/);
  const nonBackup = legacyApi.match(/const NON_BACKUP_NODES = \[([\s\S]*?)\];/);
  assert.ok(monitored, 'legacy MONITORED_NODES must exist');
  assert.ok(nonBackup, 'legacy NON_BACKUP_NODES must exist');
  const nodeIds = monitored[1].match(/\d+/g).map(Number);
  const nonBackupNodeIds = nonBackup[1].match(/\d+/g).map(Number);

  assert.deepEqual(nodeIds, clusterScope.nodeIds);
  assert.deepEqual(nonBackupNodeIds.filter(nodeId => nodeId >= 70), [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 83, 84, 85, 86]);
});

test('legacy node view uses the application login and keeps its filter, rankings, and expandable card details', () => {
  const legacyHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(PROJECT_ROOT, 'styles.css'), 'utf8');
  const script = legacyHtml.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

  assert.doesNotMatch(legacyHtml, /id="type-toggles"/);
  assert.doesNotMatch(legacyHtml, /data-type="(?:all|personal)"/);
  assert.match(legacyHtml, /id="personal-result-summary"/);
  assert.match(legacyHtml, /id="xpu-usage-ranking"/);
  assert.match(legacyHtml, /id="memory-usage-ranking"/);
  assert.match(legacyHtml, /id="node-list"/);
  assert.match(legacyHtml, /class="usage-rank-tooltip"/);
  assert.match(script, /loginDashboard/);
  assert.match(script, /function bindUsageRankHelp\(\)/);
  assert.doesNotMatch(script, /loginLockBot/);
  assert.doesNotMatch(script, /loginDashboard\('admin'/);
  assert.match(script, /function collectUserUsage\(\)/);
  assert.match(script, /function renderPersonalUsageRankings\(\)/);
  assert.match(script, /className = 'card-detail-row'/);
  assert.match(styles, /\.usage-rank-row/);
  assert.match(styles, /\.card-detail-row/);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: script }));
});

test('node70 through node79 are active from 10:00 China time with no pending duplicates', () => {
  const activation = clusterScope.nodeGroups.find(group => group.effectiveFrom === '2026-07-29T10:00:00+08:00');
  assert.deepEqual(activation.nodeIds, [70, 71, 72, 73, 74, 75, 76, 77, 78, 79]);
  assert.deepEqual(clusterScope.pendingNodeGroups, []);
});

test('current Monquery timeout is shorter than the general request timeout', () => {
  assert.equal(CURRENT_MONQUERY_TIMEOUT_MS, 12_000);
  assert.ok(CURRENT_MONQUERY_TIMEOUT_MS < DEFAULT_MONQUERY_TIMEOUT_MS);
});

test('empty Monquery arrays remain unknown instead of becoming free', () => {
  const [node] = adaptNodeData({
    node1: emptyDeviceState(),
  }, [{
    NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
    Items: { XPU0_XPU_UTILIZATION: [], XPU0_MEM_UTILIZATION: [] },
  }], 97, 'DEVICE');

  assert.equal(node.status, 'UNKNOWN');
  assert.equal(node.knownCardCount, 0);
  assert.deepEqual(node.cardMetricStates, new Array(CARD_COUNT).fill('UNKNOWN'));
});

test('partial card metrics expose coverage without inventing free cards', () => {
  const [node] = adaptNodeData({ node1: emptyDeviceState() }, [{
    NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
    Items: {
      XPU0_XPU_UTILIZATION: [{ Timestamp: 0, Value: 20 }],
      XPU0_MEM_UTILIZATION: [{ Timestamp: 0, Value: 0 }],
    },
  }], 97, 'DEVICE');

  assert.equal(node.status, 'PARTIAL');
  assert.equal(node.knownCardCount, 1);
  assert.equal(node.busyCards, 1);
  assert.equal(node.cardMetricStates[0], 'BUSY');
  assert.equal(node.cardMetricStates[1], 'UNKNOWN');
});

test('missing card metrics remain unknown and never become busy', () => {
  const [node] = adaptNodeData({ node1: emptyDeviceState() }, [{
    NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
    Items: {
      XPU0_XPU_UTILIZATION: [{ Timestamp: 0, Value: 20 }],
      XPU0_MEM_UTILIZATION: [{ Timestamp: 0, Value: 0 }],
    },
  }], 97, 'DEVICE');

  assert.equal(node.cardMetricStates.filter(state => state === 'BUSY').length, 1);
  assert.equal(node.cardMetricStates.filter(state => state === 'UNKNOWN').length, CARD_COUNT - 1);
});

test('China-time occupancy records land on the correct Beijing timeline slot', () => {
  const [node] = adaptNodeData({
    node3: { status: 'idle', current_users: [], booking_list: [] },
  }, [], 0, 'NODE', [{
    node_key: 'node3',
    user_id: 'lixiang106',
    lock_mode: 'exclusive',
    resource_type: 'node',
    device_id: null,
    start_time_cn: '2026-07-17T07:39:13',
    end_time_cn: '2026-07-17T13:39:13',
    duration_seconds: 21600,
    day_key_cn: '2026-07-17',
  }], '2026-07-17');

  assert.equal(node.occupations[0].start, 91);
  assert.equal(node.occupations[0].end, 163);
});

test('cross-day occupancy is clipped to the displayed China date instead of becoming a future block', () => {
  const [node] = adaptNodeData({
    node1: { status: 'idle', current_users: [], booking_list: [] },
  }, [], 0, 'NODE', [{
    node_key: 'node1',
    user_id: 'zhangfan51',
    start_time_cn: '2026-07-20T22:30:50',
    end_time_cn: '2026-07-21T04:30:50',
    duration_seconds: 21600,
    day_key_cn: '2026-07-20',
  }], '2026-07-21');

  assert.deepEqual(node.occupations, [{ start: 0, end: 54, user: 'zhangfan51' }]);
});

test('an occupancy crossing midnight is split correctly between today and tomorrow', () => {
  const history = [{
    node_key: 'node1',
    user_id: 'night-user',
    start_time_cn: '2026-07-21T22:30:50',
    end_time_cn: '2026-07-22T04:30:50',
    duration_seconds: 21600,
    day_key_cn: '2026-07-21',
  }];
  const state = { node1: { status: 'idle', current_users: [], booking_list: [] } };

  const [today] = adaptNodeData(state, [], 0, 'NODE', history, '2026-07-21');
  const [tomorrow] = adaptNodeData(state, [], 0, 'NODE', history, '2026-07-22');

  assert.deepEqual(today.occupations, [{ start: 270, end: 288, user: 'night-user' }]);
  assert.deepEqual(tomorrow.occupations, [{ start: 0, end: 54, user: 'night-user' }]);
});

test('Lock Bot states merge aliases and NODE/DEVICE locks by card', () => {
  const merged = mergeLockBotStates([
    {
      ok: true,
      bot: { id: 1, bot_type: 'NODE' },
      state: {
        'node-01': {
          status: 'exclusive',
          current_users: [{ user_id: 'node-user', start_time: 100, duration: 300 }],
        },
      },
    },
    {
      ok: true,
      bot: { id: 2, bot_type: 'DEVICE' },
      state: {
        'gpu-node-01': [{
          dev_id: 3,
          status: 'exclusive',
          current_users: [{ user_id: 'card-user', start_time: 110, duration: 300 }],
        }],
      },
    },
  ]);

  assert.equal(Object.keys(merged.deviceState).length, 73);
  assert.equal(merged.lockStateComplete, true);
  assert.equal(merged.deviceState.node1.length, CARD_COUNT);
  assert.equal(merged.deviceState.node1[0].current_users.length, 1);
  assert.equal(merged.deviceState.node1[3].current_users.length, 2);

  const incomplete = mergeLockBotStates([{ ok: false, bot: { id: 3 } }]);
  assert.equal(incomplete.lockStateComplete, false);
  assert.deepEqual(incomplete.failedBotIds, [3]);
});

test('DEVICE live locks use bot_type and are counted once with NODE locks', () => {
  assert.equal(_private.botType({ bot_type: 'DEVICE' }), 'DEVICE');
  const intervals = _private.stateIntervals([
    {
      type: 'NODE',
      state: { node1: { status: 'exclusive', current_users: [{ user_id: 'node-user', start_time: 10, duration: 100 }] } },
    },
    {
      type: 'DEVICE',
      state: { 'gpu-node-01': [{ dev_id: 3, status: 'exclusive', current_users: [{ user_id: 'card-user', start_time: 10, duration: 100 }] }] },
    },
  ], 0, 200);
  const [sample] = _private.lockedCardSamples(intervals, 0, 0, 300);

  assert.equal(sample.lockedCards, CARD_COUNT);
});

test('Lock trend parses China-time occupancy records without an extra UTC shift', () => {
  const intervals = _private.occupancyIntervals([{
    node_key: 'node3',
    start_time_cn: '2026-07-17T07:39:13',
    end_time_cn: '2026-07-17T13:39:13',
  }]);
  const sampleAt = Math.floor(Date.UTC(2026, 6, 16, 23, 40, 0) / 1000);
  const [sample] = _private.lockedCardSamples(intervals, sampleAt, sampleAt, 300);

  assert.equal(sample.lockedCards, CARD_COUNT);
});

test('chart helpers skip empty points, expand the scale, and cap percentage axes at 100%', () => {
  assert.equal(hasFiniteSamples([null, undefined, Number.NaN]), false);
  assert.equal(nearestFiniteIndex([null, 4, null, 7], 2), 1);
  assert.equal(nearestFiniteIndex([null, 4, null, 7], 3), 3);
  assert.equal(nearestFiniteIndex([null, null], 0), -1);
  assert.deepEqual(resolveYAxis([0, 35], 35, [0, 5, 10, 15, 20, 25, 30, 35]), {
    yMax: 35,
    ticks: [0, 5, 10, 15, 20, 25, 30, 35],
  });
  assert.deepEqual(resolveYAxis([0, 36], 35, [0, 5, 10, 15, 20, 25, 30, 35]), {
    yMax: 40,
    ticks: [0, 5, 10, 15, 20, 25, 30, 35, 40],
  });
  assert.deepEqual(resolveYAxis([0, 93], 70, [0, 10, 20, 30, 40, 50, 60, 70], 100), {
    yMax: 100,
    ticks: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  });
  assert.deepEqual(resolveYAxis([0, 150], 35, [0, 5, 10, 15, 20, 25, 30, 35], 100), {
    yMax: 100,
    ticks: Array.from({ length: 21 }, (_, index) => index * 5),
  });
});

test('roster lookup resolves Lock Bot user ids with numeric suffixes to their bare pinyin key', () => {
  assert.equal(teamPrivate.pinyinFromUserId('zhangshaokun02'), 'zhangshaokun');
  assert.equal(teamPrivate.pinyinFromUserId('zhangshaokun'), 'zhangshaokun');
  assert.equal(teamPrivate.pinyinFromUserId('ZhangShaoKun02'), 'zhangshaokun');
  assert.equal(teamPrivate.pinyinFromUserId('lisi_01'), 'lisi');
  assert.equal(teamPrivate.pinyinFromUserId('lisi-3'), 'lisi');
});

test('roster assignment matches exact id before falling back to the pinyin key', () => {
  const assignments = {
    zhangshaokun: { team: 'group-arch', source: 'manual', pending: false },
    lisi02: { team: 'qa', source: 'manual', pending: false },
  };

  assert.equal(teamPrivate.assignmentForUser(assignments, 'zhangshaokun02').team, 'group-arch');
  assert.equal(teamPrivate.assignmentForUser(assignments, 'zhangshaokun').team, 'group-arch');
  assert.equal(teamPrivate.assignmentForUser(assignments, 'lisi02').team, 'qa');
  assert.equal(teamPrivate.assignmentForUser(assignments, 'unlisted07'), null);
});

test('users missing from the roster fall back to general research instead of a hashed team', () => {
  assert.equal(teamPrivate.effectiveTeamForUser({}, 'unlisted-user'), teamPrivate.FALLBACK_TEAM_ID);
  assert.equal(teamPrivate.effectiveTeamForUser({}, 'unlisted-user'), 'general-research');
  assert.equal(teamPrivate.classifyUser({ sampleCount: 100 }, 'unlisted-user').team, 'general-research');
  assert.equal(teamPrivate.classifyUser({ sampleCount: 100 }, 'unlisted-user').pending, true);
});

test('unmapped users are grouped into general research in both ownership and rankings', () => {
  const timestamp = Math.floor(new Date('2026-07-20T00:00:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 52, memory: 72 };
  const assignments = {};
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'unmapped-b', node: 'node1', cards: [0], start: timestamp - 1, end: timestamp + 1 },
  ], new Map([['node1', new Map([[timestamp, cards]])]]), assignments, timestamp - 1, timestamp + 1, 300);
  const payload = teamPrivate.buildDashboardPayload(ownership, { assignments }, timestamp - 1, timestamp + 1, 300);

  assert.equal(ownership.teamPoints.get(timestamp).get('general-research').cardCount, 1);
  assert.equal(payload.rankings[0].team, 'general-research');
  assert.equal(payload.rankings[0].source, 'unlisted');
});

test('roster-mapped users are counted under their organization team via the pinyin key', () => {
  const timestamp = Math.floor(new Date('2026-07-20T00:00:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 52, memory: 72 };
  const assignments = { zhangshaokun: { team: 'group-arch', source: 'manual', pending: false, confidence: 1 } };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'zhangshaokun02', node: 'node1', cards: [0], start: timestamp - 1, end: timestamp + 1 },
  ], new Map([['node1', new Map([[timestamp, cards]])]]), assignments, timestamp - 1, timestamp + 1, 300);
  const payload = teamPrivate.buildDashboardPayload(ownership, { assignments }, timestamp - 1, timestamp + 1, 300);
  const groupArch = payload.teams.find(team => team.id === 'group-arch');

  assert.equal(ownership.teamPoints.get(timestamp).get('group-arch').cardCount, 1);
  assert.equal(groupArch.pendingUserCount, 0);
  assert.equal(payload.rankings[0].userId, 'zhangshaokun02');
  assert.equal(payload.rankings[0].team, 'group-arch');
  assert.equal(payload.rankings[0].source, 'manual');
});

test('average active user counts are rounded up for display', () => {
  assert.equal(formatAverageUserCount(1.01), '2');
  assert.equal(formatAverageUserCount(1.5), '2');
  assert.equal(formatAverageUserCount(2), '2');
  assert.equal(formatAverageUserCount(null), '暂无有效样本');
});

test('team scheduler uses Unix seconds rather than JavaScript milliseconds for its analysis window', () => {
  assert.equal(teamPrivate.currentSampleSeconds(Date.UTC(2026, 6, 27, 11, 43, 17)), 1785152400);
});

test('team scheduler keeps the persisted membership fixed instead of refreshing it hourly', () => {
  const service = createTeamService({ backend: { lockbot: {}, monquery: {} } }, {
    serviceUsername: 'service-user',
    servicePassword: 'service-password',
  });

  assert.equal(service.schedule(), false);
  service.stop();
});

test('team ranges use the same sampling intervals as the cluster trend through 90 days', () => {
  assert.equal(teamPrivate.MAX_RANGE_SECONDS, 90 * 24 * 60 * 60);
  assert.equal(teamPrivate.sampleSecondsForRange(3 * 60 * 60), 60);
  assert.equal(teamPrivate.sampleSecondsForRange(6 * 60 * 60), 120);
  assert.equal(teamPrivate.sampleSecondsForRange(24 * 60 * 60), 240);
  assert.equal(teamPrivate.sampleSecondsForRange(2 * 24 * 60 * 60), 480);
  assert.equal(teamPrivate.sampleSecondsForRange(7 * 24 * 60 * 60), 1200);
  assert.equal(teamPrivate.sampleSecondsForRange(30 * 24 * 60 * 60), 2 * 60 * 60);
  assert.equal(teamPrivate.sampleSecondsForRange(90 * 24 * 60 * 60), 6 * 60 * 60);
});

test('team payload converts multi-hour samples to card-hours and retains the current mapping for 90-day history', () => {
  const timestamp = Math.floor(new Date('2026-07-20T00:00:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 52, memory: 72 };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'mapped-user', node: 'node1', cards: [0], start: timestamp - 1, end: timestamp + 1 },
  ], new Map([['node1', new Map([[timestamp, cards]])]]), {
    'mapped-user': { team: 'training-product', source: 'auto', pending: false, confidence: 0.8 },
  }, timestamp - 1, timestamp + 1, 6 * 60 * 60);
  const payload = teamPrivate.buildDashboardPayload(ownership, {
    generatedAt: '2026-07-28T00:00:00.000Z',
    assignments: { 'mapped-user': { team: 'training-product', source: 'auto', pending: false, confidence: 0.8 } },
  }, timestamp - 1, timestamp + 1, 6 * 60 * 60);
  const training = payload.teams.find(team => team.id === 'training-product');

  assert.equal(payload.range.sampleSeconds, 6 * 60 * 60);
  assert.equal(payload.dataAsOf, timestamp);
  assert.equal(training.cardHours, 6);
  assert.equal(payload.rankings[0].team, 'training-product');
  assert.equal(payload.rankings[0].cardHours, 6);
});

test('team payload exposes historical averages instead of relying on the latest sample', () => {
  const firstTimestamp = Math.floor(new Date('2026-07-20T00:00:00+08:00').getTime() / 1000);
  const secondTimestamp = firstTimestamp + 20 * 60;
  const firstCards = Array.from({ length: CARD_COUNT }, () => ({}));
  const secondCards = Array.from({ length: CARD_COUNT }, () => ({}));
  firstCards[0] = { xpu: 10, memory: 20 };
  secondCards[0] = { xpu: 90, memory: 80 };
  secondCards[1] = { xpu: 50, memory: 60 };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'first-user', node: 'node1', cards: [0], start: firstTimestamp - 1, end: secondTimestamp + 1 },
    { userId: 'second-user', node: 'node1', cards: [1], start: secondTimestamp - 1, end: secondTimestamp + 1 },
  ], new Map([['node1', new Map([
    [firstTimestamp, firstCards],
    [secondTimestamp, secondCards],
  ])]]), {
    'first-user': { team: 'training-product' },
    'second-user': { team: 'training-product' },
  }, firstTimestamp - 1, secondTimestamp + 1, 20 * 60);
  const payload = teamPrivate.buildDashboardPayload(ownership, {
    assignments: {
      'first-user': { team: 'training-product' },
      'second-user': { team: 'training-product' },
    },
  }, firstTimestamp - 1, secondTimestamp + 1, 20 * 60);
  const training = payload.teams.find(team => team.id === 'training-product');

  assert.equal(training.current.xpu, 70, 'the current point stays available for trend consumers');
  assert.equal(training.averages.xpu, 50, 'historical XPU averages every valid locked-card sample');
  assert.equal(training.averages.memory, 160 / 3, 'historical memory average is card-sample weighted');
  assert.equal(training.averages.activeUsers, 1.5, 'active users average across time points');
  assert.equal(training.averages.lockedCardsPerUser, 1, 'card ownership is averaged across active users');
  assert.ok(Math.abs(training.averages.lockRate - training.current.lockRate * .75) < 1e-12, 'node occupancy rate includes every time point');
});

test('team aggregation excludes missing and conflicting card samples from every team', () => {
  const timestamp = Math.floor(new Date('2026-07-20T00:00:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 52, memory: 72 };
  cards[1] = { xpu: 88 };
  cards[2] = { xpu: 61, memory: 71 };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'mapped-user', node: 'node1', cards: [0, 1], start: timestamp - 1, end: timestamp + 1 },
    { userId: 'first-user', node: 'node1', cards: [2], start: timestamp - 1, end: timestamp + 1 },
    { userId: 'second-user', node: 'node1', cards: [2], start: timestamp - 1, end: timestamp + 1 },
  ], new Map([['node1', new Map([[timestamp, cards]])]]), {
    'mapped-user': { team: 'training-product' },
    'first-user': { team: 'inference-product' },
    'second-user': { team: 'toolchain' },
  }, timestamp - 1, timestamp + 1, 3 * 60 * 60);

  assert.equal(ownership.teamPoints.get(timestamp).get('training-product').cardCount, 1);
  assert.equal(ownership.teamPoints.get(timestamp).has('inference-product'), false);
  assert.equal(ownership.teamPoints.get(timestamp).has('toolchain'), false);
  assert.equal(ownership.conflictCardSamples, 1);
});

test('team aggregation excludes a node before its scope effective date', () => {
  const timestamp = Math.floor(new Date('2026-07-23T23:55:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 60, memory: 70 };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'future-node-user', node: 'node60', cards: [0], start: timestamp - 1, end: timestamp + 1 },
  ], new Map([['node60', new Map([[timestamp, cards]])]]), {
    'future-node-user': { team: 'training-product' },
  }, timestamp - 1, timestamp + 1);

  assert.equal(ownership.allTimes.length, 0);
  assert.equal(ownership.userSamples.size, 0);
  assert.equal(ownership.teamPoints.size, 0);
});

test('team metric aggregation keeps excluded-node history before Beijing 08:00 and ignores later samples', () => {
  const before = Math.floor(new Date('2026-08-11T07:55:00+08:00').getTime() / 1000);
  const effectiveFrom = Math.floor(new Date('2026-08-11T08:00:00+08:00').getTime() / 1000);
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 60, memory: 70 };
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'excluded-node-user', node: 'node38', cards: [0], start: before - 1, end: effectiveFrom + 1 },
  ], new Map([['node38', new Map([
    [before, cards],
    [effectiveFrom, cards],
  ])]]), {
    'excluded-node-user': { team: 'training-product' },
  }, before - 1, effectiveFrom + 1, 300);

  assert.deepEqual(ownership.allTimes, [before]);
  assert.equal(ownership.userSamples.get('excluded-node-user').sampleCount, 1);
  assert.equal(ownership.teamPoints.has(effectiveFrom), false);
});

test('team ownership expands node locks, deduplicates one user, and excludes competing users on one card', () => {
  const cards = Array.from({ length: CARD_COUNT }, () => ({}));
  cards[0] = { xpu: 80, memory: 70 };
  cards[1] = { xpu: 60, memory: 65 };
  cards[2] = { xpu: 50, memory: 50 };
  const metrics = new Map([['node1', new Map([[300, cards]])]]);
  const ownership = teamPrivate.aggregateOwnership([
    { userId: 'training-user', node: 'node1', cards: [0, 1], start: 0, end: 600 },
    { userId: 'training-user', node: 'node1', cards: [0], start: 0, end: 600 },
    { userId: 'first-owner', node: 'node1', cards: [2], start: 0, end: 600 },
    { userId: 'second-owner', node: 'node1', cards: [2], start: 0, end: 600 },
  ], metrics, { 'training-user': { team: 'training-product' } }, 0, 600);

  assert.equal(ownership.userSamples.get('training-user').sampleCount, 2);
  assert.equal(ownership.userSamples.has('first-owner'), false);
  assert.equal(ownership.conflictCardSamples, 1);
  assert.equal(ownership.teamPoints.get(300).get('training-product').cardCount, 2);
});

test('team live state expands a node lock to all cards within the requested range', () => {
  const intervals = teamPrivate.stateIntervals([{
    id: 9,
    bot_type: 'NODE',
  }], {
    9: {
      node1: {
        status: 'exclusive',
        current_users: [{ user_id: 'live-user', start_time: 100, duration: 900 }],
      },
    },
  }, 300, 600);

  assert.equal(intervals.length, 1);
  assert.deepEqual(intervals[0].cards, Array.from({ length: CARD_COUNT }, (_, index) => index));
  assert.equal(intervals[0].start, 300);
  assert.equal(intervals[0].end, 600);
});

test('the roster is encrypted at rest and stays readable through the same key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-crypto-'));
  const membershipPath = path.join(directory, 'membership.json');
  const key = Buffer.alloc(32, 7);
  const roster = {
    version: 1,
    generatedAt: '2026-08-12T00:00:00.000Z',
    assignments: { zhangshaokun: { team: 'group-arch', source: 'manual', pending: false, confidence: 1 } },
  };
  try {
    teamPrivate.writeMembership(roster, membershipPath, { key });
    const onDisk = JSON.parse(fs.readFileSync(membershipPath, 'utf8'));

    assert.equal(onDisk.format, 'aes-256-gcm');
    assert.equal(onDisk.assignments, undefined, 'no plaintext assignment may remain on disk');
    assert.equal(fs.readFileSync(membershipPath, 'utf8').includes('zhangshaokun'), false);
    assert.equal((fs.statSync(membershipPath).mode & 0o777), 0o600);

    assert.deepEqual(teamPrivate.readMembership(membershipPath, { key }), roster);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an encrypted roster refuses a wrong key and a tampered payload instead of failing open', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-crypto-bad-'));
  const membershipPath = path.join(directory, 'membership.json');
  const key = Buffer.alloc(32, 7);
  const roster = { version: 1, assignments: { lisi: { team: 'qa', source: 'manual', pending: false } } };
  try {
    teamPrivate.writeMembership(roster, membershipPath, { key });

    assert.throws(() => teamPrivate.readMembership(membershipPath, { key: Buffer.alloc(32, 9) }));
    assert.throws(() => teamPrivate.readMembership(membershipPath, { key: null }), /TEAM_MEMBERSHIP_KEY/);

    const envelope = JSON.parse(fs.readFileSync(membershipPath, 'utf8'));
    const payload = Buffer.from(envelope.payload, 'base64');
    payload[0] ^= 0xff;
    envelope.payload = payload.toString('base64');
    fs.writeFileSync(membershipPath, JSON.stringify(envelope));

    assert.throws(() => teamPrivate.readMembership(membershipPath, { key }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a plaintext roster keeps working so existing deployments survive the upgrade', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-plain-'));
  const membershipPath = path.join(directory, 'membership.json');
  const roster = { version: 1, assignments: { lisi: { team: 'qa', source: 'manual', pending: false } } };
  try {
    fs.writeFileSync(membershipPath, `${JSON.stringify(roster)}\n`);

    assert.deepEqual(teamPrivate.readMembership(membershipPath, { key: null }), roster);
    assert.deepEqual(teamPrivate.readMembership(membershipPath, { key: Buffer.alloc(32, 7) }), roster);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the roster key accepts hex and base64 but rejects a wrong length', () => {
  assert.equal(teamPrivate.membershipKey(() => undefined), null);
  assert.equal(teamPrivate.membershipKey(() => '   '), null);
  assert.equal(teamPrivate.membershipKey(() => 'ab'.repeat(32)).length, 32);
  assert.equal(teamPrivate.membershipKey(() => Buffer.alloc(32, 3).toString('base64')).length, 32);
  assert.throws(() => teamPrivate.membershipKey(() => Buffer.alloc(16, 3).toString('base64')), /32-byte/);
});

test('manual roster entries are left untouched while unlisted users are refreshed as auto', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ timestamp: index * 300, xpu: 75, memory: 80 }));
  const buildUser = userId => ({
    userId,
    sampleCount: samples.length,
    xpuSum: samples.reduce((total, sample) => total + sample.xpu, 0),
    memorySum: samples.reduce((total, sample) => total + sample.memory, 0),
    samples,
    perTime: new Map(samples.map(sample => [sample.timestamp, { xpuSum: sample.xpu, count: 1 }])),
  });
  const result = teamPrivate.mergeAutoAssignments({
    assignments: { manualuser: { team: 'inference-product', source: 'manual', pending: false } },
  }, new Map([
    ['manualuser02', buildUser('manualuser02')],
    ['unlisted-user', buildUser('unlisted-user')],
  ]), 0, 12_000, '2026-07-27T00:00:00.000Z');

  assert.equal(result.assignments.manualuser.team, 'inference-product');
  assert.equal(result.assignments.manualuser.source, 'manual');
  assert.equal(result.assignments.manualuser02, undefined, 'a suffixed id must not shadow its manual roster entry');
  assert.equal(result.assignments['unlisted-user'].team, 'general-research');
  assert.equal(result.assignments['unlisted-user'].source, 'auto');
});

test('team dashboard caches an identical aggregation for one hour and reports its cache status', async () => {
  const startAt = Math.floor(new Date('2026-07-27T00:00:00+08:00').getTime() / 1000);
  const endAt = startAt + 3 * 60 * 60;
  let occupancyCalls = 0;
  let monqueryCalls = 0;
  const membershipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-membership-')), 'membership.json');
  const upstream = createServer((request, response) => {
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([{
        user_id: 'cached-user',
        node_key: 'node1',
        dev_id: 0,
        start_time: startAt,
        end_time: endAt,
      }]));
      return;
    }
    if (request.url === '/api/bots/running-states') {
      response.end(JSON.stringify({ data: {} }));
      return;
    }
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      monqueryCalls += 1;
      response.end(JSON.stringify({ data: [{
        NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
        Items: {
          XPU0_XPU_UTILIZATION: [{ Timestamp: startAt, Value: 50 }],
          XPU0_MEM_UTILIZATION: [{ Timestamp: startAt, Value: 70 }],
        },
      }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTeamService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, {
      membershipPath,
      lockHistoryCache: { read: () => null, save: () => {} },
      currentSeconds: () => endAt + 24 * 60 * 60,
    });
    const first = await service.queryDashboard('Bearer test', startAt, endAt);
    const second = await service.queryDashboard('Bearer test', startAt, endAt);

    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(first.range.sampleSeconds, 60);
    assert.equal(first.dataAsOf, startAt);
    assert.ok(first.cache.expiresAt > startAt);
    assert.equal(occupancyCalls, 1);
    assert.equal(monqueryCalls, 1);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    fs.rmSync(path.dirname(membershipPath), { recursive: true, force: true });
  }
});

test('team occupancy caches complete historical CST days but always requests today', async () => {
  const todayStart = Math.floor(new Date('2026-07-28T00:00:00+08:00').getTime() / 1000);
  const historicDay = todayStart - 24 * 60 * 60;
  const nowSeconds = todayStart + 30 * 60;
  const callsByDate = new Map();
  const recordsByKey = new Map();
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      const date = new URL(request.url, 'http://localhost').searchParams.get('date');
      callsByDate.set(date, (callsByDate.get(date) || 0) + 1);
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const cache = {
    read(dayStart, scopeKey) { return recordsByKey.get(`${dayStart}:${scopeKey}`) || null; },
    save(dayStart, scopeKey, records) { recordsByKey.set(`${dayStart}:${scopeKey}`, records); },
  };
  try {
    const config = { backend: { lockbot: { host: '127.0.0.1', port } } };
    const bots = [{ id: 1, bot_type: 'DEVICE' }];
    await teamPrivate.fetchOccupancy(config, bots, 'Bearer test', historicDay, nowSeconds, cache, nowSeconds);
    await teamPrivate.fetchOccupancy(config, bots, 'Bearer test', historicDay, nowSeconds, cache, nowSeconds);

    assert.equal(recordsByKey.size, 1);
    assert.equal(callsByDate.get('2026-07-27'), 1, 'completed historical day should come from cache on the second request');
    assert.equal(callsByDate.get('2026-07-28'), 2, 'today must bypass the historical cache');
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('team dashboard merges historic cache, today occupancy, and running states across CST midnight', async () => {
  const todayStart = Math.floor(new Date('2026-07-28T00:00:00+08:00').getTime() / 1000);
  const historicAt = todayStart - 5 * 60;
  const databaseAt = todayStart + 5 * 60;
  const runningAt = todayStart + 10 * 60;
  const nowSeconds = todayStart + 15 * 60;
  const historicRecords = [{
    user_id: 'historic-user', node_key: 'node1', dev_id: 0, start_time: historicAt, end_time: historicAt + 5 * 60,
  }];
  let occupancyCalls = 0;
  let runningStateCalls = 0;
  const membershipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-midnight-membership-')), 'membership.json');
  const upstream = createServer((request, response) => {
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([{
        user_id: 'database-user', node_key: 'node1', dev_id: 0, start_time: databaseAt, end_time: databaseAt + 5 * 60,
      }]));
      return;
    }
    if (request.url === '/api/bots/running-states') {
      runningStateCalls += 1;
      response.end(JSON.stringify({ data: {
        1: {
          node1: [{
            dev_id: 0,
            status: 'exclusive',
            current_users: [{ user_id: 'running-user', start_time: runningAt, duration: 5 * 60 }],
          }],
        },
      } }));
      return;
    }
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      const points = [historicAt, databaseAt, runningAt].map(Timestamp => ({ Timestamp, Value: 60 }));
      response.end(JSON.stringify({ data: [{
        NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
        Items: { XPU0_XPU_UTILIZATION: points, XPU0_MEM_UTILIZATION: points },
      }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const cache = {
    read(dayStart) { return dayStart === todayStart - 24 * 60 * 60 ? historicRecords : null; },
    save: () => { throw new Error('historical cache should not be rewritten on a hit'); },
  };
  try {
    const service = createTeamService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { membershipPath, lockHistoryCache: cache, currentSeconds: () => nowSeconds });
    const result = await service.queryDashboard('Bearer test', historicAt, nowSeconds);

    assert.equal(occupancyCalls, 1, 'only today occupancy should be requested');
    assert.equal(runningStateCalls, 1);
    assert.deepEqual(result.rankings.map(row => row.userId).sort(), ['database-user', 'historic-user', 'running-user']);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    fs.rmSync(path.dirname(membershipPath), { recursive: true, force: true });
  }
});

test('server time offset defaults to zero and now() falls back to the local clock', () => {
  assert.equal(currentOffsetMs(), 0);
  const before = Date.now();
  const nowMs = now().getTime();
  const after = Date.now();
  assert.ok(nowMs >= before && nowMs <= after);
});

test('syncing the server time offset corrects a skewed local clock', async (t) => {
  const originalFetch = globalThis.fetch;
  const serverNow = Date.now() + 60 * 60 * 1000;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ now: serverNow }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await syncServerTimeOffset();

  assert.ok(Math.abs(now().getTime() - serverNow) < 1000);
});

test('a failed server time request leaves the previous offset untouched', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  t.after(() => { globalThis.fetch = originalFetch; });

  const offsetBefore = currentOffsetMs();
  await syncServerTimeOffset();

  assert.equal(currentOffsetMs(), offsetBefore);
});

test('a flaky bot list does not fragment the lock history cache key', async () => {
  let botListVariant = 0;
  let occupancyCalls = 0;
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      botListVariant += 1;
      const bots = botListVariant === 1
        ? [{ id: 1, bot_type: 'DEVICE' }]
        : [{ id: 1, bot_type: 'DEVICE' }, { id: 2, bot_type: 'NODE' }];
      response.end(JSON.stringify(bots));
      return;
    }
    if (request.url.startsWith('/api/bots/')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const recordsByKey = new Map();
  const cache = {
    read(dayStart, scopeKey) { return recordsByKey.get(`${dayStart}:${scopeKey}`) || null; },
    save(dayStart, scopeKey, records) { recordsByKey.set(`${dayStart}:${scopeKey}`, records); },
  };
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: cache });

    await service.query(0, 300, 'Bearer test', null, 300);
    await service.query(0, 300, 'Bearer test', null, 300);

    assert.equal(recordsByKey.size, 1, 'a differently-ordered/sized bot list should reuse the same cache entry');
    assert.equal(occupancyCalls, 1, 'the second request should be served from cache, not refetched');
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('pruning the lock history cache removes only files older than the max age', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-history-'));
  try {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const oldKey = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}-${String(oldDate.getDate()).padStart(2, '0')}`;
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentKey = `${recentDate.getFullYear()}-${String(recentDate.getMonth() + 1).padStart(2, '0')}-${String(recentDate.getDate()).padStart(2, '0')}`;
    fs.writeFileSync(path.join(directory, `abc123-${oldKey}.json`), '{}');
    fs.writeFileSync(path.join(directory, `abc123-${recentKey}.json`), '{}');
    fs.writeFileSync(path.join(directory, 'not-a-cache-file.json'), '{}');
    fs.writeFileSync(path.join(directory, 'abc123-58511-06-25.json'), '{}');

    const result = pruneLockHistoryCache(180, directory);

    assert.equal(result.removed, 1, 'only the genuinely old dated file should be removed');
    const remaining = fs.readdirSync(directory).sort();
    assert.deepEqual(remaining, [`abc123-${recentKey}.json`, 'abc123-58511-06-25.json', 'not-a-cache-file.json'].sort());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic refresh only applies to a current range no longer than 24 hours', () => {
  const now = Date.UTC(2026, 6, 16, 8, 0, 0);
  assert.equal(shouldAutoRefresh(now - 3 * 60 * 60 * 1000, now - 60_000, now), true);
  assert.equal(shouldAutoRefresh(now - 24 * 60 * 60 * 1000, now - 4 * 60_000, now), true);
  assert.equal(shouldAutoRefresh(now - 24 * 60 * 60 * 1000, now - 6 * 60_000, now), true);
  assert.equal(shouldAutoRefresh(now - 24 * 60 * 60 * 1000, now - 6 * 60_000 - 1, now), false);
  assert.equal(shouldAutoRefresh(now - 2 * 24 * 60 * 60 * 1000, now, now), false);
  assert.equal(shouldAutoRefresh(now - 60_000, now + 60_000, now), false);
  assert.equal(nextAutoRefreshDelay(now), AUTO_REFRESH_INTERVAL_MS);
  assert.equal(nextAutoRefreshDelay(now + 60_000), 4 * 60 * 1000);
});

test('cluster trend starts Lock Bot lookup while Monquery is still pending', async () => {
  let monqueryDone = false;
  let lockStartedDuringMonquery = false;
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      setTimeout(() => {
        monqueryDone = true;
        response.end(JSON.stringify({ data: [] }));
      }, 60);
      return;
    }
    if (request.url === '/api/bots') {
      lockStartedDuringMonquery = !monqueryDone;
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(0, 300, 'Bearer test', ['node1'], 300);

    assert.deepEqual(result.times, [0, 300]);
    assert.equal(lockStartedDuringMonquery, true);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('Lock Bot BDC cards are excluded from the computation-node trend', async () => {
  const monqueryNamespaces = [];
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      monqueryNamespaces.push(new URL(request.url, 'http://localhost').searchParams.get('namespaces'));
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      response.end(JSON.stringify([{
        node_key: 'bdc9',
        start_time: 0,
        end_time: 300,
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(0, 300, 'Bearer test', null, 300);

    assert.equal(result.targetNodes.length, 73);
    assert.equal(result.targetNodes.includes('bdc9'), false);
    assert.equal(result.targetNodes.includes('node70'), true);
    assert.equal(result.targetNodes.includes('node83'), true);
    assert.equal(result.targetNodes.includes('node84'), true);
    assert.equal(result.lock[0], 0);
    assert.equal(monqueryNamespaces.length, 3);
    assert.equal(monqueryNamespaces.some(namespaces => /bdc|NaN/i.test(namespaces)), false);
    assert.equal(monqueryNamespaces.some(namespaces => namespaces.includes('wxtky02-p800-8nic-vd-node70.wxtky02')), false);
    assert.equal(monqueryNamespaces.some(namespaces => namespaces.includes('wxtky02-p800-8nic-vd-node79.wxtky02')), false);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('a failed Lock Bot occupancy request produces an unavailable lock trend', async () => {
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }, { id: 2, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(503);
    response.end(JSON.stringify({ error: 'unavailable' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  let cacheWrites = 0;
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => { cacheWrites += 1; } } });
    const result = await service.query(0, 300, 'Bearer test', null, 300);

    assert.deepEqual(result.lock, [null, null]);
    assert.deepEqual(result.lockStatus, { complete: false, failureCount: 1 });
    assert.equal(cacheWrites, 0);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('complete historical Lock Bot days persist while the Bot list is shared briefly in memory', async () => {
  let monqueryCalls = 0;
  let botCalls = 0;
  let occupancyCalls = 0;
  const recordsByKey = new Map();
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      monqueryCalls += 1;
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      botCalls += 1;
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const cache = {
    read(dayStart, scopeKey) { return recordsByKey.get(`${dayStart}:${scopeKey}`) || null; },
    save(dayStart, scopeKey, records) { recordsByKey.set(`${dayStart}:${scopeKey}`, records); },
  };
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: cache });
    await Promise.all([
      service.query(0, 300, 'Bearer test', null, 300),
      service.query(0, 300, 'Bearer test', null, 300),
    ]);
    await service.query(0, 300, 'Bearer test', null, 300);

    assert.equal(monqueryCalls, 6);
    assert.equal(botCalls, 1);
    assert.equal(occupancyCalls, 1);
    assert.equal(recordsByKey.size, 1);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('live Lock Bot cache shares concurrent loads, expires on schedule, and skips incomplete results', async () => {
  let clock = 0;
  let loads = 0;
  const cache = createLockBotLiveCache({ nowMs: () => clock, ttlMs: 60_000 });
  const load = async () => ({ sequence: ++loads, complete: true });

  const [first, concurrent] = await Promise.all([
    cache.get('occupancy:today', load, value => value.complete),
    cache.get('occupancy:today', load, value => value.complete),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(loads, 1);

  clock = 59_999;
  assert.equal((await cache.get('occupancy:today', load, value => value.complete)).sequence, 1);
  assert.equal(loads, 1);

  clock = 60_000;
  assert.equal((await cache.get('occupancy:today', load, value => value.complete)).sequence, 2);
  assert.equal(loads, 2);

  const incomplete = async () => ({ sequence: ++loads, complete: false });
  await cache.get('occupancy:partial', incomplete, value => value.complete);
  await cache.get('occupancy:partial', incomplete, value => value.complete);
  assert.equal(loads, 4);
});

test('Monquery trends only query nodes active at each scope boundary', async (t) => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-07-28T00:00:00+08:00').getTime();
  t.after(() => { Date.now = originalDateNow; });

  const firstBefore = Math.floor(new Date('2026-07-23T23:55:00+08:00').getTime() / 1000);
  const firstAfter = Math.floor(new Date('2026-07-24T00:00:00+08:00').getTime() / 1000);
  const monqueryRequests = [];
  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      const params = new URL(request.url, 'http://localhost').searchParams;
      const nodes = params.get('namespaces').match(/node\d+/g).map(name => Number(name.slice(4)));
      const start = params.get('start');
      const end = params.get('end');
      monqueryRequests.push({ start, nodes });
      const timestamps = [start, end].map(value => Math.floor(new Date(
        `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
      ).getTime() / 1000));
      response.end(JSON.stringify({ data: nodes.map(node => {
        const xpu = node === 1 ? 10 : 90;
        const memory = node === 1 ? 20 : 80;
        return {
          NameSpace: `node${node}`,
          Items: {
            XPU_AVERAGE_UTILIZATION: timestamps.map(Timestamp => ({ Timestamp, Value: xpu })),
            XPU0_MEM_UTILIZATION: timestamps.map(Timestamp => ({ Timestamp, Value: memory })),
          },
        };
      }) }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const firstExpansion = await service.query(firstBefore, firstAfter, 'Bearer test', ['node1', 'node60'], 300);

    assert.deepEqual(firstExpansion.xpu, [10, 50]);
    assert.deepEqual(firstExpansion.memory, [20, 50]);
    const nodesByWindowStart = new Map(monqueryRequests.map(request => [request.start, request.nodes]));
    assert.deepEqual(nodesByWindowStart.get('20260723235500'), [1]);
    assert.deepEqual(nodesByWindowStart.get('20260724000000'), [1, 60]);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('metric exclusions make post-boundary trends identical with or without the excluded nodes', async () => {
  const before = Math.floor(new Date('2026-08-11T07:55:00+08:00').getTime() / 1000);
  const effectiveFrom = Math.floor(new Date('2026-08-11T08:00:00+08:00').getTime() / 1000);
  const monqueryRequests = [];
  const upstream = createServer((request, response) => {
    if (!request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const params = new URL(request.url, 'http://localhost').searchParams;
    const nodes = params.get('namespaces').match(/node\d+/g).map(name => Number(name.slice(4)));
    const timestamps = [params.get('start'), params.get('end')].map(value => Math.floor(new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`
    ).getTime() / 1000));
    monqueryRequests.push({ start: params.get('start'), nodes });
    response.end(JSON.stringify({ data: nodes.map(node => ({
      NameSpace: `node${node}`,
      Items: {
        XPU_AVERAGE_UTILIZATION: timestamps.map(Timestamp => ({ Timestamp, Value: node === 38 ? 90 : 10 })),
        XPU0_MEM_UTILIZATION: timestamps.map(Timestamp => ({ Timestamp, Value: node === 38 ? 80 : 20 })),
      },
    })) }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const crossing = await service.query(before, effectiveFrom, null, ['node1', 'node38'], 300);
    const activeOnly = await service.query(effectiveFrom, effectiveFrom, null, ['node1'], 300);
    const excludedOnly = await service.query(effectiveFrom, effectiveFrom, null, ['node38'], 300);

    assert.deepEqual(crossing.xpu, [50, 10]);
    assert.deepEqual(crossing.memory, [50, 20]);
    assert.deepEqual([crossing.xpu[1]], activeOnly.xpu);
    assert.deepEqual([crossing.memory[1]], activeOnly.memory);
    assert.deepEqual(excludedOnly.xpu, [null]);
    assert.deepEqual(excludedOnly.memory, [null]);
    const nodesByWindowStart = new Map(monqueryRequests.map(request => [request.start, request.nodes]));
    assert.deepEqual(nodesByWindowStart.get('20260811075500'), [1, 38]);
    assert.deepEqual(nodesByWindowStart.get('20260811080000'), [1]);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('lock rate adds node60 through node69 from their effective date', async (t) => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-07-28T00:00:00+08:00').getTime();
  t.after(() => { Date.now = originalDateNow; });

  const beforeDayStart = Math.floor(new Date('2026-07-23T00:00:00+08:00').getTime() / 1000);
  const afterDayStart = Math.floor(new Date('2026-07-24T00:00:00+08:00').getTime() / 1000);
  const oldGroupCount = clusterScope.nodeGroups
    .filter(group => group.effectiveFrom < '2026-07-24')
    .flatMap(group => group.nodeIds)
    .length;
  const newGroupCount = clusterScope.nodeGroups.find(group => group.effectiveFrom === '2026-07-24').nodeIds.length;
  const oldTotalCards = oldGroupCount * clusterScope.cardsPerNode;
  const newTotalCards = (oldGroupCount + newGroupCount) * clusterScope.cardsPerNode;

  assert.equal(oldGroupCount, 46);
  assert.equal(newGroupCount, 10);

  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'NODE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      // node60 跨越生效日期的锁定不能出现在生效前的分子中。
      response.end(JSON.stringify([{
        node_key: 'node1',
        dev_id: 0,
        start_time: beforeDayStart,
        end_time: afterDayStart + 24 * 60 * 60,
      }, {
        node_key: 'node60',
        dev_id: 0,
        start_time: beforeDayStart,
        end_time: afterDayStart + 24 * 60 * 60,
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(beforeDayStart, afterDayStart, 'Bearer test', null, 300);

    const beforeIndex = 0;
    const afterIndex = result.times.indexOf(afterDayStart);
    assert.ok(afterIndex > 0, 'afterDayStart sample should be present in the range');
    assert.equal(result.lock[beforeIndex], 1 / oldTotalCards * 100);
    assert.equal(result.lock[afterIndex], 2 / newTotalCards * 100);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('lock rate adds node70 through node79 at 10:00 China time', async (t) => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-07-30T00:00:00+08:00').getTime();
  t.after(() => { Date.now = originalDateNow; });

  const beforeActivation = Math.floor(new Date('2026-07-29T09:55:00+08:00').getTime() / 1000);
  const atActivation = Math.floor(new Date('2026-07-29T10:00:00+08:00').getTime() / 1000);
  const priorNodeCount = clusterScope.nodeGroups
    .filter(group => group.effectiveFrom < '2026-07-29T10:00:00+08:00')
    .flatMap(group => group.nodeIds)
    .length;
  const activationNodeCount = clusterScope.nodeGroups
    .find(group => group.effectiveFrom === '2026-07-29T10:00:00+08:00')
    .nodeIds
    .length;
  const priorTotalCards = priorNodeCount * clusterScope.cardsPerNode;
  const activeTotalCards = (priorNodeCount + activationNodeCount) * clusterScope.cardsPerNode;

  assert.equal(priorNodeCount, 56);
  assert.equal(activationNodeCount, 10);

  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'NODE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      response.end(JSON.stringify([{
        node_key: 'node1',
        dev_id: 0,
        start_time: beforeActivation,
        end_time: atActivation + 24 * 60 * 60,
      }, {
        node_key: 'node70',
        dev_id: 0,
        start_time: beforeActivation,
        end_time: atActivation + 24 * 60 * 60,
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(beforeActivation, atActivation, 'Bearer test', null, 300);

    assert.equal(result.lock[0], 1 / priorTotalCards * 100);
    assert.equal(result.lock[result.times.indexOf(atActivation)], 2 / activeTotalCards * 100);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('lock rate adds node83 and node84 at their 2026-08-12 18:00 China-time boundary', async (t) => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-08-13T00:00:00+08:00').getTime();
  t.after(() => { Date.now = originalDateNow; });

  const beforeActivation = Math.floor(new Date('2026-08-12T17:55:00+08:00').getTime() / 1000);
  const atActivation = Math.floor(new Date('2026-08-12T18:00:00+08:00').getTime() / 1000);
  const activation = clusterScope.nodeGroups.find(group => group.effectiveFrom === '2026-08-12T18:00:00+08:00');
  const exclusionIds = new Set((clusterScope.lockUsageExclusions || []).flatMap(group => group.nodeIds));
  const priorNodeCount = clusterScope.nodeGroups
    .filter(group => group.effectiveFrom < '2026-08-12T18:00:00+08:00')
    .flatMap(group => group.nodeIds)
    .filter(nodeId => !exclusionIds.has(nodeId))
    .length;
  const activationNodeCount = activation.nodeIds.filter(nodeId => !exclusionIds.has(nodeId)).length;
  const priorTotalCards = priorNodeCount * clusterScope.cardsPerNode;
  const activeTotalCards = (priorNodeCount + activationNodeCount) * clusterScope.cardsPerNode;

  assert.deepEqual(activation.nodeIds, [83, 84]);
  assert.equal(priorNodeCount, 68);
  assert.equal(activationNodeCount, 2);

  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'NODE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      response.end(JSON.stringify([{
        node_key: 'node1',
        dev_id: 0,
        start_time: beforeActivation,
        end_time: atActivation + 24 * 60 * 60,
      }, {
        node_key: 'node83',
        dev_id: 0,
        start_time: beforeActivation,
        end_time: atActivation + 24 * 60 * 60,
      }]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(beforeActivation, atActivation, 'Bearer test', null, 300);

    assert.equal(result.lock[0], 1 / priorTotalCards * 100);
    assert.equal(result.lock[result.times.indexOf(atActivation)], 2 / activeTotalCards * 100);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('lock rate excludes node38, node68, and node69 from its scope at the removal boundary', async (t) => {
  const originalDateNow = Date.now;
  Date.now = () => new Date('2026-08-06T00:00:00+08:00').getTime();
  t.after(() => { Date.now = originalDateNow; });

  const beforeRemoval = Math.floor(new Date('2026-08-04T23:55:00+08:00').getTime() / 1000);
  const removalTime = Math.floor(new Date('2026-08-05T00:00:00+08:00').getTime() / 1000);
  // 该边界处 node83、node84 尚未上线（2026-08-12 生效），历史分母只含当时已生效节点。
  const activeNodeCount = clusterScope.nodeGroups
    .filter(group => group.effectiveFrom < '2026-08-05T00:00:00+08:00')
    .flatMap(group => group.nodeIds)
    .length;
  const originalTotalCards = activeNodeCount * clusterScope.cardsPerNode;
  const exclusion = clusterScope.lockUsageExclusions.find(group => group.effectiveFrom === '2026-08-05T00:00:00+08:00');
  const reducedTotalCards = (activeNodeCount - exclusion.nodeIds.length) * clusterScope.cardsPerNode;
  const monqueryNodes = new Set();

  assert.deepEqual(exclusion.nodeIds, [38, 68, 69]);
  assert.equal(originalTotalCards, 528);
  assert.equal(reducedTotalCards, 504);

  const upstream = createServer((request, response) => {
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      const namespaces = new URL(request.url, 'http://localhost').searchParams.get('namespaces');
      for (const name of namespaces.match(/node\d+/g) || []) monqueryNodes.add(Number(name.slice(4)));
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      response.end(JSON.stringify([
        { node_key: 'node1', dev_id: 0, start_time: beforeRemoval, end_time: removalTime + 24 * 60 * 60 },
        { node_key: 'node38', dev_id: 0, start_time: beforeRemoval, end_time: removalTime + 24 * 60 * 60 },
        { node_key: 'node68', dev_id: 0, start_time: beforeRemoval, end_time: removalTime + 24 * 60 * 60 },
        { node_key: 'node69', dev_id: 0, start_time: beforeRemoval, end_time: removalTime + 24 * 60 * 60 },
      ]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  try {
    const service = createTrendService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, { lockHistoryCache: { read: () => null, save: () => {} } });
    const result = await service.query(beforeRemoval, removalTime, 'Bearer test', null, 300);

    assert.equal(result.lock[0], 4 / originalTotalCards * 100);
    assert.equal(result.lock[result.times.indexOf(removalTime)], 1 / reducedTotalCards * 100);
    assert.deepEqual([...monqueryNodes].filter(node => [38, 68, 69].includes(node)).sort((a, b) => a - b), [38, 68, 69]);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test('team access keeps the current full dashboard behavior until organization access is enabled', async () => {
  let identityCalls = 0;
  const access = createTeamAccessService({}, {
    resolveIdentity: async () => { identityCalls += 1; return 'leader-a'; },
  });

  const result = await access.authorize('Bearer test');

  assert.deepEqual(result, { enabled: false, mode: 'all', teamIds: null, username: null, cacheKey: 'disabled' });
  assert.equal(identityCalls, 0);
});

test('application login keeps the Lock Bot service credential on the server and scopes sessions by whitelist role', async () => {
  let clock = 0;
  const requests = [];
  const environment = {
    LOCKBOT_SERVICE_USERNAME: 'service-account',
    LOCKBOT_SERVICE_PASSWORD: 'service-password',
    XPU_MONITOR_BOSS_PASSWORD: 'boss-password',
    XPU_MONITOR_USER_PASSWORD: 'user-password',
    XPU_MONITOR_ALICE_PASSWORD: 'alice-password',
  };
  const auth = createAppAuthService({
    backend: { lockbot: { host: 'lockbot.internal', port: 8875 } },
    appAuth: {
      sessionTtlSeconds: 60,
      lockbotTokenTtlSeconds: 60,
      accounts: [
        { username: 'boss', passwordEnv: 'XPU_MONITOR_BOSS_PASSWORD', role: 'admin' },
        { username: 'user', passwordEnv: 'XPU_MONITOR_USER_PASSWORD', role: 'admin' },
        { username: 'alice', passwordEnv: 'XPU_MONITOR_ALICE_PASSWORD', team: { id: 'team-a', label: 'A 团队' } },
      ],
    },
  }, {
    nowMs: () => clock,
    getEnvironment: name => environment[name],
    requestJson: async (...args) => {
      requests.push(args);
      return { access_token: 'service-token' };
    },
  });

  await assert.rejects(() => auth.login('boss', 'wrong'), error => error.statusCode === 401);
  const boss = await auth.login('BOSS', 'boss-password');
  assert.equal(boss.username, 'boss');
  assert.equal('password' in boss, false);
  assert.equal((await auth.authorize(`Bearer ${boss.token}`)).mode, 'all');

  const user = await auth.login('user', 'user-password');
  assert.equal((await auth.authorize(`Bearer ${user.token}`)).mode, 'all');

  const serviceAuthorization = await auth.getLockBotAuthorization();
  assert.equal(serviceAuthorization, 'Bearer service-token');
  assert.equal(await auth.getLockBotAuthorization(), serviceAuthorization);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2], '/api/auth/login');
  assert.deepEqual(requests[0][3].body, { username: 'service-account', password: 'service-password' });

  const alice = await auth.login('alice', 'alice-password');
  const aliceAccess = await auth.authorize(`Bearer ${alice.token}`);
  assert.deepEqual(aliceAccess.teamIds, ['team-a']);
  assert.deepEqual((await auth.resolveMembership(['Alice', 'unlisted'])).assignments, {
    Alice: { team: 'team-a', source: 'whitelist', pending: false, confidence: 1 },
  });

  clock = 60_001;
  await assert.rejects(() => auth.authorize(`Bearer ${boss.token}`), error => error.statusCode === 401);
});

test('team access limits a leader to their primary organization team and recognizes normalized administrators', async () => {
  const calls = [];
  const access = createTeamAccessService({
    teamAccess: { enabled: true, globalAdmins: ['BigBoss'] },
  }, {
    resolveIdentity: async authorization => authorization === 'Bearer boss' ? 'bigboss' : 'Leader-A',
    resolveUserTeam: async username => {
      calls.push(username);
      return { id: username === 'leader-a' ? 'team-a' : 'team-b', label: username === 'leader-a' ? 'Alpha' : 'Beta', primary: true };
    },
  });

  const leader = await access.authorize('Bearer leader');
  const administrator = await access.authorize('Bearer boss');

  assert.deepEqual(leader.teamIds, ['team-a']);
  assert.equal(leader.mode, 'team');
  assert.equal(administrator.mode, 'all');
  assert.deepEqual(calls, ['leader-a']);
});

test('enabled team access fails closed until the current-user and organization contracts are configured', async () => {
  const access = createTeamAccessService({ teamAccess: { enabled: true } });

  await assert.rejects(
    () => access.authorize('Bearer test'),
    error => error.statusCode === 503 && /identity\.path/.test(error.message),
  );
});

test('organization membership retains the Lock Bot user id while grouping by organization team', async () => {
  const access = createTeamAccessService({ teamAccess: { enabled: true } }, {
    resolveUserTeam: async username => username === 'alice'
      ? { id: 'team-a', label: 'Alpha', primary: true }
      : { id: 'team-b', label: 'Beta', primary: true },
  });

  const membership = await access.resolveMembership(['Alice', 'bob']);

  assert.equal(membership.assignments.Alice.team, 'team-a');
  assert.equal(membership.assignments.bob.team, 'team-b');
  assert.deepEqual(membership.teams.map(team => team.id), ['team-a', 'team-b']);
});

test('team dashboard payload removes every non-authorized team and ranking', () => {
  const payload = teamPrivate.scopeDashboardPayload({
    teams: [{ id: 'team-a' }, { id: 'team-b' }],
    rankings: [{ userId: 'alice', team: 'team-a' }, { userId: 'bob', team: 'team-b' }],
  }, { enabled: true, mode: 'team', teamIds: ['team-a'] });

  assert.deepEqual(payload.teams.map(team => team.id), ['team-a']);
  assert.deepEqual(payload.rankings.map(row => row.userId), ['alice']);
  assert.deepEqual(payload.access, { enabled: true, mode: 'team', teamIds: ['team-a'] });
});

test('organization-scoped team queries bypass the full-dashboard cache', async () => {
  const startAt = Math.floor(new Date('2026-07-27T00:00:00+08:00').getTime() / 1000);
  const endAt = startAt + 3 * 60 * 60;
  let occupancyCalls = 0;
  const membershipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-access-membership-')), 'membership.json');
  const upstream = createServer((request, response) => {
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([{
        user_id: 'alice', node_key: 'node1', dev_id: 0, start_time: startAt, end_time: endAt,
      }]));
      return;
    }
    if (request.url === '/api/bots/running-states') {
      response.end(JSON.stringify({ data: {} }));
      return;
    }
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      response.end(JSON.stringify({ data: [{
        NameSpace: 'wxtky02-p800-backup-8nic-vd-node1.wxtky02',
        Items: {
          XPU0_XPU_UTILIZATION: [{ Timestamp: startAt, Value: 50 }],
          XPU0_MEM_UTILIZATION: [{ Timestamp: startAt, Value: 70 }],
        },
      }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const teamAccess = {
    enabled: true,
    authorize: async () => ({ enabled: true, mode: 'team', teamIds: ['team-a'], cacheKey: 'team:leader:team-a' }),
    resolveMembership: async () => ({
      version: 'organization:team-a', generatedAt: null, window: null, lastError: null,
      assignments: { alice: { team: 'team-a', source: 'organization', pending: false, confidence: 1 } },
      teams: [{ id: 'team-a', label: 'Alpha' }],
    }),
  };
  try {
    const service = createTeamService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, {
      membershipPath,
      lockHistoryCache: { read: () => null, save: () => {} },
      currentSeconds: () => endAt + 24 * 60 * 60,
      teamAccess,
    });
    const first = await service.queryDashboard('Bearer leader', startAt, endAt);
    const second = await service.queryDashboard('Bearer leader', startAt, endAt);

    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, false);
    assert.equal(first.cache.expiresAt, null);
    assert.deepEqual(first.teams.map(team => team.id), ['team-a']);
    assert.deepEqual(first.rankings.map(row => row.userId), ['alice']);
    assert.equal(occupancyCalls, 2);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    fs.rmSync(path.dirname(membershipPath), { recursive: true, force: true });
  }
});

test('team dashboard phases return one team first, reuse occupancy, and bind bootstrap to the account and range', async () => {
  const startAt = Math.floor(new Date('2026-07-27T00:00:00+08:00').getTime() / 1000);
  const endAt = startAt + 3 * 60 * 60;
  let occupancyCalls = 0;
  let clock = 0;
  const metricRequests = [];
  const membershipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-phase-')), 'membership.json');
  const upstream = createServer((request, response) => {
    if (request.url === '/api/bots') {
      response.end(JSON.stringify([{ id: 1, bot_type: 'DEVICE' }]));
      return;
    }
    if (request.url.startsWith('/api/bots/1/occupancy')) {
      occupancyCalls += 1;
      response.end(JSON.stringify([
        { user_id: 'alice', node_key: 'node1', dev_id: 0, start_time: startAt, end_time: endAt },
        { user_id: 'bob', node_key: 'node2', dev_id: 0, start_time: startAt, end_time: endAt },
      ]));
      return;
    }
    if (request.url.startsWith('/monquery/getHistoryitemdata')) {
      const requestedNodes = new URL(request.url, 'http://localhost').searchParams.get('namespaces').split(',')
        .map(value => value.match(/node(\d+)\.wxtky02$/)?.[1])
        .filter(Boolean)
        .map(Number);
      metricRequests.push(requestedNodes);
      response.end(JSON.stringify({ data: requestedNodes.map(nodeId => ({
        NameSpace: `wxtky02-p800-backup-8nic-vd-node${nodeId}.wxtky02`,
        Items: {
          XPU0_XPU_UTILIZATION: [{ Timestamp: startAt, Value: nodeId === 1 ? 50 : 60 }],
          XPU0_MEM_UTILIZATION: [{ Timestamp: startAt, Value: nodeId === 1 ? 70 : 80 }],
        },
      })) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address();
  const teamAccess = {
    enabled: true,
    authorize: async authorization => {
      if (authorization === 'Bearer leader') return { enabled: true, mode: 'team', teamIds: ['team-a'], cacheKey: 'team:leader:team-a' };
      return { enabled: true, mode: 'all', teamIds: null, cacheKey: authorization === 'Bearer other' ? 'admin:other' : 'admin:boss' };
    },
    resolveMembership: async () => ({
      version: 'organization:team-a,team-b', generatedAt: null, window: null, lastError: null,
      assignments: {
        alice: { team: 'team-a', source: 'organization', pending: false, confidence: 1 },
        bob: { team: 'team-b', source: 'organization', pending: false, confidence: 1 },
      },
      teams: [{ id: 'team-a', label: 'Alpha' }, { id: 'team-b', label: 'Beta' }],
    }),
  };
  try {
    const service = createTeamService({
      backend: {
        lockbot: { host: '127.0.0.1', port },
        monquery: { host: '127.0.0.1', port },
      },
    }, {
      membershipPath,
      lockHistoryCache: { read: () => null, save: () => {} },
      currentSeconds: () => endAt + 24 * 60 * 60,
      nowMs: () => clock,
      phaseContextTtlMs: 1_000,
      random: () => 0,
      teamAccess,
    });

    const initial = await service.queryDashboard('Bearer boss', startAt, endAt, { phase: 'initial' });
    assert.equal(initial.progressive.complete, false);
    assert.equal(initial.progressive.initialTeamId, 'team-a');
    assert.ok(initial.progressive.bootstrapId);
    assert.deepEqual(initial.teams.map(team => team.id), ['team-a']);
    assert.deepEqual(initial.rankings.map(row => row.userId), ['alice']);
    assert.deepEqual(metricRequests, [[1]]);
    assert.equal(occupancyCalls, 1);

    await assert.rejects(
      () => service.queryDashboard('Bearer other', startAt, endAt, { phase: 'full', bootstrapId: initial.progressive.bootstrapId }),
      error => error.statusCode === 403,
    );
    const complete = await service.queryDashboard('Bearer boss', startAt, endAt, { phase: 'full', bootstrapId: initial.progressive.bootstrapId });
    assert.equal(complete.progressive.complete, true);
    assert.deepEqual(complete.teams.map(team => team.id), ['team-a', 'team-b']);
    assert.deepEqual(metricRequests, [[1], [2]]);
    assert.equal(occupancyCalls, 1);

    const retainedTeam = await service.queryDashboard('Bearer boss', startAt, endAt, { phase: 'initial', initialTeamId: 'team-b' });
    assert.equal(retainedTeam.progressive.initialTeamId, 'team-b');
    assert.deepEqual(retainedTeam.teams.map(team => team.id), ['team-b']);

    const leader = await service.queryDashboard('Bearer leader', startAt, endAt, { phase: 'initial' });
    assert.equal(leader.progressive.complete, true);
    assert.equal(leader.progressive.bootstrapId, null);
    assert.deepEqual(leader.teams.map(team => team.id), ['team-a']);

    const expiring = await service.queryDashboard('Bearer boss', startAt, endAt, { phase: 'initial', initialTeamId: 'team-b' });
    clock = 1_001;
    await assert.rejects(
      () => service.queryDashboard('Bearer boss', startAt, endAt, { phase: 'full', bootstrapId: expiring.progressive.bootstrapId }),
      error => error.statusCode === 400 && /expired/.test(error.message),
    );
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    fs.rmSync(path.dirname(membershipPath), { recursive: true, force: true });
  }
});
