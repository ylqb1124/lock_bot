# 开发机集群 XPU 资源监控

该项目展示开发机集群的 XPU 利用率、显存利用率与 Lock Bot 资源锁定情况。当前主应用为 `web/`：它通过 Node 代理访问内部 Lock Bot 和 Monquery，并提供最长六个月的集群趋势。时间展示和查询统一使用中国时区（UTC+8）。

## 功能与数据口径

- 监控范围由 `web/shared/cluster-scope.json` 固定：56 个计算节点、每节点 8 卡，共 448 卡；BDC 节点不进入集群趋势分母。
- 当前节点状态取最近已完成的 5 分钟采样槽。XPU 或显存利用率达到 10% 时，该卡为 BUSY；卡级采样不完整时保留 `UNKNOWN`，不将缺失数据误判为空闲。
- Lock Bot 的 NODE/QUEUE 锁覆盖全节点；DEVICE 锁仅覆盖 `device_id` 指定的卡。趋势按唯一的“节点:卡”集合计算，避免重叠记录重复计数。
- `/api/cluster-trend` 同时返回 XPU、显存与锁定卡比例。历史 Lock Bot 请求不完整时，锁定趋势返回 `null`，不会伪装为 0%。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `web/` | 当前生产 Vue 3/Vite 集群仪表盘。`src/views/ClusterDashboard.vue` 是页面入口。 |
| `web/src/services/` | API 请求、Lock Bot 状态合并、Monquery 适配、中国时区、图表和刷新策略。 |
| `web/server/` | Node 代理、趋势服务、SQLite 趋势存储和 Lock Bot 历史缓存。 |
| `web/test/cluster-data.test.mjs` | 集群范围、状态适配、趋势、缓存与刷新策略测试。 |
| `person/` | 独立的个人视图 Vue 应用。 |
| 根目录静态文件 | 旧版静态页面；后续维护时仍需兼容 Lock Bot 的 `resource_type` 与 `device_id`。 |

## 本地开发与验证

需要 Node.js 22 或更高版本（服务端使用实验性的 `node:sqlite`）。先按环境创建 `config.json`，不要提交真实地址或凭据：

```bash
cp config.example.json config.json

cd web
npm ci
npm run dev                 # Vite 开发服务器
npm test                    # 11 项 node:test 用例
npm run build               # 生成 web/dist
npm start                   # 启动代理与生产构建
```

`web/server/proxy.cjs` 默认监听 `8900`，服务路由如下：

- `/` 或 `/app/`：`web/dist` 的主应用；
- `/personal/`：`person/dist`；
- `/lockbot/*`、`/monquery/*`：内部后端代理；
- `/api/cluster-trend`：聚合集群历史趋势。

修改 `web/` 后至少运行 `npm test` 与 `npm run build`；同时手工验证登录、趋势、刷新和错误降级。个人视图可运行 `cd person && npm ci && npm run build`。

## 配置与安全

代理从项目根目录读取 `config.json`，并支持 `PROXY_PORT`、`LOCKBOT_HOST`、`LOCKBOT_PORT`、`MONQUERY_HOST`、`MONQUERY_PORT` 覆盖。浏览器 Token 仅透传给 Lock Bot；不得提交 Token、账号密码、真实后端地址或日志中的 Authorization 请求头。

团队视图每小时滚动生成最近七天的模拟团队映射。部署时为 PM2 注入专用、只读的 Lock Bot 服务账号：`LOCKBOT_SERVICE_USERNAME` 与 `LOCKBOT_SERVICE_PASSWORD`。服务每轮在内存中登录获取短期 token，绝不将凭据或 token 写入 `config.json`、映射 JSON、缓存或日志。未配置服务账号时集群视图不受影响，团队页仍可按登录用户可见的占用数据查询，但会提示自动映射尚未生成。

## 生产部署（klx）

已验证的生产环境信息：

- 代码目录：`/root/workspace/monitor`；分支：`lmonitor`。
- 主应用目录：`/root/workspace/monitor/web`；服务监听 `8900`。
- PM2 集群服务名：`monitor-cluster`；Lock Bot 服务名：`lockbot`。不要启动历史停止进程 `xpu-monitor`。
- PM2 由已启用的 `pm2-root.service` 在开机时恢复 `/root/.pm2/dump.pm2` 中保存的进程列表。该 systemd 单元显示 `inactive (dead)` 是正常现象：它只在开机时执行恢复，不持续守护应用。

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

发布后的最小健康检查：

```bash
curl --noproxy '*' -i http://127.0.0.1:8900/
curl --noproxy '*' -i 'http://127.0.0.1:8900/api/cluster-trend?start=1784250000&end=1784250300&interval=60'
```

预期首页与趋势接口均返回 `200`。未带浏览器 Authorization 时，趋势中的 `lock` 会是 `null`、`lockStatus.complete` 为 `false`；XPU 和显存趋势仍可正常返回。使用正常账户在浏览器登录后，再验证完整的锁定趋势。

## 贡献约定

JavaScript/Vue 使用两个空格缩进、分号和单引号。函数使用 camelCase，Vue 组件使用 PascalCase，多词文件使用 kebab-case。保持请求逻辑位于 API service、数据转换位于 adapter、页面渲染位于 view。更多协作规范见 [AGENTS.md](AGENTS.md)。
