import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import clusterScope from '../shared/cluster-scope.json' with { type: 'json' };
import { adaptNodeData } from '../src/services/adapter.js';
import { shouldAutoRefresh } from '../src/services/auto-refresh.js';
import { hasFiniteSamples, nearestFiniteIndex, resolveYAxis } from '../src/services/chart-data.js';
import { CARD_COUNT, mergeLockBotStates } from '../src/services/cluster-state.js';

const require = createRequire(import.meta.url);
const { createTrendService, _private } = require('../server/trend-service.cjs');

function emptyDeviceState() {
  return Array.from({ length: CARD_COUNT }, (_, devId) => ({ dev_id: devId, status: 'idle', current_users: [] }));
}

test('cluster scope has the fixed 46-node, 368-card denominator', () => {
  assert.equal(clusterScope.nodeIds.length, 46);
  assert.equal(clusterScope.cardsPerNode, 8);
  assert.equal(clusterScope.nodeIds.length * clusterScope.cardsPerNode, 368);
  assert.equal(clusterScope.nodeIds.includes(15), false);
  assert.equal(clusterScope.nodeIds.includes(16), false);
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

  assert.equal(Object.keys(merged.deviceState).length, 46);
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

test('chart helpers skip empty points and expand only beyond the default scale', () => {
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
});

test('automatic refresh only applies to a current range no longer than 24 hours', () => {
  const now = Date.UTC(2026, 6, 16, 8, 0, 0);
  assert.equal(shouldAutoRefresh(now - 3 * 60 * 60 * 1000, now - 60_000, now), true);
  assert.equal(shouldAutoRefresh(now - 24 * 60 * 60 * 1000, now - 4 * 60_000, now), true);
  assert.equal(shouldAutoRefresh(now - 24 * 60 * 60 * 1000, now - 6 * 60_000, now), false);
  assert.equal(shouldAutoRefresh(now - 2 * 24 * 60 * 60 * 1000, now, now), false);
  assert.equal(shouldAutoRefresh(now - 60_000, now + 60_000, now), false);
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

    assert.equal(monqueryCalls, 2);
    assert.equal(botCalls, 2);
    assert.equal(occupancyCalls, 1);
    assert.equal(recordsByKey.size, 1);
  } finally {
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});
