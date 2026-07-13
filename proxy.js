// proxy.js — 本地代理，解决内网 API 跨域问题
// 用法: node proxy.js
// 访问 http://localhost:8900/index.html
//
// 配置: 从 config.json 读取，支持环境变量覆盖:
//   PROXY_PORT      — 代理监听端口
//   LOCKBOT_HOST    — Lock Bot 服务 IP
//   LOCKBOT_PORT    — Lock Bot 服务端口
//   MONQUERY_HOST   — Monquery 服务 IP
//   MONQUERY_PORT   — Monquery 服务端口

const http = require('http');
const fs = require('fs');
const path = require('path');
const { TrendStore } = require('./trend-store');
const { createTrendService } = require('./trend-service');

// ---- 加载配置 ----
let config = {
  proxy: { port: 8900, bind: '0.0.0.0' },
  backend: {
    lockbot: { host: '10.48.184.184', port: 8000 },
    monquery: { host: 'api.mt.noah.baidu.com', port: 8557 },
  },
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    console.log('✓ Loaded config.json');
  } catch (err) {
    console.warn('⚠ Failed to parse config.json, using defaults:', err.message);
  }
} else {
  console.warn('⚠ config.json not found, using built-in defaults');
}

// 环境变量覆盖
if (process.env.PROXY_PORT)    config.proxy.port = parseInt(process.env.PROXY_PORT, 10);
if (process.env.LOCKBOT_HOST)  config.backend.lockbot.host = process.env.LOCKBOT_HOST;
if (process.env.LOCKBOT_PORT)  config.backend.lockbot.port = parseInt(process.env.LOCKBOT_PORT, 10);
if (process.env.MONQUERY_HOST) config.backend.monquery.host = process.env.MONQUERY_HOST;
if (process.env.MONQUERY_PORT) config.backend.monquery.port = parseInt(process.env.MONQUERY_PORT, 10);

const PORT = config.proxy.port;
const ROOT = __dirname;
const trendStore = new TrendStore(path.join(ROOT, '.devdata', 'xpu-monitor.sqlite'));
const trendService = createTrendService(config, trendStore);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// 转发请求到目标服务器
function proxyTo(targetHost, targetPort, req, res) {
  const options = {
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
  };
  delete options.headers['sec-fetch-site'];
  delete options.headers['sec-fetch-mode'];
  delete options.headers['sec-fetch-dest'];

  const proxyReq = http.request(options, proxyRes => {
    // 注入 CORS 头让浏览器接受
    const headers = {
      ...proxyRes.headers,
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    };
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', err => {
    console.error('Proxy error:', err.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy failed', detail: err.message }));
  });

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const server = http.createServer((req, res) => {
  const url = req.url;

  // OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }

  // ---- 集群趋势缓存接口 ----
  if (url.startsWith('/api/cluster-trend')) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    const params = new URL(url, 'http://localhost').searchParams;
    const startAt = Number(params.get('start'));
    const endAt = Number(params.get('end'));
    const maxRange = 90 * 24 * 60 * 60;
    if (!Number.isInteger(startAt) || !Number.isInteger(endAt) || startAt > endAt || endAt - startAt > maxRange) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid trend range' }));
    }
    return trendService.query(startAt, endAt, req.headers.authorization)
      .then(data => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(data));
      })
      .catch(error => {
        console.error('Trend query failed:', error.message);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Trend query failed', detail: error.message }));
      });
  }

  // ---- 代理路由 ----
  // /lockbot/*  → Lock Bot 后端
  if (url.startsWith('/lockbot')) {
    req.url = url.replace('/lockbot', '');
    return proxyTo(config.backend.lockbot.host, config.backend.lockbot.port, req, res);
  }

  // /monquery/* → Monquery 后端
  if (url.startsWith('/monquery')) {
    req.url = url.replace('/monquery', '');
    return proxyTo(config.backend.monquery.host, config.backend.monquery.port, req, res);
  }

  // ---- 静态文件 ----
  const pathname = new URL(url, 'http://localhost').pathname;
  const appRequest = pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/');
  const relativePath = appRequest
    ? (pathname === '/app' || pathname === '/app/' ? 'index.html' : pathname.slice('/app/'.length))
    : (pathname === '/' || pathname === '/demo.html' ? 'index.html' : pathname.slice(1));
  const staticRoot = appRequest ? path.join(ROOT, 'web', 'dist') : ROOT;
  let filePath = path.resolve(staticRoot, decodeURIComponent(relativePath));

  // 安全检查：禁止跳出对应静态目录
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    // /app/ 是单路由 SPA；未来添加前端路由时仍能返回入口文件。
    if (err && appRequest && !path.extname(relativePath)) {
      filePath = path.join(staticRoot, 'index.html');
      return fs.readFile(filePath, (entryError, entryData) => {
        if (entryError) {
          res.writeHead(404);
          return res.end('Not found: ' + url);
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(entryData);
      });
    }
    if (err) {
      res.writeHead(404);
      return res.end('Not found: ' + url);
    }
    const ext = path.extname(filePath);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
    if (appRequest && pathname.startsWith('/app/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✓ Proxy ready at http://localhost:${PORT}/index.html`);
  console.log(`  Lock Bot  → ${config.backend.lockbot.host}:${config.backend.lockbot.port} (via /lockbot)`);
  console.log(`  Monquery  → ${config.backend.monquery.host}:${config.backend.monquery.port} (via /monquery)`);
});
