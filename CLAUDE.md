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

- `web/src/views/ClusterDashboard.vue`：集群视图入口，编排 UI。
- `web/src/views/TeamDashboard.vue`：团队视图入口，调用 `fetchTeamDashboard`（`services/api.js`）展示按团队聚合的占用与排行。
- `web/src/services/`：所有业务逻辑所在层——API 请求（`api.js`）、Lock Bot 状态合并（`cluster-state.js`）、Monquery 数据适配（`adapter.js`）、中国时区转换（`china-time.js`）、图表数据（`chart-data.js`）、自动刷新策略（`auto-refresh.js`）。**保持请求逻辑位于 service、数据转换位于 adapter、页面渲染位于 view**，不要在组件里内联这些逻辑。`api.js` 中 Monquery 请求按节点分批并行发起（`Promise.all`/`Promise.race`），实测节点级查询（首屏）与卡级明细查询（渐进渲染）均在亚秒级完成，新增 Monquery 查询时沿用并行批量请求模式，不要改成串行请求。
- `web/server/`：Node 代理（`proxy.cjs`，默认监听 8900）、趋势服务（`trend-service.cjs`）、SQLite 趋势存储与 Lock Bot 历史缓存（`trend-store.cjs`）、团队视图服务（`team-service.cjs`）。
- `web/shared/cluster-scope.json`：**监控范围的唯一权威来源**——当前 68 个计算节点（`nodeIds`，历史上分批上线，记录于 `nodeGroups`，趋势查询按各节点的 `effectiveFrom` 生效日期决定分母）、每节点 8 卡，共 544 卡；BDC 节点不计入集群趋势分母。当前时间线为基础 46 节点、2026-07-24 增加 10 节点、2026-07-29 10:00（中国时间）再增加 10 节点、2026-08-12 18:00（中国时间）再增加 node83 与 node84；`pendingNodeGroups` 当前为空。任何涉及节点/卡数量的逻辑都应引用这个文件（及 `cluster-scope-timeline.cjs` 的时间线辅助函数），不要硬编码或重复定义常量。
- `web/test/cluster-data.test.mjs`：覆盖集群范围、状态适配、趋势计算、缓存、刷新策略与团队分类/聚合逻辑。新增聚合、锁覆盖、区间、缓存或团队相关改动时，在此文件补充对应用例。

代理路由（`web/server/proxy.cjs`）：
- `/` 或 `/app/` → 重定向或提供 `web/dist`（集群视图主应用）；`/team` 提供团队视图
- `/personal/` → `person/dist`
- `/lockbot/*`、`/monquery/*` → 内部后端代理
- `/api/cluster-trend` → 聚合集群历史趋势（同时返回 XPU、显存、锁定卡比例）
- `/api/team-membership`、`/api/team-dashboard` → 团队视图的成员映射与聚合看板数据（`team-service.cjs`）

### 团队视图（`team-service.cjs`）

- 团队视图按用户名将节点/卡占用归属到 `TEAM_DEFINITIONS`（算子测试团队、推理团队、训练团队、通用研发）。默认使用 `.devdata/team-membership.json` 中固定映射，所有筛选区间共用该映射；代理不会自动刷新或重分类。启用 `teamAccess` 后，访问范围与成员归属可由身份和组织服务解析，未完整配置时必须失败关闭。团队页先返回一个团队，后台再按绑定到账号和时间范围、5 分钟有效的令牌补齐其余数据。
- 团队场景下的调度/分析窗口使用 Unix 秒（不是毫秒），窗口长度、最小/最大区间常量定义在 `team-service.cjs` 顶部。

### 数据口径（核心业务规则）

- 当前节点状态取**最近已完成**的 5 分钟采样槽。
- XPU 或显存利用率达到 10% 时该卡判定为 BUSY；卡级采样不完整时保留 `UNKNOWN`，**不将缺失数据误判为空闲**。
- Lock Bot 的 NODE/QUEUE 锁覆盖全节点；DEVICE 锁仅覆盖 `device_id` 指定的卡。趋势按唯一的“节点:卡”集合计算，避免重叠记录重复计数。
- 历史 Lock Bot 请求不完整时，`/api/cluster-trend` 的锁定趋势返回 `null`，不会伪装为 0%。

### 配置与安全

代理从项目根目录读取 `config.json`，以 `backend.*.hostEnv` 和 `portEnv` 指定后端地址来源；`PROXY_PORT`、`LOCKBOT_HOST`、`LOCKBOT_PORT`、`MONQUERY_HOST`、`MONQUERY_PORT` 可注入实际连接配置。应用会话是浏览器持有的随机短期令牌；后端使用服务账号获取并缓存 Lock Bot 令牌，浏览器不接触该凭据。`/lockbot/*` 仅允许已登录会话的只读请求。**不得提交** Token、账号密码、真实后端地址，或日志中的 Authorization 请求头。

## Coding Style

JavaScript/Vue：两个空格缩进、分号、单引号。函数用 camelCase（如 `fetchLockBotList`），Vue 组件用 PascalCase（如 `ClusterDashboard.vue`），多词文件用 kebab-case（如 `trend-service.cjs`）。

## Commit Convention

使用简洁的祈使式中文提交信息，例如 `修复趋势节点范围校验`。

## 生产部署（klx，仅在明确要求发布时执行）

- 代码目录：`/root/workspace/monitor`；分支：`lmonitor`。
- 主应用目录：`/root/workspace/monitor/web`；服务监听 `8900`。
- `web/pm2.config.cjs` 中当前应用服务名为 `xpu-monitor`，工作目录为 `web/`，默认监听 8900。发布前以实际部署主机上的 PM2 配置和 `AGENTS.md` 为准，不要依据历史进程名猜测服务。
- PM2 由已启用的 `pm2-root.service` 在开机时从 `/root/.pm2/dump.pm2` 恢复进程列表；该 systemd 单元显示 `inactive (dead)` 是正常现象。

发布步骤（`npm ci` 必须在 `web/` 内运行）：

```bash
cd /root/workspace/monitor
git pull --ff-only origin lmonitor

cd web
npm ci
npm test
npm run build

pm2 restart xpu-monitor --update-env
pm2 status
pm2 logs xpu-monitor --lines 50 --nostream
pm2 save
```

发布后健康检查：

```bash
curl --noproxy '*' -i http://127.0.0.1:8900/
curl --noproxy '*' -i 'http://127.0.0.1:8900/api/cluster-trend?start=1784250000&end=1784250300&interval=60'
```

预期首页与趋势接口均返回 `200`。未带浏览器 Authorization 时，趋势中的 `lock` 为 `null`、`lockStatus.complete` 为 `false`，但 XPU 和显存趋势仍应正常返回；需用正常账户登录后再验证完整锁定趋势。
