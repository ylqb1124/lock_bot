const crypto = require('crypto');
const http = require('http');

const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LOCKBOT_TOKEN_TTL_MS = 15 * 60 * 1000;

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
    return id ? { id, label: id } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? value.teamId ?? '').trim();
  if (!id) return null;
  return { id, label: String(value.label ?? value.name ?? id).trim() || id };
}

function authorizationToken(authorization) {
  const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function passwordsMatch(expected, supplied) {
  const expectedHash = crypto.createHash('sha256').update(String(expected || '')).digest();
  const suppliedHash = crypto.createHash('sha256').update(String(supplied || '')).digest();
  return crypto.timingSafeEqual(expectedHash, suppliedHash);
}

function durationMs(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(60_000, seconds * 1000)
    : fallback;
}

function requestJson(host, port, requestPath, options = {}) {
  const payload = options.body ? JSON.stringify(options.body) : null;
  const headers = { ...(options.headers || {}) };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: host,
      port,
      path: requestPath,
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 10_000,
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(createHttpError(`Lock Bot service returned ${response.statusCode}`, 503));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(createHttpError('Lock Bot service returned invalid JSON', 503));
        }
      });
    });
    request.on('timeout', () => request.destroy(createHttpError('Lock Bot service timed out', 503)));
    request.on('error', error => reject(createHttpError(`Lock Bot service request failed: ${error.message}`, 503)));
    if (payload) request.write(payload);
    request.end();
  });
}

function createAppAuthService(config = {}, options = {}) {
  const settings = config.appAuth || {};
  const nowMs = options.nowMs || (() => Date.now());
  const getEnvironment = options.getEnvironment || (name => process.env[name]);
  const request = options.requestJson || requestJson;
  const sessionTtlMs = durationMs(settings.sessionTtlSeconds, DEFAULT_SESSION_TTL_MS);
  const lockBotTokenTtlMs = durationMs(settings.lockbotTokenTtlSeconds, DEFAULT_LOCKBOT_TOKEN_TTL_MS);
  const accounts = new Map();
  for (const source of settings.accounts || []) {
    const username = normalizeUsername(source?.username);
    const passwordEnv = String(source?.passwordEnv || '').trim();
    if (!username || !passwordEnv || accounts.has(username)) continue;
    const team = normalizeTeam(source.team);
    accounts.set(username, {
      username,
      displayName: String(source.displayName || source.username || username).trim() || username,
      passwordEnv,
      role: String(source.role || '').toLowerCase(),
      team,
    });
  }
  const sessions = new Map();
  const lockbot = settings.lockbot || {};
  const lockbotUsernameEnv = String(lockbot.usernameEnv || 'LOCKBOT_SERVICE_USERNAME').trim();
  const lockbotPasswordEnv = String(lockbot.passwordEnv || 'LOCKBOT_SERVICE_PASSWORD').trim();
  let lockbotAuthorization = null;
  let lockbotAuthorizationExpiresAt = 0;
  let lockbotAuthorizationInFlight = null;

  function purgeSessions(now = nowMs()) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  function publicSession(session) {
    return {
      token: session.token,
      username: session.account.username,
      displayName: session.account.displayName,
      mode: session.account.role === 'admin' ? 'all' : 'team',
      expiresAt: Math.floor(session.expiresAt / 1000),
    };
  }

  function accountAccess(account) {
    if (account.role === 'admin') {
      return {
        enabled: true,
        mode: 'all',
        teamIds: null,
        teams: null,
        username: account.username,
        cacheKey: `admin:${account.username}`,
        membershipSource: 'whitelist',
      };
    }
    if (!account.team) throw createHttpError('当前账号未配置团队归属', 403);
    return {
      enabled: true,
      mode: 'team',
      teamIds: [account.team.id],
      teams: [account.team],
      username: account.username,
      cacheKey: `team:${account.username}:${account.team.id}`,
      membershipSource: 'whitelist',
    };
  }

  async function login(username, password) {
    purgeSessions();
    const account = accounts.get(normalizeUsername(username));
    if (!account) throw createHttpError('用户名或密码错误', 401);
    const expectedPassword = getEnvironment(account.passwordEnv);
    if (!expectedPassword) throw createHttpError('应用登录密码尚未配置', 503);
    if (!passwordsMatch(expectedPassword, password)) throw createHttpError('用户名或密码错误', 401);
    const token = crypto.randomBytes(32).toString('base64url');
    const session = { token, account, expiresAt: nowMs() + sessionTtlMs };
    sessions.set(token, session);
    return publicSession(session);
  }

  function authenticate(authorization) {
    purgeSessions();
    const token = authorizationToken(authorization);
    const session = token ? sessions.get(token) : null;
    if (!session) throw createHttpError('登录已过期，请重新登录', 401);
    return session;
  }

  async function authorize(authorization) {
    return accountAccess(authenticate(authorization).account);
  }

  async function resolveMembership(userIds) {
    const assignments = {};
    const teams = new Map();
    for (const userId of [...new Set(userIds || [])]) {
      const account = accounts.get(normalizeUsername(userId));
      if (!account?.team) continue;
      assignments[userId] = { team: account.team.id, source: 'whitelist', pending: false, confidence: 1 };
      teams.set(account.team.id, account.team);
    }
    return {
      version: `whitelist:${[...teams.keys()].sort().join(',')}`,
      generatedAt: new Date(nowMs()).toISOString(),
      window: null,
      lastError: null,
      assignments,
      teams: [...teams.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
    };
  }

  async function getLockBotAuthorization() {
    const now = nowMs();
    if (lockbotAuthorization && lockbotAuthorizationExpiresAt > now) return lockbotAuthorization;
    if (lockbotAuthorizationInFlight) return lockbotAuthorizationInFlight;
    const username = getEnvironment(lockbotUsernameEnv);
    const password = getEnvironment(lockbotPasswordEnv);
    if (!username || !password) throw createHttpError('Lock Bot 服务账号尚未配置', 503);
    lockbotAuthorizationInFlight = request(config.backend?.lockbot?.host, config.backend?.lockbot?.port, '/api/auth/login', {
      method: 'POST',
      body: { username, password },
    }).then(payload => {
      if (!payload?.access_token) throw createHttpError('Lock Bot 服务账号未返回访问令牌', 503);
      lockbotAuthorization = `Bearer ${payload.access_token}`;
      lockbotAuthorizationExpiresAt = nowMs() + lockBotTokenTtlMs;
      return lockbotAuthorization;
    }).finally(() => { lockbotAuthorizationInFlight = null; });
    return lockbotAuthorizationInFlight;
  }

  function logout(authorization) {
    const token = authorizationToken(authorization);
    if (token) sessions.delete(token);
  }

  return { login, logout, authenticate, authorize, resolveMembership, getLockBotAuthorization };
}

module.exports = {
  createAppAuthService,
  _private: { normalizeUsername, normalizeTeam, authorizationToken, passwordsMatch, durationMs },
};
