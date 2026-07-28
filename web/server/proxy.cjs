const http = require('http');
const fs = require('fs');
const path = require('path');
const { createTrendService } = require('./trend-service.cjs');
const { createTeamService, _private: teamPrivate } = require('./team-service.cjs');
const clusterScope = require('../shared/cluster-scope.json');

const WEB_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(WEB_ROOT, '..');
const DIST_ROOT = path.join(WEB_ROOT, 'dist');
const PERSONAL_DIST_ROOT = path.join(PROJECT_ROOT, 'person', 'dist');
const LEGACY_STATIC_FILES = new Set([
  'index.html',
  'api.js',
  'adapter.js',
  'timeline.js',
  'china-time.js',
  'styles.css',
  'value.html',
  'team.html',
]);
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const TREND_NODE_NAMES = new Set(clusterScope.nodeIds.map(node => `node${node}`));
const TREND_INTERVALS = new Set([60, 120, 240, 300, 480, 1200, 7200, 21600, 43200]);
const CHINA_UTC_OFFSET_SECONDS = 8 * 60 * 60;

function addChinaMonths(timestamp, months) {
  const chinaDate = new Date((timestamp + CHINA_UTC_OFFSET_SECONDS) * 1000);
  const targetMonthIndex = chinaDate.getUTCMonth() + months;
  const targetYear = chinaDate.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Math.floor((Date.UTC(
    targetYear,
    targetMonth,
    Math.min(chinaDate.getUTCDate(), lastDay),
    chinaDate.getUTCHours(),
    chinaDate.getUTCMinutes(),
    chinaDate.getUTCSeconds(),
  ) - CHINA_UTC_OFFSET_SECONDS * 1000) / 1000);
}

let config = {
  proxy: { port: 8900, bind: '0.0.0.0' },
  backend: {
    lockbot: { host: '10.48.184.184', port: 8000 },
    monquery: { host: 'api.mt.noah.baidu.com', port: 8557 },
  },
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log('Loaded config.json');
  } catch (error) {
    console.warn(`Failed to parse config.json, using defaults: ${error.message}`);
  }
} else {
  console.warn('config.json not found, using built-in defaults');
}

if (process.env.PROXY_PORT) config.proxy.port = Number.parseInt(process.env.PROXY_PORT, 10);
if (process.env.LOCKBOT_HOST) config.backend.lockbot.host = process.env.LOCKBOT_HOST;
if (process.env.LOCKBOT_PORT) config.backend.lockbot.port = Number.parseInt(process.env.LOCKBOT_PORT, 10);
if (process.env.MONQUERY_HOST) config.backend.monquery.host = process.env.MONQUERY_HOST;
if (process.env.MONQUERY_PORT) config.backend.monquery.port = Number.parseInt(process.env.MONQUERY_PORT, 10);

