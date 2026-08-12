# 开发机集群 XPU 资源监控

该项目监控开发机集群的 XPU 利用率、显存利用率和 Lock Bot 资源锁定情况。生产应用位于 `web/`，由 Vue 3/Vite 前端和 Node 代理组成；全部时间展示与查询使用中国时区（UTC+8）。

## 功能与数据口径

- 监控节点范围以 `web/shared/cluster-scope.json` 为准。当前范围为 68 个计算节点、每节点 8 卡，共 544 卡；BDC 节点不进入集群趋势分母。
- 当前节点状态使用最近已完成的 5 分钟采样槽。XPU 或显存利用率达到 10% 时视为 BUSY；不完整的卡级采样保持 `UNKNOWN`，不会误判为空闲。
- Lock Bot 的 NODE/QUEUE 锁覆盖全节点，DEVICE 锁只覆盖指定卡。趋势按照唯一的“节点:卡”集合计数，避免重叠记录重复计数。
- `/api/cluster-trend` 返回 XPU、显存和锁定卡比例。Lock Bot 历史请求不完整时，锁定趋势为 `null`，不会伪装为 0%。

## 团队视图

- 团队页为 `/team`，支持最近 3 小时至 90 天的范围，历史平均值、趋势和持锁人排名均只统计有效卡级样本。
- 团队成员账号首屏只加载本团队，不发起其他团队的后台请求。
- 管理员账号每次页面会话随机选取一个有活跃负载的团队优先返回和渲染，随后以 `phase=full` 后台补齐其余团队。首屏团队在刷新和切换时间范围时保持不变。
- 初始阶段只查询首屏团队涉及的节点；后台阶段复用已取得的占用记录，仅补充剩余节点指标。后台请求令牌绑定账号、访问范围和时间范围，5 分钟后失效。
- 初始阶段仅返回首屏团队的团队数据和持锁人排名，后台失败时页面保留首屏数据并提供重试。

## 登录与权限

应用登录和 Lock Bot 服务登录是两层不同的认证：

- 浏览器只获得一个随机、4 小时有效的应用会话令牌，不会接触 Lock Bot 账号、密码或服务令牌。
- 后端使用 `LOCKBOT_SERVICE_USERNAME` 和 `LOCKBOT_SERVICE_PASSWORD` 自动登录 Lock Bot，并在内存中缓存短期服务令牌。
- 全部 Bot 列表与当天原始占用记录在内存中最多保留 50 秒；服务启动时预热、每分钟更新。历史完整自然日仍使用持久化缓存；实时运行状态不缓存。
- `/lockbot/*` 只接受已登录会话的只读查询；Lock Bot 登录接口和写操作被代理拒绝。
- 白名单定义在根目录 `config.json` 的 `appAuth.accounts`。管理员账号使用 `"role": "admin"`；团队成员账号必须配置 `team.id` 和 `team.label`。
- 密码只通过对应的环境变量提供，例如 `XPU_MONITOR_BOSS_PASSWORD`，不得写入 `config.json`、示例配置、日志或 Git。

管理员白名单账号为 `admin`、`boss` 和节点查看账号 `user`。其密码分别由部署环境中的 `XPU_MONITOR_ADMIN_PASSWORD`、`XPU_MONITOR_BOSS_PASSWORD` 与 `XPU_MONITOR_USER_PASSWORD` 提供。要让团队成员看到完整的本团队数据，应为该团队所有可能持锁的 Lock Bot 用户分别创建白名单账号并指定相同的团队信息。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `web/src/App.vue` | 应用登录页和会话恢复。 |
| `web/src/views/ClusterDashboard.vue` | 集群监控主视图。 |
| `web/src/views/TeamDashboard.vue` | 团队效率、趋势和排名视图。 |
| `web/src/services/` | API 请求、Lock Bot 状态合并、Monquery 适配、中国时区、图表和刷新策略。 |
| `web/server/app-auth.cjs` | 白名单会话、权限解析和 Lock Bot 服务令牌缓存。 |
| `web/server/` | Node 代理、趋势服务、团队聚合、持久化趋势和 Lock Bot 历史缓存。 |
| `web/shared/cluster-scope.json` | 集群节点与生效时间的唯一来源。 |
| `web/test/cluster-data.test.mjs` | 指标、缓存、权限、团队阶段加载和登录服务测试。 |
| `person/` | 独立的个人视图 Vue 应用。 |

