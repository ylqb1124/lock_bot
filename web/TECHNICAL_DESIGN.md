# 集群监控技术方案

## 1. 文档目的与适用范围

本文说明当前集群监控 **Vue 版**的架构、数据链路、指标口径、时间模型、缓存策略与部署约束，供研发评审、故障定位和后续迭代使用。

适用实现：

- 前端：`web/src/`
- 服务端：`web/server/`
- 构建产物：`web/dist/`
- 运行配置：项目根目录 `config.json`
- 趋势缓存：`web/.devdata/xpu-monitor.sqlite`

根目录的 `index.html`、`average.html`、`proxy.js` 等为历史静态页面实现。本文不以其行为作为 Vue 版的设计依据。

## 2. 监控目标与核心概念

### 2.1 资源范围

Monquery 监控 48 个计算节点，每节点 8 张 XPU，共 384 张卡：

```text
node1 ~ node51，排除 node13、node14、node17
```

其中 node32、node34、node35、node37~node51 使用 `wxtky02-p800-8nic-vd` namespace，其余节点使用 `wxtky02-p800-backup-8nic-vd` namespace。

Lock Bot 还可能返回 bdc 节点。bdc 节点可显示锁定状态，但没有对应的 Monquery 利用率数据，不计入 Monquery 集群趋势和实际负载指标。

### 2.2 三类不能混淆的数据

| 维度 | 数据源 | 含义 | 典型用途 |
| --- | --- | --- | --- |
| 实际计算负载 | Monquery | XPU、显存的实际使用水平 | 判断资源是否真正被计算任务消耗 |
| 资源锁定 | Lock Bot | 用户或任务已经占用、预留的节点或卡 | 判断资源分配规模、排期与可用性 |
| 图表展示聚合 | 前端 | 对原始采样点做平滑或降采样后的展示结果 | 保证长时间范围图表可读 |

**锁定不等于繁忙。** 一张卡可能已经被 Lock Bot 锁定但暂时没有计算负载；也可能存在未通过 Lock Bot 锁定但 Monquery 负载达到阈值的资源。因此，锁定率与 XPU 利用率必须作为两个独立指标解读。

## 3. 总体架构

```text
                    +---------------------+
                    | 浏览器：Vue SPA     |
                    | ClusterDashboard    |
                    +----------+----------+
                               |
             静态页面、/lockbot、/monquery、/api/cluster-trend
                               |
                    +----------v----------+
                    | web/server/proxy.cjs|
                    | Node.js 22          |
                    +----+-----------+----+
                         |           |
               +---------v--+     +--v----------------+
               | Lock Bot   |     | Monquery          |
               | 实时状态、 |     | 5 分钟利用率采样  |
               | 历史占用   |     +-------------------+
               +------------+
                         |
                    +----v------------------------+
                    | SQLite                       |
                    | web/.devdata/                |
                    | xpu-monitor.sqlite           |
                    +-----------------------------+
```

服务端职责分界：

| 模块 | 职责 |
| --- | --- |
| `web/src/App.vue` | 登录、JWT 会话恢复、鉴权失效处理 |
| `web/src/views/ClusterDashboard.vue` | 查询范围、当前状态聚合、统计卡片、Canvas 图表、交互 |
| `web/src/services/api.js` | 浏览器 API 客户端、请求超时、Monquery namespace 组装 |
| `web/src/services/adapter.js` | 将 Lock Bot/Monquery 响应适配为统一的 `NodeData` |
| `web/server/proxy.cjs` | 静态站点托管、后端转发、趋势接口路由、配置加载 |
| `web/server/trend-service.cjs` | 集群趋势查询、自然日切分、Monquery 聚合、Lock Bot 聚合 |
| `web/server/trend-store.cjs` | SQLite 建表、趋势样本及缓存窗口的读写 |

## 4. 数据源与接口契约

### 4.1 Lock Bot

浏览器使用 Lock Bot 账号登录，取得 Bearer Token。Token 与用户名保存在浏览器 `localStorage`，有效期为 4 小时；Token 仅在请求中转发，不写入 SQLite。

| 接口 | 用途 | 数据消费位置 |
| --- | --- | --- |
| `POST /lockbot/api/auth/login` | 登录并获取 Token | `App.vue` |
| `GET /lockbot/api/bots` | 获取当前用户可管理/可见的 Bot 集合 | Vue 与趋势服务 |
| `GET /lockbot/api/bots/{id}/state` | 当前节点、单卡锁定状态和当前用户 | Vue 当前资源卡片、当日活跃锁定补充 |
| `GET /lockbot/api/bots/{id}/occupancy?date=YYYY-MM-DD` | 指定自然日的历史占用记录 | 趋势服务的历史锁定率 |

