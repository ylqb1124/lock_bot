import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import clusterScope from '../shared/cluster-scope.json' with { type: 'json' };
import { adaptNodeData } from '../src/services/adapter.js';
import { AUTO_REFRESH_INTERVAL_MS, nextAutoRefreshDelay, shouldAutoRefresh } from '../src/services/auto-refresh.js';
import { hasFiniteSamples, nearestFiniteIndex, resolveYAxis } from '../src/services/chart-data.js';
import { CARD_COUNT, mergeLockBotStates } from '../src/services/cluster-state.js';
import { CURRENT_MONQUERY_TIMEOUT_MS, DEFAULT_MONQUERY_TIMEOUT_MS } from '../src/services/api.js';
import { currentOffsetMs, now, syncServerTimeOffset } from '../src/services/server-time.js';

const require = createRequire(import.meta.url);
const { createTrendService, _private } = require('../server/trend-service.cjs');
const { pruneLockHistoryCache } = _private;
const { _private: teamPrivate } = require('../server/team-service.cjs');

function emptyDeviceState() {
  return Array.from({ length: CARD_COUNT }, (_, devId) => ({ dev_id: devId, status: 'idle', current_users: [] }));
}

test('cluster scope uses the current 56-node, 448-card computation denominator', () => {
  assert.equal(clusterScope.nodeIds.length, 56);
  assert.equal(clusterScope.cardsPerNode, 8);
  assert.equal(clusterScope.nodeIds.length * clusterScope.cardsPerNode, 448);
  assert.equal(clusterScope.nodeIds.includes(15), false);
  assert.equal(clusterScope.nodeIds.includes(16), false);
  assert.equal(clusterScope.nodeIds.includes(60), true);
  assert.equal(clusterScope.nodeIds.includes(69), true);
  assert.equal(clusterScope.nodeIds.includes(70), false);
  assert.equal(clusterScope.nodeIds.includes(79), false);
});

test('nodeGroups in cluster scope stay consistent with the flat nodeIds list', () => {
  const groupIds = clusterScope.nodeGroups.flatMap(group => group.nodeIds).slice().sort((a, b) => a - b);
  const flatIds = [...clusterScope.nodeIds].sort((a, b) => a - b);
  assert.deepEqual(groupIds, flatIds);
});

test('pending nodes retain their activation metadata without entering the current scope', () => {
  const [pendingGroup] = clusterScope.pendingNodeGroups;
  assert.equal(pendingGroup.status, 'pending');
  assert.deepEqual(pendingGroup.nodes.map(node => node.nodeId), [70, 71, 72, 73, 74, 75, 76, 77, 78, 79]);
  assert.ok(pendingGroup.nodes.every(node => node.nodeKey === `node${node.nodeId}`));
  assert.ok(pendingGroup.nodes.every(node => node.hostname === `wxtky02-p800-8nic-vd-node${node.nodeId}.wxtky02`));
  assert.equal(pendingGroup.nodes.find(node => node.nodeId === 70).ip, '10.206.192.168');
  assert.equal(pendingGroup.nodes.find(node => node.nodeId === 79).ip, '10.206.192.103');
  assert.ok(pendingGroup.nodes.every(node => !clusterScope.nodeIds.includes(node.nodeId)));
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

  assert.equal(Object.keys(merged.deviceState).length, 56);
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

test('team classifier prioritizes training, then inference, then operator testing', () => {
  assert.deepEqual(teamPrivate.classifyUser({
    sampleCount: 100,
    meanXpu: 72,
    meanMemory: 81,
    bothHighRatio: 0.72,
    memoryHighRatio: 0.8,
    xpuHighRatio: 0.3,
    transitionsPerHour: 3,
  }).team, 'training');
  assert.deepEqual(teamPrivate.classifyUser({
    sampleCount: 100,
    meanXpu: 24,
    meanMemory: 76,
    bothHighRatio: 0.1,
    memoryHighRatio: 0.8,
    xpuHighRatio: 0.2,
    transitionsPerHour: 0.3,
  }).team, 'inference');
  assert.deepEqual(teamPrivate.classifyUser({
    sampleCount: 100,
    meanXpu: 58,
    meanMemory: 33,
    bothHighRatio: 0.1,
    memoryHighRatio: 0.2,
    xpuHighRatio: 0.6,
    transitionsPerHour: 2.2,
  }).team, 'operator-testing');
  assert.equal(teamPrivate.classifyUser({ sampleCount: 35 }).pending, true);
});

test('unclassified users receive a stable simulated team instead of collapsing into general research', () => {
  const evidence = { sampleCount: 35 };
  const first = teamPrivate.classifyUser(evidence, 'unclassified-user');
  const second = teamPrivate.classifyUser(evidence, 'unclassified-user');

  assert.equal(first.team, second.team);
  assert.notEqual(first.team, undefined);
  assert.match(first.reason, /稳定模拟分组/);
});

test('team scheduler uses Unix seconds rather than JavaScript milliseconds for its analysis window', () => {
  assert.equal(teamPrivate.currentSampleSeconds(Date.UTC(2026, 6, 27, 11, 43, 17)), 1785152400);
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
  ], metrics, { 'training-user': { team: 'training' } }, 0, 600);

  assert.equal(ownership.userSamples.get('training-user').sampleCount, 2);
  assert.equal(ownership.userSamples.has('first-owner'), false);
  assert.equal(ownership.conflictCardSamples, 1);
  assert.equal(ownership.teamPoints.get(300).get('training').cardCount, 2);
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

test('manual team entries retain their assignment while auto evidence is refreshed', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ timestamp: index * 300, xpu: 75, memory: 80 }));
  const user = {
    userId: 'manual-user',
    sampleCount: samples.length,
    xpuSum: samples.reduce((total, sample) => total + sample.xpu, 0),
    memorySum: samples.reduce((total, sample) => total + sample.memory, 0),
    samples,
    perTime: new Map(samples.map(sample => [sample.timestamp, { xpuSum: sample.xpu, count: 1 }])),
  };
  const result = teamPrivate.mergeAutoAssignments({
    assignments: { 'manual-user': { team: 'inference', source: 'manual', pending: false } },
  }, new Map([['manual-user', user]]), 0, 12_000, '2026-07-27T00:00:00.000Z');

  assert.equal(result.assignments['manual-user'].team, 'inference');
  assert.equal(result.assignments['manual-user'].source, 'manual');
  assert.equal(result.assignments['manual-user'].candidate.team, 'training');
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

    assert.equal(result.targetNodes.length, 56);
    assert.equal(result.targetNodes.includes('bdc9'), false);
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

test('complete historical Lock Bot days are cached and identical trend requests share work', async () => {
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
    assert.equal(botCalls, 2);
    assert.equal(occupancyCalls, 1);
    assert.equal(recordsByKey.size, 1);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
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
