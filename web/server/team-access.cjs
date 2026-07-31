const http = require('http');
const https = require('https');

const DEFAULT_ORGANIZATION_TIMEOUT_MS = 5_000;

function createHttpError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeUsername(value) {
  const username = String(value || '').trim();
  return username ? username.toLowerCase() : null;
}

function normalizeTeam(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value).trim();
    return id ? { id, label: id, primary: false } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? value.teamId ?? value.code ?? '').trim();
  if (!id) return null;
  return {
    id,
    label: String(value.label ?? value.name ?? value.teamName ?? id).trim() || id,
    primary: value.primary === true || value.isPrimary === true || value.is_primary === true,
  };
}

function readPath(value, path) {
  if (!path) return value;
  return String(path).split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function replacePathParam(template, username) {
  return String(template || '').replaceAll('{username}', encodeURIComponent(username));
}

function requestJson(urlString, headers = {}, timeoutMs = DEFAULT_ORGANIZATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlString);
    } catch {
      reject(createHttpError('Organization service URL is invalid', 503));
      return;
    }
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!client) {
      reject(createHttpError('Organization service URL must use HTTP or HTTPS', 503));
      return;
    }
    const request = client.request(target, { method: 'GET', headers, timeout: timeoutMs }, response => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { payload += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(createHttpError(`Organization service returned ${response.statusCode}`, 503));
          return;
        }
        try {
          resolve(JSON.parse(payload));
        } catch {
          reject(createHttpError('Organization service returned invalid JSON', 503));
        }
      });
    });
    request.on('timeout', () => request.destroy(createHttpError('Organization service timed out', 503)));
    request.on('error', error => reject(createHttpError(`Organization service request failed: ${error.message}`, 503)));
    request.end();
  });
}

function teamsFromResponse(payload) {
  const value = payload?.data ?? payload;
  const rawTeams = Array.isArray(value)
    ? value
    : Array.isArray(value?.teams)
      ? value.teams
      : value?.primaryTeam || value?.team
        ? [value.primaryTeam || value.team]
        : [];
  return rawTeams.map(normalizeTeam).filter(Boolean);
}

function primaryTeamFromResponse(payload) {
  const teams = teamsFromResponse(payload);
  if (!teams.length) return null;
  return teams.find(team => team.primary) || teams[0];
}

function createTeamAccessService(config = {}, options = {}) {
  const settings = config.teamAccess || {};
  const enabled = settings.enabled === true;
  const administrators = new Set((settings.globalAdmins || []).map(normalizeUsername).filter(Boolean));
  const identity = settings.identity || {};
  const organization = settings.organization || {};
  const fetchJson = options.fetchJson || requestJson;
  const resolveIdentity = options.resolveIdentity || (async authorization => {
    if (!identity.path) throw createHttpError('Team access is enabled but identity.path is not configured', 503);
    const baseUrl = identity.baseUrl || `http://${config.backend?.lockbot?.host || ''}:${config.backend?.lockbot?.port || ''}`;
    const payload = await fetchJson(new URL(identity.path, baseUrl).toString(), { authorization: authorization || '' }, identity.timeoutMs || DEFAULT_ORGANIZATION_TIMEOUT_MS);
    const username = normalizeUsername(readPath(payload, identity.usernamePath || 'username'));
    if (!username) throw createHttpError('Current-user endpoint returned no username', 503);
    return username;
  });
  const resolveUserTeam = options.resolveUserTeam || (async username => {
    if (!organization.baseUrl || !organization.userTeamsPath) {
      throw createHttpError('Team access is enabled but organization.userTeamsPath is not configured', 503);
    }
    const headers = {};
    if (organization.apiTokenEnv) {
      const token = process.env[organization.apiTokenEnv];
      if (!token) throw createHttpError(`Organization service token ${organization.apiTokenEnv} is not configured`, 503);
      headers.authorization = `Bearer ${token}`;
    }
    const payload = await fetchJson(
      new URL(replacePathParam(organization.userTeamsPath, username), organization.baseUrl).toString(),
      headers,
      organization.timeoutMs || DEFAULT_ORGANIZATION_TIMEOUT_MS,
    );
    return primaryTeamFromResponse(payload);
  });

  async function authorize(authorization) {
    if (!authorization) throw createHttpError('Authorization is required', 401);
    if (!enabled) return { enabled: false, mode: 'all', teamIds: null, username: null, cacheKey: 'disabled' };
    const username = normalizeUsername(await resolveIdentity(authorization));
    if (!username) throw createHttpError('Current user is not identified', 403);
    if (administrators.has(username)) {
      return { enabled: true, mode: 'all', teamIds: null, username, cacheKey: `admin:${username}` };
    }
    const team = await resolveUserTeam(username);
    if (!team) throw createHttpError('Current user has no primary team', 403);
    return {
      enabled: true,
      mode: 'team',
      teamIds: [team.id],
      teams: [team],
      username,
      cacheKey: `team:${username}:${team.id}`,
    };
  }

  async function resolveMembership(userIds) {
    if (!enabled) throw new Error('Organization membership is only available when team access is enabled');
    const uniqueUserIds = [...new Set(userIds.map(userId => String(userId || '').trim()).filter(Boolean))];
    const results = await Promise.all(uniqueUserIds.map(async userId => [userId, await resolveUserTeam(normalizeUsername(userId))]));
    const assignments = {};
    const teams = new Map();
    for (const [userId, team] of results) {
      if (!team) continue;
      assignments[userId] = { team: team.id, source: 'organization', pending: false, confidence: 1 };
      teams.set(team.id, { id: team.id, label: team.label });
    }
    return {
      version: `organization:${[...teams.keys()].sort().join(',')}`,
      generatedAt: new Date().toISOString(),
      window: null,
      lastError: null,
      assignments,
      teams: [...teams.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
    };
  }

  return { enabled, authorize, resolveMembership };
}

module.exports = {
  createTeamAccessService,
  _private: { normalizeUsername, normalizeTeam, teamsFromResponse, primaryTeamFromResponse, readPath },
};