Lock Bot Bot 类型处理：

- `NODE`：整机锁定。一个生效记录等价于该节点 8 张卡均锁定。
- `DEVICE`：单卡锁定。生效记录仅对应 `dev_id` 指定的一张卡。
- `QUEUE`：当前不作为独立资源口径处理，按其返回状态兼容解析。

同一规范化节点同时出现在多个 Bot 时，适配层按 Bot 列表顺序先到先得，避免同一资源重复参与当前状态展示。

### 4.2 Monquery

Monquery 的历史接口为：

```text
GET /monquery/monquery/getHistoryitemdata
```

请求粒度为 300 秒。每个查询包含：

```text
XPU_AVERAGE_UTILIZATION
XPU0_MEM_UTILIZATION ... XPU7_MEM_UTILIZATION
```

集群趋势服务只需要整机 XPU 平均利用率和 8 张卡的显存利用率；节点列表适配还会请求单卡 XPU 指标以判断单卡状态。

### 4.3 集群趋势接口

Vue 图表通过下列受同源保护的接口取得趋势：

```text
GET /api/cluster-trend?start=<Unix 秒>&end=<Unix 秒>
Authorization: Bearer <Lock Bot Token>
```

约束：

- `start`、`end` 为 Unix 时间戳，单位秒。
- 必须是整数，且 `start <= end`。
- 单次范围最大 90 天。
- 浏览器侧超时为 180 秒；上游 Monquery 请求超时为 90 秒。

主要响应字段：

| 字段 | 说明 |
| --- | --- |
| `times` | 对齐到 5 分钟的 Unix 秒时间桶 |
| `xpu` | 对应桶的集群 XPU 平均利用率；无数据为 `null` |
| `memory` | 对应桶的集群显存平均利用率；无数据为 `null` |
| `lock` | 对应桶的锁定率；无权限或无数据为 `null` |
| `dataAsOf` | 本次趋势中最后一个实际存在的 Monquery 样本时间 |
| `cache` | 历史回填、当日实时读取等缓存诊断信息 |

## 5. 时间模型与查询范围

### 5.1 5 分钟时间桶

系统的基础采样单位是 5 分钟：

```text
STEP = 300 秒
一天 = 24 × 60 / 5 = 288 个槽
```

北京时间第 `i` 个槽对应：

```text
slot = hour × 12 + floor(minute / 5)
```

节点当前状态不使用尚未闭合的实时槽，而使用最近一个已完成槽：

```text
effectiveSlot = max(0, currentSlot - 1)
```

例如当前时间为 10:07，则优先使用 10:00~10:04 的完整采样，而不是可能尚未完整上报的 10:05 槽。

### 5.2 查询范围规范化

前端对起止时间向下对齐到 5 分钟边界，再向服务端传递 Unix 秒。自定义范围保留用户选择的起止边界；快速范围则以当前时间重新计算结束时间。

因此 Refresh 的行为分为两种：

| 范围类型 | 点击 Refresh 后的查询范围 |
| --- | --- |
| 快速范围，例如 Last 3 hours | 结束时间更新到当前最近 5 分钟边界，窗口整体向前滚动 |
| 自定义范围 | 保持用户指定的起止时间不变，重新读取该范围 |

### 5.3 CST 自然日切分

趋势服务以固定 `UTC+08:00` 计算自然日边界，而不是依赖服务器本地时区：

```text
CST 午夜 = 北京时间 00:00:00
历史段 = [查询开始, 当前 CST 午夜之前]
当日段 = [当前 CST 午夜, 查询结束]
```

处理规则：

1. 查询仅落在历史日期：从 SQLite 返回缓存样本；缓存有缺口时再回填 Monquery。
2. 查询跨越今日零点：零点以前走历史缓存，零点及以后实时请求 Monquery。
3. 查询仅落在今日：全部实时请求 Monquery，并更新本地缓存用于失败回退。

例如查询 `2026-07-13 15:25:00` 至 `2026-07-14 00:00:01` 时，前一日 15:25~23:55 读取或回填历史缓存，`00:00` 开始属于当日实时段。该边界不会遗漏或重复一整个 5 分钟桶。

### 5.4 “已刷新”与“数据统计截止”

页面必须区分两个时间：

- **已刷新 HH:mm**：浏览器本次请求已经成功完成的时间。
- **数据统计截止 HH:mm**：本次返回数据中 Monquery 最后一个有效 5 分钟样本的时间。

