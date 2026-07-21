# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

XPU 资源监控看板：展示开发机集群的 XPU 利用率、显存利用率与 Lock Bot 资源锁定情况。当前生产应用是 `web/`（Vue 3 + Vite + Node 代理），通过代理访问内部 Lock Bot 和 Monquery 服务，提供最长六个月的集群趋势。所有时间展示与查询统一使用中国时区（UTC+8）。

仓库根目录下的静态文件（`index.html`、`api.js`、`adapter.js`、`timeline.js`、`proxy.js` 等）是旧版静态看板，维护时仍需兼容 Lock Bot 的 `resource_type` 与 `device_id` 字段。`person/` 是独立的个人视图 Vue 应用。

## Commands

需要 Node.js 22+（服务端使用实验性的 `node:sqlite`）。首次运行需从 `config.example.json` 创建 `config.json`（不要提交真实地址或凭据）。

```bash
cp config.example.json config.json

cd web
npm ci
npm run dev      # Vite 开发服务器
npm test         # node:test 用例（node --test test/*.test.mjs）
npm run build    # 生成 web/dist
npm start        # 启动 Node 代理 + 生产构建（server/proxy.cjs，默认端口 8900）
```

运行单个测试文件：`node --test web/test/cluster-data.test.mjs`

个人视图（`person/`）：`cd person && npm ci && npm run build`

**修改 `web/` 后必须至少运行 `npm test` 与 `npm run build`**，并手工验证登录、趋势、刷新和错误降级路径。没有配置 lint 任务。

## Architecture

### web/（生产应用）

- `web/src/views/ClusterDashboard.vue`：页面入口，编排 UI。
- `web/src/services/`：所有业务逻辑所在层——API 请求（`api.js`）、Lock Bot 状态合并（`cluster-state.js`）、Monquery 数据适配（`adapter.js`）、中国时区转换（`china-time.js`）、图表数据（`chart-data.js`）、自动刷新策略（`auto-refresh.js`）。**保持请求逻辑位于 service、数据转换位于 adapter、页面渲染位于 view**，不要在组件里内联这些逻辑。
- `web/server/`：Node 代理（`proxy.cjs`，默认监听 8900）、趋势服务（`trend-service.cjs`）、SQLite 趋势存储与 Lock Bot 历史缓存（`trend-store.cjs`）。
- `web/shared/cluster-scope.json`：**监控范围的唯一权威来源**——46 个计算节点、每节点 8 卡，共 368 卡；BDC 节点不计入集群趋势分母。任何涉及节点/卡数量的逻辑都应引用这个文件，不要硬编码或重复定义常量。
- `web/test/cluster-data.test.mjs`：覆盖集群范围、状态适配、趋势计算、缓存与刷新策略。新增聚合、锁覆盖、区间或缓存相关改动时，在此文件补充对应用例。

代理路由（`web/server/proxy.cjs`）：
- `/` 或 `/app/` → `web/dist`（主应用）
- `/personal/` → `person/dist`
- `/lockbot/*`、`/monquery/*` → 内部后端代理
- `/api/cluster-trend` → 聚合集群历史趋势（同时返回 XPU、显存、锁定卡比例）

### 数据口径（核心业务规则）

- 当前节点状态取**最近已完成**的 5 分钟采样槽。
- XPU 或显存利用率达到 10% 时该卡判定为 BUSY；卡级采样不完整时保留 `UNKNOWN`，**不将缺失数据误判为空闲**。
- Lock Bot 的 NODE/QUEUE 锁覆盖全节点；DEVICE 锁仅覆盖 `device_id` 指定的卡。趋势按唯一的“节点:卡”集合计算，避免重叠记录重复计数。
- 历史 Lock Bot 请求不完整时，`/api/cluster-trend` 的锁定趋势返回 `null`，不会伪装为 0%。

### 配置与安全

代理从项目根目录读取 `config.json`，支持环境变量覆盖：`PROXY_PORT`、`LOCKBOT_HOST`、`LOCKBOT_PORT`、`MONQUERY_HOST`、`MONQUERY_PORT`。浏览器 Token 仅透传给 Lock Bot。**不得提交** Token、账号密码、真实后端地址，或日志中的 Authorization 请求头。

## Coding Style

JavaScript/Vue：两个空格缩进、分号、单引号。函数用 camelCase（如 `fetchLockBotList`），Vue 组件用 PascalCase（如 `ClusterDashboard.vue`），多词文件用 kebab-case（如 `trend-service.cjs`）。

## Commit Convention

使用简洁的祈使式中文提交信息，例如 `修复趋势节点范围校验`。

## 生产部署（klx，仅在明确要求发布时执行）

- 代码目录：`/root/workspace/monitor`；分支：`lmonitor`。
- 主应用目录：`/root/workspace/monitor/web`；服务监听 `8900`。
- PM2 服务名：`monitor-cluster`（集群）、`lockbot`。**不要启动历史停止进程 `xpu-monitor`**。
- PM2 由已启用的 `pm2-root.service` 在开机时从 `/root/.pm2/dump.pm2` 恢复进程列表；该 systemd 单元显示 `inactive (dead)` 是正常现象。

发布步骤（`npm ci` 必须在 `web/` 内运行）：

```bash
cd /root/workspace/monitor
git pull --ff-only origin lmonitor

cd web
npm ci
npm test
npm run build

pm2 restart monitor-cluster
pm2 status
pm2 logs monitor-cluster --lines 50 --nostream
pm2 save
```

发布后健康检查：

```bash
curl --noproxy '*' -i http://127.0.0.1:8900/
curl --noproxy '*' -i 'http://127.0.0.1:8900/api/cluster-trend?start=1784250000&end=1784250300&interval=60'
```

预期首页与趋势接口均返回 `200`。未带浏览器 Authorization 时，趋势中的 `lock` 为 `null`、`lockStatus.complete` 为 `false`，但 XPU 和显存趋势仍应正常返回；需用正常账户登录后再验证完整锁定趋势。
