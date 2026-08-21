const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const clusterScope = require('../shared/cluster-scope.json');
const { buildNodeTimeline, buildMetricUsageScopeTimeline, nodeIdsAt, totalCardsAt } = require('../shared/cluster-scope-timeline.cjs');
const { createLockHistoryCache, lockHistoryScopeKey } = require('./trend-service.cjs');
const { createTeamAccessService } = require('./team-access.cjs');
const { createLockBotLiveCache } = require('./lockbot-live-cache.cjs');

const CARD_COUNT = clusterScope.cardsPerNode;
const MONITORED_NODE_IDS = new Set(clusterScope.nodeIds);
const MONITORED_NODE_NAMES = clusterScope.nodeIds.map(nodeId => `node${nodeId}`);
const CST_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const SAMPLE_SECONDS = 300;
const ANALYSIS_WINDOW_SECONDS = 7 * DAY_SECONDS;
const DASHBOARD_SAMPLE_INTERVALS = [
  { maxDurationSeconds: 3 * 60 * 60, seconds: 60 },
  { maxDurationSeconds: 6 * 60 * 60, seconds: 120 },
  { maxDurationSeconds: DAY_SECONDS, seconds: 240 },
  { maxDurationSeconds: 2 * DAY_SECONDS, seconds: 480 },
  { maxDurationSeconds: 7 * DAY_SECONDS, seconds: 1200 },
  { maxDurationSeconds: 30 * DAY_SECONDS, seconds: 7200 },
  { maxDurationSeconds: 90 * DAY_SECONDS, seconds: 21600 },
];
const MIN_RANGE_SECONDS = 3 * 60 * 60;
const MAX_RANGE_SECONDS = 90 * DAY_SECONDS;
const DASHBOARD_CACHE_TTL_MS = 60 * 60 * 1000;
const PHASE_CONTEXT_TTL_MS = 5 * 60 * 1000;
const MONQUERY_BATCH_SIZE = 16;
const MONQUERY_ITEMS = Array.from({ length: CARD_COUNT }, (_, card) => [
  `XPU${card}_XPU_UTILIZATION`,
  `XPU${card}_MEM_UTILIZATION`,
]).flat();
const MEMBERSHIP_PATH = path.join(__dirname, '..', '.devdata', 'team-membership.json');
const MEMBERSHIP_KEY_ENV = 'TEAM_MEMBERSHIP_KEY';
const FALLBACK_TEAM_ID = 'general-research';
const TEAM_DEFINITIONS = [
  { id: 'toolchain', label: '工具链组' },
  { id: 'inference-product', label: '推理产品组' },
  { id: 'hpc', label: '高性能计算组' },
  { id: 'training-product', label: '训练产品组' },
  { id: 'training-arch', label: '训练业务架构组' },
  { id: 'inference-arch-a', label: '推理业务架构A组' },
  { id: 'driver', label: '驱动组' },
  { id: 'multimedia', label: '多媒体组' },
  { id: 'qa', label: '测试组' },
  { id: 'paddle-product', label: '飞桨产品组' },
  { id: 'group-arch', label: '集团业务架构组' },
  { id: 'inference-arch-b', label: '推理业务架构B组' },
  { id: 'frontier-arch', label: '前沿架构组' },
  { id: 'comm-lib', label: '通信库组' },
  { id: 'software-product', label: '软件产品组' },
  { id: FALLBACK_TEAM_ID, label: '通用研发' },
];