Refresh 不会命令 Monquery 立即采集数据。若页面在 02:07 刷新，而上游最新完整样本仍为 02:00，则界面会显示“已刷新 02:07”与“数据统计截止 02:00”。这是上游采样/入库延迟，而不是刷新失败。

## 6. 指标定义与计算口径

### 6.1 当前资源统计卡片

| 指标 | 公式/判定 | 数据源与边界 |
| --- | --- | --- |
| 总节点 | `currentNodes.length` | 当前可见 Lock Bot 状态归一化后的节点集合；可能包含 bdc 节点 |
| 总卡数 | `总节点 × 8` | 每节点固定 8 张卡 |
| LOCKED 节点 | 节点至少一张卡存在有效 Lock Bot 锁定 | Lock Bot `state`；表示资源已分配，不表示一定有计算负载 |
| LOCKED 卡数 | 所有 `cardHasActiveLock[card] = true` 的卡数之和 | `DEVICE` 按卡计算，`NODE` 按整机 8 卡计算 |
| 节点利用率 | `LOCKED 卡数 / 总卡数 × 100%` | 表示资源分配比例，不是 XPU 计算利用率 |
| BUSY 节点 | 节点实际负载达到阈值 | 使用最近已完成 5 分钟槽，详见下文 |
| BUSY 卡数 | 单卡实际负载达到阈值的卡数 | 使用最近已完成 5 分钟槽，详见下文 |

BUSY 的阈值为 `10%`：

```text
单卡 BUSY = 单卡 XPU 利用率 >= 10%
          或 单卡显存利用率 >= 10%

节点 BUSY = 至少一张卡 BUSY
节点 PARTIAL = 1~7 张卡 BUSY
节点 FREE = 0 张卡 BUSY
```

若节点只有整机级 XPU 指标而没有有效单卡指标，适配层使用：

```text
节点 BUSY = 整机 XPU 平均利用率 >= 10%
```

对于没有 Monquery 数据的 bdc 节点，当前实现无法按实际负载判断，顶部 BUSY 统计和节点状态会以 `hasActiveLock` 作为兼容兜底；利用率本身仍显示为 `--`。因此 bdc 的 BUSY 仅表示存在活跃锁定，不能解读为已确认的计算负载。

### 6.2 XPU 和显存趋势

每个原始时间桶分别计算：

```text
XPU(t) = sum(所有有效节点的 XPU_AVERAGE_UTILIZATION(t))
         / count(有效节点 XPU 样本)

Memory(t) = sum(所有有效节点、所有有效卡的 XPU{card}_MEM_UTILIZATION(t))
            / count(有效卡级显存样本)
```

显存趋势按**卡级样本等权**聚合，不是“先求节点均值，再按节点等权平均”。数据缺失时返回 `null`，绝不把缺失采样转换为 `0%`。

选定范围的统计卡片使用有限数值计算：

```text
平均值 = sum(所有有限趋势点) / count(所有有限趋势点)
峰值   = max(所有有限趋势点)
```

`null` 不参与平均和峰值。若范围内没有任何有限值，展示 `--`。

### 6.3 锁定率趋势

锁定率用于表达资源被 Lock Bot 分配的规模：

```text
LockRate(t) = uniqueLockedCards(t) / (48 × 8) × 100%
```

其中 `uniqueLockedCards(t)` 的去重键为：

```text
(规范化节点名, 卡号)
```

展开规则：

- `DEVICE` 记录的 `dev_id/device_id/card_id` 有效时，计入其对应的一张卡。
- 不包含有效卡号的记录，或 `NODE` 整机锁定，展开为该节点 8 张卡。
- 同一节点同一卡在一个时间桶内被多条记录命中，只计一次。
- 历史日期由 occupancy 记录覆盖的时间段计算；当日额外合并 Lock Bot `state` 中尚在进行的锁定状态。

分母固定使用 Monquery 监控的 48 个节点、384 张卡，使不同用户/不同 Lock Bot 可见范围的趋势可比较。Lock Bot 无授权或无法获得记录时，锁定率点为 `null`，不显示为 `0%`。

### 6.4 节点列表利用率与占用条

`NodeData` 将当天 Monquery 稀疏序列填入 288 个 CST 槽。若同一槽有多条样本，取平均；未上报的槽保留为空。

列表中的锁定红条来自 Lock Bot occupancy 历史，仅表示占用时段。它不参与 BUSY/FREE 判定。实际状态仍由 XPU 或显存利用率的 `10%` 阈值判定。

## 7. 缺失值、平滑与长时间范围展示

### 7.1 缺失值

`null` 的含义包括：