const trendService = createTrendService(config);
const teamService = createTeamService(config);
teamService.schedule();
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function proxyTo(targetHost, targetPort, req, res) {
  const headers = { ...req.headers, host: `${targetHost}:${targetPort}` };
  delete headers['sec-fetch-site'];
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-dest'];
  const proxyRequest = http.request({ hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers }, proxyResponse => {
    res.writeHead(proxyResponse.statusCode, {
      ...proxyResponse.headers,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    proxyResponse.pipe(res);
  });
  proxyRequest.on('error', error => {
    console.error(`Proxy error: ${error.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy failed', detail: error.message }));
  });
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') proxyRequest.end();
  else req.pipe(proxyRequest);
}

function servePersonalStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice('/personal/'.length)) || 'index.html';
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  let filePath = path.resolve(PERSONAL_DIST_ROOT, relativePath);
  if (filePath !== PERSONAL_DIST_ROOT && !filePath.startsWith(PERSONAL_DIST_ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (error, data) => {
    if (error && !path.extname(relativePath)) {
      filePath = path.join(PERSONAL_DIST_ROOT, 'index.html');
      return fs.readFile(filePath, (entryError, entryData) => {
        if (entryError) {
          res.writeHead(404);
          return res.end('Personal build not found. Run npm run build in person/.');
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(entryData);
      });
    }
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const headers = { 'content-type': MIME[path.extname(relativePath)] || 'application/octet-stream' };
    if (relativePath.startsWith('assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function serveLegacyStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  let filename;
  try {
    filename = decodeURIComponent(pathname.slice(1));
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (!LEGACY_STATIC_FILES.has(filename)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const filePath = path.join(PROJECT_ROOT, filename);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end(`Legacy file not found: ${filename}`);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const relativePath = pathname === '/' || pathname === '/app/'
    ? 'index.html'
    : pathname.startsWith('/app/') ? pathname.slice('/app/'.length) : pathname.slice(1);
  let filePath = path.resolve(DIST_ROOT, decodeURIComponent(relativePath));
  if (filePath !== DIST_ROOT && !filePath.startsWith(DIST_ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (error, data) => {
    if (error && !path.extname(relativePath)) {
      filePath = path.join(DIST_ROOT, 'index.html');
      return fs.readFile(filePath, (entryError, entryData) => {
        if (entryError) {
          res.writeHead(404);
          return res.end('Build not found. Run npm run build.');
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(entryData);
      });
    }
    if (error) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const headers = { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    if (relativePath.startsWith('assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendApiError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
    ? error.statusCode
    : 502;
  if (statusCode >= 500) console.error(`Team API failed: ${error?.message || 'Unknown error'}`);
  sendJson(res, statusCode, { error: error?.message || 'Team API failed' });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }
  if (req.url.startsWith('/api/server-time')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ now: Date.now() }));
  }
  if (req.url.startsWith('/api/cluster-trend')) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    const params = new URL(req.url, 'http://localhost').searchParams;
    const startAt = Number(params.get('start'));
    const endAt = Number(params.get('end'));
    const intervalSeconds = Number(params.get('interval') || 300);
    if (!Number.isInteger(startAt) || !Number.isInteger(endAt) || startAt > endAt || endAt > addChinaMonths(startAt, 6) || !TREND_INTERVALS.has(intervalSeconds)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid trend range or interval' }));
    }
    const requestedNodes = params.getAll('nodes').flatMap(value => value.split(',').filter(Boolean));
    const nodes = params.has('nodes') ? [...new Set(requestedNodes)] : null;
    if (nodes !== null && (!nodes.length || nodes.length !== requestedNodes.length || nodes.some(node => !TREND_NODE_NAMES.has(node)))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid trend nodes' }));
    }
    return trendService.query(startAt, endAt, req.headers.authorization, nodes, intervalSeconds)
      .then(data => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(data));
      })
      .catch(error => {
        console.error(`Trend query failed: ${error.message}`);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Trend query failed', detail: error.message }));
      });
  }
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname === '/api/team-membership') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    return teamService.getMembership(req.headers.authorization)
      .then(data => sendJson(res, 200, data))
      .catch(error => sendApiError(res, error));
  }
  if (requestUrl.pathname === '/api/team-dashboard') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const startAt = Number(requestUrl.searchParams.get('start'));
    const endAt = Number(requestUrl.searchParams.get('end'));
    const duration = endAt - startAt;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(startAt) || !Number.isInteger(endAt) || startAt >= endAt
      || duration < teamPrivate.MIN_RANGE_SECONDS || duration > teamPrivate.MAX_RANGE_SECONDS
      || endAt > nowSeconds + 300) {
      return sendJson(res, 400, { error: 'Team range must be between 3 hours and 7 days' });
    }
    return teamService.queryDashboard(req.headers.authorization, startAt, endAt)
      .then(data => sendJson(res, 200, data))
      .catch(error => sendApiError(res, error));
  }
  if (req.url.startsWith('/lockbot')) {
    req.url = req.url.replace('/lockbot', '');
    return proxyTo(config.backend.lockbot.host, config.backend.lockbot.port, req, res);
  }
  if (req.url.startsWith('/monquery')) {
    req.url = req.url.replace('/monquery', '');
    return proxyTo(config.backend.monquery.host, config.backend.monquery.port, req, res);
  }
  if (new URL(req.url, 'http://localhost').pathname === '/personal') {
    res.writeHead(302, { location: '/personal/' });
    return res.end();
  }
  if (req.url.startsWith('/personal/')) return servePersonalStatic(req, res);
  // 根目录保留的静态旧版必须通过显式 /index.html 访问；
  // Vue 生产页继续使用 / 或 /app/，避免影响已存在的入口。
  if (LEGACY_STATIC_FILES.has(new URL(req.url, 'http://localhost').pathname.slice(1))) return serveLegacyStatic(req, res);
  return serveStatic(req, res);
});

server.listen(config.proxy.port, config.proxy.bind, () => {
  console.log(`XPU monitor ready at http://localhost:${config.proxy.port}/`);
});