function createHttpError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requestJson(host, port, requestPath, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 90_000 } = options;
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      path: requestPath,
      method,
      headers,
      timeout: timeoutMs,
    }, response => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { payload += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(createHttpError(`Upstream returned ${response.statusCode}`, response.statusCode));
        }
        try {
          resolve(JSON.parse(payload));
        } catch {
          reject(createHttpError('Upstream returned invalid JSON'));
        }
      });
    });
    request.on('timeout', () => request.destroy(createHttpError('Upstream request timed out after 90 seconds')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function normalizeEntries(response) {
  return Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : Array.isArray(response?.Data) ? response.Data : [];
}

function cstDayStart(timestamp) {
  return Math.floor((timestamp + CST_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS - CST_OFFSET_SECONDS;
}

function cstDateKey(timestamp) {
  const date = new Date((timestamp + CST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function todayStartCst(nowSeconds = Math.floor(Date.now() / 1000)) {
  return cstDayStart(nowSeconds);
}

function formatMonqueryDateTime(timestamp) {
  const date = new Date((timestamp + CST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function sampleSecondsForRange(durationSeconds) {
  return DASHBOARD_SAMPLE_INTERVALS.find(interval => durationSeconds <= interval.maxDurationSeconds)?.seconds
    || DASHBOARD_SAMPLE_INTERVALS.at(-1).seconds;
}

function membershipCacheVersion(membership) {
  const assignments = membership?.assignments || {};
  const assignmentHash = crypto.createHash('sha256').update(JSON.stringify(assignments)).digest('hex').slice(0, 12);
  return [membership?.version || 1, membership?.classifierVersion || 'unknown', membership?.generatedAt || 'none', assignmentHash].join(':');
}

function nodeName(value) {
  const match = String(value || '').match(/^(?:gpu-)?node-?(\d+)$/i);
  return match ? `node${Number(match[1])}` : null;
}

function nodeIdFromName(name) {
  const match = String(name || '').match(/^node(\d+)$/i);
  return match ? Number(match[1]) : NaN;
}

function nodeNameFromNamespace(value) {
  const match = String(value || '').match(/node(\d+)\.wxtky02$/i);
  return match ? `node${Number(match[1])}` : null;
}

function isMonitoredNode(name) {
  return MONITORED_NODE_IDS.has(nodeIdFromName(name));
}

function toSeconds(value) {
  if (value == null || value === '') return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const text = String(value).trim();
  if (/[Zz]|[+-]\d{2}:\d{2}$/.test(text)) return Math.floor(Date.parse(text) / 1000);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = '00'] = match;
  return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000) - CST_OFFSET_SECONDS;
}

function recordCards(record) {
  const card = Number(record?.dev_id ?? record?.device_id ?? record?.card_id);
  return Number.isInteger(card) && card >= 0 && card < CARD_COUNT ? [card] : Array.from({ length: CARD_COUNT }, (_, index) => index);
}

function botType(bot) {
  return String(bot?.bot_type || bot?.type || 'NODE').toUpperCase();
}

function normalizeOccupancy(records, startAt, endAt) {
  const unique = new Map();
  for (const record of records || []) {
    const userId = String(record?.user_id ?? record?.user?.id ?? '').trim();
    const node = nodeName(record?.node_key ?? record?.node ?? record?.node_name);
    const start = toSeconds(record?.start_time_cn ?? record?.start_time);
    const explicitEnd = toSeconds(record?.end_time_cn ?? record?.end_time);
    const end = Number.isFinite(explicitEnd) ? explicitEnd : start + Number(record?.duration_seconds ?? record?.duration ?? 0);
    if (!userId || !node || !isMonitoredNode(node) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const clippedStart = Math.max(startAt, start);
    const clippedEnd = Math.min(endAt, end);
    if (clippedEnd <= clippedStart) continue;
    const cards = recordCards(record);
    const key = `${userId}|${node}|${cards.join(',')}|${clippedStart}|${clippedEnd}`;
    unique.set(key, { userId, node, cards, start: clippedStart, end: clippedEnd });
  }
  return [...unique.values()];
}

function namespace(nodeId) {
  const nonBackup = new Set([32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 53, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 83, 84, 85, 86, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114]);
  const prefix = nonBackup.has(nodeId) ? 'wxtky02-p800-8nic-vd' : 'wxtky02-p800-backup-8nic-vd';
  return `${prefix}-node${nodeId}.wxtky02`;
}

function runWithConcurrency(tasks, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await work(task);
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function pointTimestamp(point) {
  const raw = Number(point?.Timestamp ?? point?.timestamp ?? point?.time);
  if (!Number.isFinite(raw)) return NaN;
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function pointValue(point) {
  const value = Number(point?.Value ?? point?.value);
  return Number.isFinite(value) ? value : null;
}

function itemPoints(item) {
  if (Array.isArray(item)) return item;
  if (Array.isArray(item?.Data)) return item.Data;
  if (Array.isArray(item?.data)) return item.data;
  return [];
}

function parseCardMetrics(responses, startAt, endAt) {
  const result = new Map();
  for (const response of responses) {
    for (const entry of normalizeEntries(response)) {
      const node = nodeNameFromNamespace(entry?.NameSpace);
      if (!node || !isMonitoredNode(node)) continue;
      const timestamps = result.get(node) || new Map();
      result.set(node, timestamps);
      for (let card = 0; card < CARD_COUNT; card += 1) {
        for (const [metric, property] of [[`XPU${card}_XPU_UTILIZATION`, 'xpu'], [`XPU${card}_MEM_UTILIZATION`, 'memory']]) {
          for (const point of itemPoints(entry?.Items?.[metric])) {
            const timestamp = pointTimestamp(point);
            const value = pointValue(point);
            if (!Number.isFinite(timestamp) || value === null || timestamp < startAt || timestamp > endAt) continue;
            const cards = timestamps.get(timestamp) || Array.from({ length: CARD_COUNT }, () => ({}));
            cards[card][property] = value;
            timestamps.set(timestamp, cards);
          }
        }
      }
    }
  }
  return result;
}

async function fetchBots(config, authorization, liveLockBotCache = null) {
  const load = () => requestJson(config.backend.lockbot.host, config.backend.lockbot.port, '/api/bots', {
    headers: { authorization },
  });
  return liveLockBotCache ? liveLockBotCache.get('bots', load, Array.isArray) : load();
}

function occupancyRecords(response) {
  return Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
}

async function fetchOccupancyDay(config, bots, authorization, dayStart) {
  const responses = await Promise.all((bots || []).map(async bot => {
    try {
      const response = await requestJson(
        config.backend.lockbot.host,
        config.backend.lockbot.port,
        `/api/bots/${bot.id}/occupancy?date=${encodeURIComponent(cstDateKey(dayStart))}`,
        { headers: { authorization } },
      );
      return { bot, ok: true, records: occupancyRecords(response) };
    } catch (error) {
      return { bot, ok: false, records: [], error };
    }
  }));
  const failed = responses.filter(response => !response.ok);
  return { records: responses.flatMap(response => response.records), failed };
}

async function fetchOccupancy(config, bots, authorization, startAt, endAt, lockHistoryCache, nowSeconds, liveLockBotCache = null) {
  const dayStarts = [];
  for (let day = cstDayStart(startAt); day <= endAt; day += DAY_SECONDS) dayStarts.push(day);
  const records = [];
  const failures = [];
  const todayStart = todayStartCst(nowSeconds);
  const scopeKey = lockHistoryScopeKey(MONITORED_NODE_NAMES);
  await runWithConcurrency(dayStarts, 2, async dayStart => {
    const isToday = dayStart === todayStart;
    const cachedRecords = isToday ? null : lockHistoryCache?.read(dayStart, scopeKey);
    if (cachedRecords) {
      records.push(...cachedRecords);
      return;
    }
    const outcome = isToday && liveLockBotCache
      ? await liveLockBotCache.get(`occupancy:${cstDateKey(dayStart)}`, () => fetchOccupancyDay(config, bots, authorization, dayStart), value => !value.failed.length)
      : await fetchOccupancyDay(config, bots, authorization, dayStart);
    for (const response of outcome.failed) {
      failures.push({ botId: response.bot.id, day: cstDateKey(dayStart), statusCode: response.error.statusCode || 502 });
    }
    if (!outcome.failed.length && !isToday) {
      try {
        lockHistoryCache?.save(dayStart, scopeKey, outcome.records);
      } catch (error) {
        console.warn(`[team] Lock Bot 历史缓存写入失败: ${error.message}`);
      }
    }
    records.push(...outcome.records);
  });
  return { records, failures };
}

async function fetchRunningStates(config, authorization) {
  const response = await requestJson(config.backend.lockbot.host, config.backend.lockbot.port, '/api/bots/running-states', {
    headers: { authorization },
  });
  return response?.data ?? response;
}

function stateIntervals(bots, states, startAt, endAt) {
  const intervals = [];
  for (const bot of bots || []) {
    const state = states?.[String(bot.id)] ?? states?.[bot.id] ?? {};
    const type = botType(bot);
    for (const [rawNode, nodeState] of Object.entries(state || {})) {
      const node = nodeName(rawNode);
      if (!node || !isMonitoredNode(node)) continue;
      const devices = type === 'DEVICE' && Array.isArray(nodeState)
        ? nodeState
        : [{ ...nodeState, dev_id: null }];
      for (const device of devices) {
        if (device?.status === 'idle' || !Array.isArray(device?.current_users)) continue;
        const cards = recordCards(device);
        for (const user of device.current_users) {
          const userId = String(user?.user_id ?? '').trim();
          const start = toSeconds(user?.start_time);
          const end = Math.min(endAt, start + Number(user?.duration ?? 0));
          if (!userId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
          const clippedStart = Math.max(startAt, start);
          if (end > clippedStart) intervals.push({ userId, node, cards, start: clippedStart, end });
        }
      }
    }
  }
  return intervals;
}

async function fetchCardMetrics(config, startAt, endAt, nodeNames, sampleSeconds = SAMPLE_SECONDS) {
  const nodeIds = [...new Set(nodeNames.map(nodeIdFromName).filter(id => MONITORED_NODE_IDS.has(id)))];
  if (!nodeIds.length) return new Map();
  const tasks = [];
  for (let cursor = startAt; cursor < endAt;) {
    const sliceEnd = Math.min(cstDayStart(cursor) + DAY_SECONDS, endAt);
    for (let index = 0; index < nodeIds.length; index += MONQUERY_BATCH_SIZE) {
      tasks.push({ startAt: cursor, endAt: sliceEnd, nodeIds: nodeIds.slice(index, index + MONQUERY_BATCH_SIZE) });
    }
    cursor = sliceEnd;
  }
  const responses = [];
  await runWithConcurrency(tasks, 4, async task => {
    const params = new URLSearchParams({
      namespaces: task.nodeIds.map(namespace).join(','),
      items: MONQUERY_ITEMS.join(','),
      start: formatMonqueryDateTime(task.startAt),
      end: formatMonqueryDateTime(task.endAt),
      interval: String(sampleSeconds),
    });
    const response = await requestJson(
      config.backend.monquery.host,
      config.backend.monquery.port,
      `/monquery/getHistoryitemdata?${params}`,
    );
    responses.push(response);
  });
  return parseCardMetrics(responses, startAt, endAt);
}

function intervalNodeNames(intervals) {
  return [...new Set((intervals || []).map(interval => interval.node).filter(Boolean))];
}

function mergeCardMetrics(...sources) {
  const result = new Map();
  for (const source of sources) {
    for (const [node, timestamps] of source || []) {
      const target = result.get(node) || new Map();
      for (const [timestamp, cards] of timestamps) target.set(timestamp, cards);
      result.set(node, target);
    }
  }
  return result;
}

function teamDefinitionFor(id, teamDefinitions) {
  if (!id) return null;
  return teamDefinitions.find(team => team.id === id)
    || TEAM_DEFINITIONS.find(team => team.id === id)
    || { id, label: id };
}

function mergeTeamDefinitions(...sources) {
  const teams = new Map();
  for (const source of sources) {
    for (const team of source || []) {
      if (!team?.id || teams.has(team.id)) continue;
      teams.set(team.id, { id: team.id, label: team.label || team.id });
    }
  }
  return [...teams.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function mergeMembership(existing, resolved) {
  return {
    ...existing,
    ...resolved,
    assignments: { ...(existing?.assignments || {}), ...(resolved?.assignments || {}) },
    teams: mergeTeamDefinitions(resolved?.teams, TEAM_DEFINITIONS),
  };
}

function createUserAggregate(userId) {
  return {
    userId,
    sampleCount: 0,
    xpuSum: 0,
    memorySum: 0,
    perTime: new Map(),
  };
}

function addUserSample(target, timestamp, xpu, memory) {
  target.sampleCount += 1;
  target.xpuSum += xpu;
  target.memorySum += memory;
  const point = target.perTime.get(timestamp) || { xpuSum: 0, count: 0 };
  point.xpuSum += xpu;
  point.count += 1;
  target.perTime.set(timestamp, point);
}

function userEvidence(user, sampleSeconds = user.sampleSeconds || SAMPLE_SECONDS) {
  const samples = user.sampleCount;
  const meanXpu = samples ? user.xpuSum / samples : null;
  const meanMemory = samples ? user.memorySum / samples : null;
  const timeline = [...user.perTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, point]) => ({ timestamp, xpu: point.xpuSum / point.count }));
  let xpuHighSamples = 0;
  let memoryHighSamples = 0;
  let bothHighSamples = 0;
  let transitions = 0;
  let previousBand = null;
  for (const point of timeline) {
    if (point.xpu >= 70) xpuHighSamples += 1;
    const band = point.xpu < 30 ? 'low' : point.xpu >= 70 ? 'high' : null;
    if (band && previousBand && band !== previousBand) transitions += 1;
    if (band) previousBand = band;
  }
  for (const point of user.samples || []) {
    if (point.memory >= 60) memoryHighSamples += 1;
    if (point.xpu >= 50 && point.memory >= 60) bothHighSamples += 1;
  }
  const hours = timeline.length > 1 ? Math.max((timeline.at(-1).timestamp - timeline[0].timestamp) / 3600, sampleSeconds / 3600) : sampleSeconds / 3600;
  return {
    sampleCount: samples,
    cardHours: samples * sampleSeconds / 3600,
    meanXpu,
    meanMemory,
    xpuHighRatio: timeline.length ? xpuHighSamples / timeline.length : 0,
    memoryHighRatio: samples ? memoryHighSamples / samples : 0,
    bothHighRatio: samples ? bothHighSamples / samples : 0,
    transitionsPerHour: transitions / hours,
  };
}

function normalizeUserKey(userId) {
  return String(userId || '').trim().toLowerCase();
}

// The roster is keyed by the Lock Bot user id itself (the email prefix, e.g.
// zhangshaokun02), so matching is exact apart from case normalization.
function assignmentForUser(assignments, userId) {
  if (!assignments) return null;
  const raw = String(userId || '').trim();
  return assignments[raw]
    || assignments[normalizeUserKey(raw)]
    || null;
}

function effectiveTeamForUser(assignments, userId) {
  return assignmentForUser(assignments, userId)?.team || FALLBACK_TEAM_ID;
}

function classifyUser(evidence, userId) {
  const fallback = { team: FALLBACK_TEAM_ID, pending: true, confidence: 0, reason: '花名册未收录该用户，归入通用研发' };
  if (evidence.sampleCount < 36) return fallback;
  return fallback;
}

function aggregateOwnership(intervals, metrics, assignments, startAt, endAt, sampleSeconds = SAMPLE_SECONDS) {
  const nodeScopeTimeline = buildMetricUsageScopeTimeline(clusterScope, clusterScope.nodeIds);
  const intervalsByNode = new Map();
  for (const interval of intervals) {
    const values = intervalsByNode.get(interval.node) || [];
    values.push(interval);
    intervalsByNode.set(interval.node, values);
  }
  const userSamples = new Map();
  const teamPoints = new Map();
  const allTimes = new Set();
  let conflictCardSamples = 0;
  for (const [node, timestamps] of metrics) {
    const nodeIntervals = intervalsByNode.get(node) || [];
    if (!nodeIntervals.length) continue;
    for (const [timestamp, cards] of timestamps) {
      if (timestamp < startAt || timestamp > endAt) continue;
      if (!nodeIdsAt(nodeScopeTimeline, timestamp).includes(nodeIdFromName(node))) continue;
      allTimes.add(timestamp);
      const active = nodeIntervals.filter(interval => interval.start <= timestamp && timestamp < interval.end);
      if (!active.length) continue;
      for (let card = 0; card < CARD_COUNT; card += 1) {
        const metric = cards[card];
        if (!Number.isFinite(metric?.xpu) || !Number.isFinite(metric?.memory)) continue;
        const owners = new Set(active.filter(interval => interval.cards.includes(card)).map(interval => interval.userId));
        if (owners.size !== 1) {
          if (owners.size > 1) conflictCardSamples += 1;
          continue;
        }
        const userId = [...owners][0];
        const team = effectiveTeamForUser(assignments, userId);
        const user = userSamples.get(userId) || { ...createUserAggregate(userId), sampleSeconds };
        if (!user.samples) user.samples = [];
        user.samples.push({ timestamp, xpu: metric.xpu, memory: metric.memory });
        addUserSample(user, timestamp, metric.xpu, metric.memory);
        userSamples.set(userId, user);
        const timestampTeams = teamPoints.get(timestamp) || new Map();
        const point = timestampTeams.get(team) || { xpuSum: 0, memorySum: 0, cardCount: 0, nodes: new Set(), users: new Set() };
        point.xpuSum += metric.xpu;
        point.memorySum += metric.memory;
        point.cardCount += 1;
        point.nodes.add(node);
        point.users.add(userId);
        timestampTeams.set(team, point);
        teamPoints.set(timestamp, timestampTeams);
      }
    }
  }
  return { userSamples, teamPoints, allTimes: [...allTimes].sort((left, right) => left - right), conflictCardSamples };
}

function buildDashboardPayload(ownership, membership, startAt, endAt, sampleSeconds, teamDefinitions = TEAM_DEFINITIONS) {
  const timeline = buildNodeTimeline(clusterScope, clusterScope.nodeIds);
  const perTeam = Object.fromEntries(teamDefinitions.map(team => [team.id, {
    id: team.id,
    label: team.label,
    cardSamples: 0,
    xpuSum: 0,
    memorySum: 0,
    users: new Set(),
    pendingUsers: new Set(),
    trend: [],
  }]));
  const latest = {};
  for (const timestamp of ownership.allTimes) {
    const points = ownership.teamPoints.get(timestamp) || new Map();
    for (const team of teamDefinitions) {
      const point = points.get(team.id);
      const output = point ? {
        timestamp,
        lockedCards: point.cardCount,
        lockedNodes: point.nodes.size,
        lockedUsers: point.users.size,
        xpu: point.xpuSum / point.cardCount,
        memory: point.memorySum / point.cardCount,
        lockRate: totalCardsAt(timeline, CARD_COUNT, timestamp) ? point.cardCount / totalCardsAt(timeline, CARD_COUNT, timestamp) * 100 : null,
      } : { timestamp, lockedCards: 0, lockedNodes: 0, lockedUsers: 0, xpu: null, memory: null, lockRate: 0 };
      perTeam[team.id].trend.push(output);
      if (point) {
        perTeam[team.id].cardSamples += point.cardCount;
        perTeam[team.id].xpuSum += point.xpuSum;
        perTeam[team.id].memorySum += point.memorySum;
        point.users.forEach(userId => {
          perTeam[team.id].users.add(userId);
          if (assignmentForUser(membership.assignments, userId)?.pending !== false) perTeam[team.id].pendingUsers.add(userId);
        });
      }
      latest[team.id] = output;
    }
  }
  const teams = teamDefinitions.map(team => {
    const value = perTeam[team.id];
    const trendSampleCount = value.trend.length;
    const lockedCards = value.trend.reduce((total, point) => total + point.lockedCards, 0);
    const lockedUsers = value.trend.reduce((total, point) => total + point.lockedUsers, 0);
    const lockRate = trendSampleCount
      ? value.trend.reduce((total, point) => total + point.lockRate, 0) / trendSampleCount
      : null;
    return {
      id: team.id,
      label: team.label,
      cardHours: value.cardSamples * sampleSeconds / 3600,
      xpu: value.cardSamples ? value.xpuSum / value.cardSamples : null,
      memory: value.cardSamples ? value.memorySum / value.cardSamples : null,
      userCount: value.users.size,
      pendingUserCount: value.pendingUsers.size,
      trend: value.trend,
      current: latest[team.id] || null,
      averages: {
        lockRate,
        xpu: value.cardSamples ? value.xpuSum / value.cardSamples : null,
        memory: value.cardSamples ? value.memorySum / value.cardSamples : null,
        activeUsers: trendSampleCount ? lockedUsers / trendSampleCount : null,
        lockedCardsPerUser: lockedUsers ? lockedCards / lockedUsers : null,
      },
    };
  });
  const rankings = [...ownership.userSamples.values()].map(user => {
    const evidence = userEvidence(user, sampleSeconds);
    const assignment = assignmentForUser(membership.assignments, user.userId);
    return {
      userId: user.userId,
      team: effectiveTeamForUser(membership.assignments, user.userId),
      source: assignment?.source || 'unlisted',
      pending: assignment?.pending ?? true,
      confidence: assignment?.confidence ?? 0,
      cardHours: evidence.cardHours,
      xpu: evidence.meanXpu,
      memory: evidence.meanMemory,
    };
  }).sort((left, right) => left.xpu - right.xpu || right.cardHours - left.cardHours);
  return {
    range: { startAt, endAt, sampleSeconds },
    dataAsOf: ownership.allTimes.at(-1) || null,
    membership: {
      generatedAt: membership.generatedAt,
      window: membership.window,
      lastError: membership.lastError || null,
    },
    teams,
    rankings,
    dataQuality: { conflictCardSamples: ownership.conflictCardSamples },
  };
}

function scopeDashboardPayload(payload, access, scopedTeamIds = access.mode === 'all' ? null : access.teamIds || []) {
  const visibleTeamIds = scopedTeamIds === null ? null : new Set(scopedTeamIds);
  const teams = visibleTeamIds ? payload.teams.filter(team => visibleTeamIds.has(team.id)) : payload.teams;
  const rankings = visibleTeamIds ? payload.rankings.filter(row => visibleTeamIds.has(row.team)) : payload.rankings;
  return {
    ...payload,
    teams,
    rankings,
    access: {
      enabled: access.enabled,
      mode: access.mode,
      teamIds: visibleTeamIds ? [...visibleTeamIds] : teams.map(team => team.id),
    },
  };
}

function membershipKey(getEnvironment = name => process.env[name]) {
  const raw = String(getEnvironment(MEMBERSHIP_KEY_ENV) || '').trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${MEMBERSHIP_KEY_ENV} must be a 32-byte key in hex or base64`);
  return key;
}

// The roster maps real people to teams, so it is stored as AES-256-GCM at rest.
// Plaintext files stay readable to keep existing deployments working.
function encryptMembership(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    format: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    payload: payload.toString('base64'),
  };
}

function decryptMembership(envelope, key) {
  if (!key) throw new Error(`${MEMBERSHIP_KEY_ENV} is required to read the encrypted roster`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.payload, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function defaultMembership() {
  return { version: 1, classifierVersion: 'workload-v1', generatedAt: null, window: null, lastError: null, assignments: {} };
}

function readMembership(filePath = MEMBERSHIP_PATH, options = {}) {
  const key = options.key !== undefined ? options.key : membershipKey();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultMembership();
  }
  const value = raw?.format === 'aes-256-gcm' ? decryptMembership(raw, key) : raw;
  if (value && typeof value === 'object' && value.assignments && typeof value.assignments === 'object') return value;
  return defaultMembership();
}

function writeMembership(value, filePath = MEMBERSHIP_PATH, options = {}) {
  const key = options.key !== undefined ? options.key : membershipKey();
  const stored = key ? encryptMembership(value, key) : value;
  const content = `${JSON.stringify(stored, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function mergeAutoAssignments(existing, userSamples, startAt, endAt, generatedAt) {
  const assignments = { ...(existing.assignments || {}) };
  for (const user of userSamples.values()) {
    const evidence = userEvidence(user);
    const classification = classifyUser(evidence, user.userId);
    const candidate = {
      team: classification.team,
      pending: classification.pending,
      confidence: Number(classification.confidence.toFixed(3)),
      reason: classification.reason,
      evidence: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, Number.isFinite(value) ? Number(value.toFixed(3)) : value])),
      generatedAt,
    };
    if (assignmentForUser(assignments, user.userId)?.source === 'manual') {
      continue;
    }
    assignments[user.userId] = { ...candidate, source: 'auto' };
  }
  return {
    version: 1,
    classifierVersion: 'workload-v1',
    generatedAt,
    window: { startAt, endAt },
    lastError: null,
    assignments,
  };
}

function millisecondsUntilNextHour(now = Date.now()) {
  const next = Math.floor(now / (60 * 60 * 1000) + 1) * 60 * 60 * 1000;
  return next - now + 1_000;
}

function currentSampleSeconds(nowMs = Date.now()) {
  return Math.floor(Math.floor(nowMs / 1000) / SAMPLE_SECONDS) * SAMPLE_SECONDS;
}

function createTeamService(config, options = {}) {
  const membershipPath = options.membershipPath || MEMBERSHIP_PATH;
  const serviceUsername = options.serviceUsername ?? process.env.LOCKBOT_SERVICE_USERNAME;
  const servicePassword = options.servicePassword ?? process.env.LOCKBOT_SERVICE_PASSWORD;
  const request = options.requestJson || requestJson;
  const lockHistoryCache = options.lockHistoryCache || createLockHistoryCache();
  const teamAccess = options.teamAccess || createTeamAccessService(config);
  const currentSeconds = options.currentSeconds || (() => Math.floor(Date.now() / 1000));
  const nowMs = options.nowMs || (() => Date.now());
  const liveLockBotCache = options.liveLockBotCache || createLockBotLiveCache({ nowMs });
  const random = options.random || Math.random;
  const phaseContextTtlMs = options.phaseContextTtlMs || PHASE_CONTEXT_TTL_MS;
  let refreshInFlight = null;
  let schedulerTimer = null;
  const dashboardCache = new Map();
  const phaseContexts = new Map();

  async function collectOccupancy(authorization, startAt, endAt) {
    const bots = await fetchBots(config, authorization, liveLockBotCache);
    const nowSeconds = currentSeconds();
    const todayStart = todayStartCst(nowSeconds);
    const [occupancy, stateOutcome] = await Promise.all([
      fetchOccupancy(config, bots, authorization, startAt, endAt, lockHistoryCache, nowSeconds, liveLockBotCache),
      (endAt >= todayStart
        ? fetchRunningStates(config, authorization)
        .then(states => ({ ok: true, states }))
        .catch(error => ({ ok: false, error }))
        : Promise.resolve({ ok: true, states: null })),
    ]);
    const intervals = normalizeOccupancy(occupancy.records, startAt, endAt);
    if (stateOutcome.ok && stateOutcome.states) {
      intervals.push(...stateIntervals(bots, stateOutcome.states, Math.max(startAt, todayStart), Math.min(endAt, nowSeconds)));
    }
    return { intervals, occupancy, stateFailureCount: stateOutcome.ok ? 0 : 1 };
  }

  async function collect(authorization, startAt, endAt, sampleSeconds = SAMPLE_SECONDS) {
    const context = await collectOccupancy(authorization, startAt, endAt);
    const metrics = await fetchCardMetrics(config, startAt, endAt, intervalNodeNames(context.intervals), sampleSeconds);
    return { ...context, metrics };
  }

  async function serviceAuthorization() {
    if (!serviceUsername || !servicePassword) throw createHttpError('LOCKBOT_SERVICE_USERNAME and LOCKBOT_SERVICE_PASSWORD are required for scheduled team refresh', 503);
    const payload = JSON.stringify({ username: serviceUsername, password: servicePassword });
    const response = await request(config.backend.lockbot.host, config.backend.lockbot.port, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      body: payload,
    });
    if (!response?.access_token) throw createHttpError('Service account login returned no access token', 502);
    return `Bearer ${response.access_token}`;
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const generatedAt = new Date().toISOString();
      const endAt = currentSampleSeconds();
      const startAt = endAt - ANALYSIS_WINDOW_SECONDS;
      const existing = readMembership(membershipPath);
      try {
        const authorization = await serviceAuthorization();
        const { intervals, metrics, occupancy } = await collect(authorization, startAt, endAt);
        const ownership = aggregateOwnership(intervals, metrics, {}, startAt, endAt);
        if (occupancy.failures.length) throw createHttpError(`Lock Bot occupancy incomplete for ${occupancy.failures.length} bot-day requests`);
        const membership = mergeAutoAssignments(existing, ownership.userSamples, startAt, endAt, generatedAt);
        writeMembership(membership, membershipPath);
        console.info(`[team] 映射刷新完成 · 用户 ${ownership.userSamples.size} · 冲突卡样本 ${ownership.conflictCardSamples}`);
        return membership;
      } catch (error) {
        const preserved = { ...existing, lastError: { at: generatedAt, message: error.message } };
        writeMembership(preserved, membershipPath);
        console.warn(`[team] 映射刷新失败，保留上次有效映射: ${error.message}`);
        throw error;
      }
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  function purgePhaseContexts(now = nowMs()) {
    for (const [id, context] of phaseContexts) {
      if (context.expiresAt <= now) phaseContexts.delete(id);
    }
  }

  function authorizationHash(authorization) {
    return crypto.createHash('sha256').update(String(authorization || '')).digest('hex').slice(0, 16);
  }

  async function queryCompleteDashboard(authorization, access, startAt, endAt) {
    let membership = readMembership(membershipPath);
    const sampleSeconds = sampleSecondsForRange(endAt - startAt);
    const mappingVersion = access.enabled ? access.cacheKey : membershipCacheVersion(membership);
    const authHash = authorizationHash(authorization);
    const cacheKey = `${authHash}:${mappingVersion}:${startAt}:${endAt}:${sampleSeconds}`;
    const now = nowMs();
    for (const [key, entry] of dashboardCache) {
      if (entry.expiresAt <= now) dashboardCache.delete(key);
    }
    const cached = access.enabled ? null : dashboardCache.get(cacheKey);
    if (cached) {
      return {
        ...cached.payload,
        cache: { hit: true, expiresAt: Math.floor(cached.expiresAt / 1000) },
      };
    }

    const { intervals, metrics, occupancy, stateFailureCount } = await collect(authorization, startAt, endAt, sampleSeconds);
    let ownership;
    let teamDefinitions = TEAM_DEFINITIONS;
    if (access.enabled) {
      const rawOwnership = aggregateOwnership(intervals, metrics, {}, startAt, endAt, sampleSeconds);
      const resolvedMembership = await teamAccess.resolveMembership([...rawOwnership.userSamples.keys()]);
      membership = access.membershipSource === 'whitelist' && access.mode === 'all'
        ? mergeMembership(membership, resolvedMembership)
        : resolvedMembership;
      teamDefinitions = access.membershipSource === 'whitelist'
        ? mergeTeamDefinitions(access.teams, membership.teams, TEAM_DEFINITIONS)
        : membership.teams;
      ownership = aggregateOwnership(intervals, metrics, membership.assignments, startAt, endAt, sampleSeconds);
    } else {
      ownership = aggregateOwnership(intervals, metrics, membership.assignments, startAt, endAt, sampleSeconds);
    }
    const payload = scopeDashboardPayload({
      ...buildDashboardPayload(ownership, membership, startAt, endAt, sampleSeconds, teamDefinitions),
      dataQuality: {
        conflictCardSamples: ownership.conflictCardSamples,
        occupancyFailureCount: occupancy.failures.length,
        stateFailureCount,
      },
    }, access);
    const expiresAt = access.enabled ? null : nowMs() + DASHBOARD_CACHE_TTL_MS;
    if (expiresAt) dashboardCache.set(cacheKey, { payload, expiresAt });
    return {
      ...payload,
      cache: { hit: false, expiresAt: expiresAt ? Math.floor(expiresAt / 1000) : null },
    };
  }

  async function queryInitialDashboard(authorization, access, startAt, endAt, preferredTeamId = null) {
    const sampleSeconds = sampleSecondsForRange(endAt - startAt);
    const { intervals, occupancy, stateFailureCount } = await collectOccupancy(authorization, startAt, endAt);
    const resolvedMembership = await teamAccess.resolveMembership([...new Set(intervals.map(interval => interval.userId))]);
    const membership = access.membershipSource === 'whitelist' && access.mode === 'all'
      ? mergeMembership(readMembership(membershipPath), resolvedMembership)
      : resolvedMembership;
    const teamDefinitions = access.membershipSource === 'whitelist'
      ? mergeTeamDefinitions(access.teams, membership.teams, TEAM_DEFINITIONS)
      : mergeTeamDefinitions(access.teams, membership.teams);
    const activeTeamIds = new Set(intervals.map(interval => effectiveTeamForUser(membership.assignments, interval.userId)).filter(Boolean));
    const candidates = teamDefinitions.filter(team => activeTeamIds.has(team.id));
    const initialTeamId = access.mode === 'team'
      ? access.teamIds?.[0]
      : (typeof preferredTeamId === 'string' && preferredTeamId.trim()
        ? preferredTeamId.trim()
        : candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, random()) * candidates.length))]?.id
          || null);
    const initialTeam = teamDefinitionFor(initialTeamId, teamDefinitions);
    const initialNodeNames = intervalNodeNames(intervals.filter(interval => effectiveTeamForUser(membership.assignments, interval.userId) === initialTeamId));
    const initialMetrics = await fetchCardMetrics(config, startAt, endAt, initialNodeNames, sampleSeconds);
    const ownership = aggregateOwnership(intervals, initialMetrics, membership.assignments, startAt, endAt, sampleSeconds);
    const payload = scopeDashboardPayload({
      ...buildDashboardPayload(ownership, membership, startAt, endAt, sampleSeconds, initialTeam ? [initialTeam] : []),
      dataQuality: {
        conflictCardSamples: ownership.conflictCardSamples,
        occupancyFailureCount: occupancy.failures.length,
        stateFailureCount,
      },
    }, access, initialTeamId ? [initialTeamId] : []);
    const complete = access.mode === 'team';
    let bootstrapId = null;
    if (!complete) {
      purgePhaseContexts();
      bootstrapId = crypto.randomBytes(18).toString('base64url');
      phaseContexts.set(bootstrapId, {
        authorizationHash: authorizationHash(authorization),
        accessKey: access.cacheKey,
        startAt,
        endAt,
        sampleSeconds,
        expiresAt: nowMs() + phaseContextTtlMs,
        intervals,
        membership,
        teamDefinitions,
        initialMetrics,
        initialNodeNames,
        occupancyFailureCount: occupancy.failures.length,
        stateFailureCount,
        initialTeamId,
        fullPromise: null,
      });
    }
    return {
      ...payload,
      progressive: { phase: 'initial', complete, initialTeamId, bootstrapId },
      cache: { hit: false, expiresAt: null },
    };
  }

  async function queryFullPhase(authorization, access, startAt, endAt, bootstrapId) {
    purgePhaseContexts();
    const context = phaseContexts.get(bootstrapId);
    if (!context) throw createHttpError('Team dashboard bootstrap expired', 400);
    if (context.authorizationHash !== authorizationHash(authorization) || context.accessKey !== access.cacheKey) {
      throw createHttpError('Team dashboard bootstrap is not valid for this account', 403);
    }
    if (context.startAt !== startAt || context.endAt !== endAt) {
      throw createHttpError('Team dashboard bootstrap range does not match', 400);
    }
    if (context.fullPromise) return context.fullPromise;
    context.fullPromise = (async () => {
      const allNodeNames = intervalNodeNames(context.intervals);
      const remainingNodeNames = allNodeNames.filter(node => !context.initialNodeNames.includes(node));
      const remainingMetrics = await fetchCardMetrics(config, startAt, endAt, remainingNodeNames, context.sampleSeconds);
      const metrics = mergeCardMetrics(context.initialMetrics, remainingMetrics);
      const ownership = aggregateOwnership(context.intervals, metrics, context.membership.assignments, startAt, endAt, context.sampleSeconds);
      const payload = scopeDashboardPayload({
        ...buildDashboardPayload(ownership, context.membership, startAt, endAt, context.sampleSeconds, context.teamDefinitions),
        dataQuality: {
          conflictCardSamples: ownership.conflictCardSamples,
          occupancyFailureCount: context.occupancyFailureCount,
          stateFailureCount: context.stateFailureCount,
        },
      }, access);
      return {
        ...payload,
        progressive: { phase: 'full', complete: true, initialTeamId: context.initialTeamId, bootstrapId: null },
        cache: { hit: false, expiresAt: null },
      };
    })();
    try {
      const result = await context.fullPromise;
      phaseContexts.delete(bootstrapId);
      return result;
    } catch (error) {
      context.fullPromise = null;
      throw error;
    }
  }

  async function queryDashboard(authorization, startAt, endAt, options = {}) {
    const access = options.access || await teamAccess.authorize(authorization);
    const phase = options.phase || null;
    if (!phase || !access.enabled) return queryCompleteDashboard(authorization, access, startAt, endAt);
    if (phase === 'initial') return queryInitialDashboard(authorization, access, startAt, endAt, options.initialTeamId || null);
    if (phase === 'full') {
      if (!options.bootstrapId) throw createHttpError('Team dashboard bootstrap is required', 400);
      return queryFullPhase(authorization, access, startAt, endAt, options.bootstrapId);
    }
    throw createHttpError('Unknown team dashboard phase', 400);
  }

  async function getMembership(authorization, accessOverride = null) {
    const access = accessOverride || await teamAccess.authorize(authorization);
    await fetchBots(config, authorization, liveLockBotCache);
    const membership = readMembership(membershipPath);
    if (access.mode === 'all') return membership;
    const allowedTeams = new Set(access.teamIds || []);
    return {
      ...membership,
      assignments: Object.fromEntries(Object.entries(membership.assignments || {}).filter(([, assignment]) => allowedTeams.has(assignment.team))),
      access: { enabled: access.enabled, mode: access.mode, teamIds: [...allowedTeams] },
    };
  }

  function schedule() {
    console.info('[team] 自动团队映射刷新已禁用，沿用已保存的固定映射');
    return false;
  }

  async function warmLiveLockBotOccupancy(authorization) {
    const nowSeconds = currentSeconds();
    const bots = await fetchBots(config, authorization, liveLockBotCache);
    return fetchOccupancy(
      config,
      bots,
      authorization,
      todayStartCst(nowSeconds),
      nowSeconds,
      lockHistoryCache,
      nowSeconds,
      liveLockBotCache,
    );
  }

  function stop() {
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  return { getMembership, queryDashboard, refresh, schedule, stop, warmLiveLockBotOccupancy };
}

module.exports = {
  createTeamService,
  _private: {
    TEAM_DEFINITIONS,
    FALLBACK_TEAM_ID,
    MIN_RANGE_SECONDS,
    MAX_RANGE_SECONDS,
    SAMPLE_SECONDS,
    DASHBOARD_SAMPLE_INTERVALS,
    sampleSecondsForRange,
    membershipCacheVersion,
    fetchOccupancy,
    todayStartCst,
    normalizeOccupancy,
    stateIntervals,
    aggregateOwnership,
    buildDashboardPayload,
    scopeDashboardPayload,
    mergeTeamDefinitions,
    mergeMembership,
    classifyUser,
    assignmentForUser,
    effectiveTeamForUser,
    userEvidence,
    mergeAutoAssignments,
    readMembership,
    writeMembership,
    membershipKey,
    encryptMembership,
    decryptMembership,
    MEMBERSHIP_KEY_ENV,
    millisecondsUntilNextHour,
    currentSampleSeconds,
    fetchOccupancyDay,
  },
};