- 上游还没有生成该 5 分钟完整样本。
- Monquery 在该时间桶没有返回有效指标。
- 当前用户没有 Lock Bot 授权，无法计算锁定率。
- 历史数据尚未成功回填。

Canvas 遇到 `null` 会断开线段，不连接到 0，也不会把缺失解释为资源空闲。长期图的断线通常是数据可用性提示，而不是利用率下降。

### 7.2 轻量平滑

XPU 与显存曲线对连续有限值应用 2 点移动均值：

```text
Smooth(t) = average(value(t-1), value(t))
```

起点只使用自身；缺失点仍是 `null`。平滑只改善视觉抖动，不更改时间轴、查询范围或源数据采样间隔。

### 7.3 显示降采样

为避免 7 天以上范围把 5 分钟采样点压成密集竖线，前端只对**绘图数据**做桶均值聚合：

| 查询跨度 | 一个显示点包含的原始点 | 显示粒度 |
| --- | ---: | --- |
| 不超过 2 天 | 1 | 5 分钟 |
| 2~7 天 | 3 | 15 分钟 |
| 7~30 天 | 24 | 2 小时 |
| 30~90 天 | 72 | 6 小时 |

时间范围和 x 轴的实际起止时间不改变。一个显示桶内没有任何有效值时，该桶仍返回 `null`，从而保持断线语义。

## 8. SQLite 缓存与性能设计

### 8.1 位置与运行前提

数据库路径：

```text
web/.devdata/xpu-monitor.sqlite
```

启动时 `TrendStore` 会自动创建父目录、数据库和表，并启用 WAL：

```sql
PRAGMA journal_mode = WAL;
```

此设计假设一个部署实例对应一个 Node 进程/一个写入器。若改为多副本部署，必须引入共享缓存、主从写入策略或替换为集中式数据库；不应让多个实例无协调地写同一个 SQLite 文件。

### 8.2 表和缓存语义

| 表 | 主键 | 保存内容 | 目的 |
| --- | --- | --- | --- |
| `trend_samples` | `(cluster_key, sampled_at)` | 集群 XPU/显存聚合值 | 避免重复请求历史 Monquery |
| `trend_windows` | `(cluster_key, start_at, end_at)` | 已完整拉取的历史窗口 | 精确识别缓存缺口 |
| `lock_trend_days` | `(scope_key, day_start_at)` | 某权限作用域、某 CST 日的总卡数及抓取时间 | 判断历史锁定日是否已缓存 |
| `lock_trend_samples` | `(scope_key, sampled_at)` | 每 5 分钟桶的锁定卡数 | 供锁定率趋势快速读取 |

`cluster_key` 基于监控节点集和指标清单生成；`scope_key` 是当前用户可见 Bot 的 ID/类型集合哈希。该设计使权限不同的用户不会共享不应见的锁定聚合结果。

### 8.3 回填与实时策略

Monquery：

1. 服务先检查历史范围是否被 `trend_windows` 覆盖。
2. 对缺失窗口按自然日拆分回填，避免 30/90 天请求成为一个巨大上游查询。
3. 同一窗口的并发请求使用 `inflight` 去重，避免多个浏览器请求触发重复回填。
4. 当前 CST 日始终优先实时查询，成功后写回缓存；实时上游失败时可使用缓存中的已有样本回退。

Lock Bot：

1. 历史锁定趋势按 CST 自然日读取 `lock_trend_days`。
2. 缺失日期才调用该日的 occupancy 接口，并只落库脱敏后的“每 5 分钟锁定卡数”。
3. 当前日不视为不可变历史，重新读取 occupancy 和当前 state，以包含仍在进行的锁定。
4. 缺失日期使用受控并发回填，防止一次 90 天查询对 Lock Bot 造成瞬时过载。

### 8.4 数据安全

SQLite 中**不保存**下列数据：

- JWT、Authorization Header 或登录密码。
- 用户名、用户 ID、任务名称。
- 原始 occupancy 响应、原始 state 响应。

缓存仅保存时间桶、集群级 XPU/显存聚合值、锁定卡数量，以及不可逆的 Bot 集合作用域哈希。

## 9. 错误处理与可观测性

| 场景 | 行为 |
| --- | --- |
| 浏览器趋势请求超时 | 页面显示请求错误；不会把旧数据伪装成新数据 |
| Monquery 当前日实时请求失败 | 服务优先回退已缓存样本；没有缓存的桶为 `null` |
| 历史缓存缺口回填失败 | 当前请求返回错误或可用的已缓存部分，取决于错误发生阶段；需查看服务端日志 |
| Lock Bot 单个 state 请求失败 | 当前资源集合忽略该 Bot 的状态，不中断整个仪表盘 |
| Lock Bot 无授权 | 锁定率趋势为 `null`；Monquery 趋势仍可独立展示 |
| 最新槽未产出 | `dataAsOf` 停留在最近有效采样，曲线末端断开而非归零 |