## 本地开发与验证

需要 Node.js 22 或更高版本。使用示例配置创建环境配置，真实地址和密码不得提交：

```bash
cp config.example.json config.json

cd web
npm ci
npm test
npm run build
npm start
```

主应用由 `web/server/proxy.cjs` 提供，默认监听 `8900`：

- `/` 或 `/app/`：`web/dist` 主应用；
- `/team`：团队视图；
- `/personal/`：`person/dist`；
- `/api/auth/login`、`/api/auth/logout`：应用会话；
- `/api/cluster-trend`、`/api/team-dashboard`：聚合监控接口；
- `/lockbot/*`：仅面向已登录会话的 Lock Bot 只读代理；
- `/monquery/*`：Monquery 代理。

每次修改 `web/` 后运行 `npm test` 和 `npm run build`，并检查登录、过期会话、团队初始/后台加载、刷新与错误降级。

## 配置与安全

代理从项目根目录读取 `config.json`。后端地址不写入配置文件：`backend.*.hostEnv` 与 `portEnv` 声明所需的环境变量，生产环境须注入 `LOCKBOT_HOST`、`LOCKBOT_PORT`、`MONQUERY_HOST` 和 `MONQUERY_PORT`。`PROXY_PORT` 可覆盖监听端口。应用认证配置示例：

```json
{
  "appAuth": {
    "lockbot": {
      "usernameEnv": "LOCKBOT_SERVICE_USERNAME",
      "passwordEnv": "LOCKBOT_SERVICE_PASSWORD"
    },
    "accounts": [
      {
        "username": "admin",
        "passwordEnv": "XPU_MONITOR_ADMIN_PASSWORD",
        "role": "admin"
      },
      {
        "username": "boss",
        "passwordEnv": "XPU_MONITOR_BOSS_PASSWORD",
        "role": "admin"
      },
      {
        "username": "user",
        "passwordEnv": "XPU_MONITOR_USER_PASSWORD",
        "role": "admin"
      },
      {
        "username": "alice",
        "passwordEnv": "XPU_MONITOR_ALICE_PASSWORD",
        "team": { "id": "team-a", "label": "A 团队" }
      }
    ]
  }
}
```

不要提交账号密码、Token、Authorization 请求头或真实部署环境变量。会话和 Lock Bot 服务令牌只保存在进程内存中；重启服务会使现有应用会话失效。

## 生产部署

当前部署服务名为 `xpu-monitor`，代码目录为 `/root/monitor`。每次发布均应构建、重启、检查状态和日志；若更新了白名单密码或 Lock Bot 服务账号，使用 `--update-env` 重新注入环境变量并保存 PM2 进程列表。

```bash
cd /root/monitor/web
npm test
npm run build

cd /root/monitor
LOCKBOT_HOST='<lockbot-host>' \
LOCKBOT_PORT='<lockbot-port>' \
MONQUERY_HOST='<monquery-host>' \
MONQUERY_PORT='<monquery-port>' \
LOCKBOT_SERVICE_USERNAME='<service-user>' \
LOCKBOT_SERVICE_PASSWORD='<service-password>' \
XPU_MONITOR_ADMIN_PASSWORD='<admin-password>' \
XPU_MONITOR_BOSS_PASSWORD='<boss-password>' \
XPU_MONITOR_USER_PASSWORD='<user-password>' \
pm2 restart xpu-monitor --update-env
pm2 status
pm2 logs xpu-monitor --lines 50 --nostream
pm2 save
```

最小健康检查：

```bash
curl -i http://127.0.0.1:8900/team
curl -i -X POST http://127.0.0.1:8900/api/auth/login \
  -H 'content-type: application/json' \
  --data '{"username":"<whitelist-user>","password":"<password>"}'
```

预期团队页与白名单登录均返回 `200`。对受保护接口不带应用 Authorization 应返回 `401`；即使已登录，`/lockbot/api/auth/login` 也应返回 `403`。

## 贡献约定

JavaScript/Vue 使用两个空格缩进、分号和单引号。函数使用 camelCase，Vue 组件使用 PascalCase，多词文件使用 kebab-case。保持请求逻辑位于 API service、数据转换位于 adapter、页面渲染位于 view。更多协作规范见 [AGENTS.md](AGENTS.md)。