关键排障入口：

```bash
pm2 logs monitor-cluster
curl --noproxy '*' -I http://127.0.0.1:<port>/
```

环境中若设置了公司 HTTP 代理，访问 `127.0.0.1` 时必须使用 `--noproxy '*'`，否则可能看到代理返回的 `502`，而不是本地服务的真实结果。

## 10. 部署与运维

### 10.1 运行环境

服务依赖 Node 内置 `node:sqlite`，要求 Node `22.5+`，生产建议使用 Node `22.23.1`。

原因：Node 18 不支持 `require('node:sqlite')`，会在启动时报：

```text
ERR_UNKNOWN_BUILTIN_MODULE
```

### 10.2 构建和启动

`web/package.json` 定义：

```bash
cd web
npm ci
npm run build
npm start
```

`npm start` 执行：

```text
node server/proxy.cjs
```

服务端读取项目根目录 `config.json` 中的：

```json
{
  "proxy": { "port": 8999, "bind": "0.0.0.0" },
  "backend": {
    "lockbot": { "host": "...", "port": 0 },
    "monquery": { "host": "...", "port": 0 }
  }
}
```

端口不硬编码在 `web/pm2.config.cjs` 中；修改 `config.json` 的 `proxy.port` 后，需要重启服务。

### 10.3 PM2

生产环境建议服务名为 `monitor-cluster`。当前仓库中的 `web/pm2.config.cjs` 默认名称仍为 `xpu-monitor`；若以 `monitor-cluster` 运行，可通过命令行覆盖名称，或将配置中的 `name` 同步修改为该名称。

```bash
cd /path/to/monitor/web
pm2 start pm2.config.cjs --name monitor-cluster --interpreter "$(which node)"
pm2 save
```

NVM 环境必须确保 PM2 使用 Node 22 的解释器。配置开机自启：

```bash
pm2 startup systemd -u root --hp /root
# 执行 PM2 输出的完整 PATH 命令
pm2 save
```

服务启动成功的日志特征：

```text
Loaded config.json
XPU monitor ready at http://localhost:<port>/
```

### 10.4 缓存维护

`web/.devdata/` 应放在持久化磁盘并纳入备份策略。删除数据库不会影响源数据或账号数据，但会导致随后访问 7/30/90 天图表时重新回填历史样本，首次查询明显变慢。

不建议在服务运行期间手工删除 SQLite 文件。若确需重建缓存：先停止 PM2 服务，备份或移走 `.devdata/`，再启动服务。

## 11. 已知边界与后续建议

1. 自定义时间选择由浏览器本地时区解析，而服务端历史边界固定使用 CST。面向非中国时区浏览器时，应改为显式 CST 时间选择器，避免用户输入的绝对时间偏移。
2. Monquery、Lock Bot 是独立系统，采样、入库和刷新节奏不同。不能要求某个时刻的锁定率与计算利用率严格一一对应。
3. Lock Bot 历史趋势以用户可见 Bot 集合作用域缓存。用户权限或 Bot 集合变化会生成新的缓存域，首次访问需要重新回填。
4. SQLite 适用于单实例轻量缓存。未来若需要多机高可用或跨机共享缓存，应评估集中式数据库或缓存服务。
5. `web/.devdata` 包含性能缓存，不是业务事实源。指标追溯和最终审计仍以 Monquery、Lock Bot 的上游数据为准。

## 12. 验收清单

- [ ] 默认打开 Last 3 hours 时，趋势曲线与当前资源统计均加载成功。
- [ ] Refresh 后“已刷新”更新；只有上游产生新完整样本时“数据统计截止”前移。
- [ ] 自定义范围跨 CST 零点时，零点前后均有正确趋势数据，不出现整段空白或重复桶。
- [ ] 7/30/90 天范围首次可回填，后续访问主要命中 SQLite，图表保持可读而不是密集竖线。
- [ ] 缺失上游样本显示断线，不显示成 0% 下跌。
- [ ] LOCKED 与 BUSY 指标可独立变化，BUSY 判断遵循 XPU/显存 `>= 10%`。
- [ ] SQLite 不含 JWT、密码、用户名、用户 ID 或原始 Lock Bot 占用记录。
- [ ] 使用 Node 22 启动，PM2 服务 `monitor-cluster` 为 `online`，并能在系统重启后恢复。
