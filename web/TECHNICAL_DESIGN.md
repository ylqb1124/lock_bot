# Vue 集群视图技术方案

## 1. 范围

本文只描述 Vue 集群视图的实际实现，不覆盖项目根目录的历史静态页面。

| 范围 | 对应实现 |
| --- | --- |
| Vue 应用入口与登录会话 | `web/src/main.js`、`web/src/App.vue` |
| 集群视图 | `web/src/views/ClusterDashboard.vue` |
| 浏览器数据访问与适配 | `web/src/services/api.js`、`web/src/services/adapter.js` |
| 同源代理、趋势服务与缓存 | `web/server/proxy.cjs`、`web/server/trend-service.cjs`、`web/server/trend-store.cjs` |

该视图是**全集群汇总与趋势视图**：页面提供统计卡片、时间范围筛选及三张趋势图；当前没有节点列表、节点筛选/展开或节点占用时间条的 Vue UI。

## 2. 集群资源口径

### 2.1 集群视图总资源

生产集群视图的业务口径为 **49 个节点 = 46 个计算节点 + 3 个 bdc 节点**，按每节点 8 张 XPU 计算，视图总资源为 **392 张卡**。

| 节点类型 | 数量 | Monquery 利用率 | Lock Bot 锁定状态 | 在顶部“总节点/总卡数”统计中 |
| --- | ---: | --- | --- | --- |
| 计算节点 | 46 | 有 | 有 | 是 |
| bdc 节点 | 3 | 无 | 有 | 是 |
| 合计 | 49 | — | — | 是 |

顶部统计并没有在前端硬编码 `49`。它以当前用户可见的 Lock Bot `state` 响应适配出的 `currentNodes.length` 为准，因此只有 Lock Bot 返回 46 个计算节点和 3 个 bdc 节点时，页面才显示 49 个节点、392 张卡。bdc 节点没有 Monquery 数据，不能被解释为 XPU 或显存实际负载。

### 2.2 当前 Monquery 查询清单的实现边界

当前 `api.js` 和 `trend-service.cjs` 仍维护一个独立的 Monquery 节点清单：`node1` 至 `node51`，排除 `node13`、`node14`、`node17`，即 **48 个 namespace / 384 张卡**。该清单仅服务于 Monquery 当前负载查询及趋势聚合，不决定顶部总节点数。

这意味着当前实现存在两个不能混用的分母：

- **资源总览**：来自 Lock Bot 当前可见节点，生产口径为 49 节点、392 卡。
- **Monquery 趋势查询**：固定查询 48 个计算 namespace，并不包含 bdc。

页面和文档不得把 Monquery 的 48 节点查询清单写成集群视图的总节点数。若后续要让 Monquery 计算节点集合也严格收敛为 46 个，必须同时更新浏览器和服务端各自维护的节点清单；仅修改本文不会改变数据范围。

其中 `node32`、`node34`、`node35`、`node37` 至 `node51` 使用 `wxtky02-p800-8nic-vd` namespace，其他当前查询节点使用 `wxtky02-p800-backup-8nic-vd` namespace。

### 2.3 三类指标

| 指标 | 数据源 | 含义 |
| --- | --- | --- |
| XPU 利用率 | Monquery | 实际计算负载 |
| 显存利用率 | Monquery | 实际显存占用压力 |
| 节点利用率 / 锁定率 | Lock Bot | 已通过 Lock Bot 分配的卡占比 |

锁定不等于繁忙：资源可被锁定但暂未运行计算，也可能存在实际负载而无对应的 Lock Bot 锁定。因此锁定率、XPU 利用率和显存利用率必须独立解读。

## 3. 架构与数据流

```text
浏览器（Vue SPA / ClusterDashboard）
  │
  ├─ /lockbot/* ───────────────┐
  ├─ /monquery/* ──────────────┼─ web/server/proxy.cjs ── Lock Bot / Monquery
  └─ /api/cluster-trend ───────┘              │
                                               └─ SQLite 趋势缓存
                                                  web/.devdata/xpu-monitor.sqlite
```

### 3.1 登录与会话

1. `App.vue` 调用 `POST /lockbot/api/auth/login` 获取 Bearer Token。
2. 浏览器将 Token、用户名及保存时间写入 `localStorage`，4 小时内可恢复会话。
3. Token 仅用于浏览器请求和服务端转发，不写入 SQLite。
4. 趋势请求返回 401 或 403 时，页面触发会话失效处理。

### 3.2 单次页面加载

`ClusterDashboard.vue` 默认选择最近 3 小时，并在页面可见时每 60 秒刷新一次。一次加载并行执行三条链路：

1. **Lock Bot 当前状态**
   - 首次加载先取得当前用户可见的 Bot 列表。
   - 并发读取每个 Bot 的 `/state`。
   - 将状态适配为当前节点集合，用于顶部统计卡片。
2. **当前资源的完整 Monquery 数据**
   - 固定查询“今日零点至当前时刻”。
   - 请求整机 XPU、8 张卡的 XPU 及 8 张卡的显存，共 17 个指标。
   - 结果与 Lock Bot 当前状态一起适配为 `NodeData[]`，用于 BUSY 节点与 BUSY 卡统计。
3. **所选时间范围的集群趋势**
   - 调用 `GET /api/cluster-trend?start=<Unix 秒>&end=<Unix 秒>`。
   - 服务端返回 XPU、显存和锁定率的 5 分钟序列；浏览器再按显示范围平滑或降采样。

因此，顶部“当前资源”永远依据当天当前数据，而不是依据用户选择的历史趋势范围。选择 30 天或 90 天时，趋势图仍查询该历史范围，顶部 BUSY/LOCKED 统计仍查询今天至当前时刻。

### 3.3 Bot 合并

页面按 Bot 列表顺序合并 `state`：相同的**原始 Lock Bot 节点名**只保留首次出现的状态，避免重复统计同一个原始名称。之后适配层将 `gpu-node-01`、`node1` 等名称转换为统一节点名。

当前前端是在原始名称去重后才做规范化；因此不能将其描述为“按规范化名称完全去重”。服务端趋势计算则在规范化名称后按首次出现的状态处理。

## 4. 接口与数据适配

### 4.1 Lock Bot

| 接口 | 用途 |
| --- | --- |
| `POST /lockbot/api/auth/login` | 登录并获取 Token |
| `GET /lockbot/api/bots` | 获取当前用户可见的 Bot |
| `GET /lockbot/api/bots/{id}/state` | 获取当前节点或单卡锁定状态 |
| `GET /lockbot/api/bots/{id}/occupancy?date=YYYY-MM-DD` | 获取指定日期历史占用，用于锁定率趋势 |

Lock Bot 类型的卡数展开规则：

- `DEVICE`：有效 `dev_id` 仅代表指定的一张卡。
- `NODE`：节点级锁定按 8 张卡展开。
- `QUEUE`：当前没有独立的资源口径，按节点级兼容解析。

### 4.2 Monquery

Monquery 历史数据通过下列代理路径取得：

```text
GET /monquery/monquery/getHistoryitemdata
```

基础采样间隔为 300 秒。

| 消费链路 | 指标 |
| --- | --- |
| 当前资源统计 | `XPU_AVERAGE_UTILIZATION`、`XPU0_XPU_UTILIZATION` 至 `XPU7_XPU_UTILIZATION`、`XPU0_MEM_UTILIZATION` 至 `XPU7_MEM_UTILIZATION` |
| 服务端集群趋势 | `XPU_AVERAGE_UTILIZATION`、`XPU0_MEM_UTILIZATION` 至 `XPU7_MEM_UTILIZATION` |

趋势服务对每个 5 分钟桶分别聚合：整机 XPU 指标按有效节点样本等权平均；显存指标按有效卡级样本等权平均。缺失样本保留为 `null`，不补 0。

### 4.3 集群趋势接口

```text
GET /api/cluster-trend?start=<Unix 秒>&end=<Unix 秒>
Authorization: Bearer <Lock Bot Token>
```

请求约束：

- `start`、`end` 为整数 Unix 秒，且 `start <= end`。
- 最大查询跨度为 90 天。
- 浏览器端请求超时为 180 秒；趋势服务请求 Monquery 的超时为 90 秒。

响应字段：

| 字段 | 含义 |
| --- | --- |
| `times` | 5 分钟时间桶的 Unix 秒时间戳 |
| `xpu` | 对应桶的集群 XPU 平均利用率；无数据为 `null` |
| `memory` | 对应桶的集群显存平均利用率；无数据为 `null` |
| `lock` | 对应桶的锁定率；无授权或无数据为 `null` |
| `dataAsOf` | 最后一个有效 Monquery 样本时间 |
| `cache` | 当前查询的缓存诊断信息 |

## 5. 视图行为

### 5.1 顶部统计卡片

页面渲染 8 个卡片：

1. 总节点
2. 总卡数
3. LOCKED 节点
4. BUSY 节点
5. BUSY 卡数
6. 节点利用率
7. XPU 平均利用率 / 峰值利用率
8. 显存平均利用率 / 峰值利用率

总节点和总卡数的计算为：

```text
总节点 = 当前 Lock Bot 状态适配出的节点数
总卡数 = 总节点 × 8
```

在生产集群返回 46 个计算节点和 3 个 bdc 节点时，上述结果为 49 和 392。

`LOCKED` 表示存在活跃 Lock Bot 锁定。`BUSY` 的优先判定依据是最近一个已完成 5 分钟槽的卡级指标：

```text
单卡 BUSY = 单卡 XPU 利用率 >= 10%
        或 单卡显存利用率 >= 10%
节点 BUSY = 至少一张卡 BUSY
节点 PARTIAL = 1~7 张卡 BUSY
节点 FREE = 0 张卡 BUSY
```

当卡级数据尚不可用但整机 XPU 可用时，节点以整机 XPU `>= 10%` 判断；没有 Monquery 数据的 bdc 节点则以活跃锁定作为 BUSY 卡统计的兜底。后者不代表已经确认存在实际计算负载。

“节点利用率”卡片的实际含义是当前锁定卡占当前 Lock Bot 节点总卡数的比例：

```text
节点利用率 = LOCKED 卡数 / (当前节点数 × 8) × 100%
```

它反映资源已分配规模，不是 XPU 计算利用率。

### 5.2 趋势图与交互

页面展示三张 Canvas 图：

| 图表 | 序列 | 说明 |
| --- | --- | --- |
| XPU 利用率趋势 | `xpu` | 所选范围的集群实际计算负载 |
| 显存利用率趋势 | `memory` | 所选范围的集群显存压力 |
| 节点利用率趋势 | `lock` | 所选范围的 Lock Bot 锁定率 |

支持最近 15 分钟至最近 90 天的快捷范围、自定义起止时间、复制区间、刷新、均值线开关、峰值及均值标注、悬停十字线与 Tooltip。默认范围为最近 3 小时。

点击刷新时，快捷范围会重新以当前最近 5 分钟边界计算；自定义范围保持用户输入的时间边界不变。

页面同时显示：

- **已刷新**：浏览器本次请求完成时间。
- **数据统计截止**：响应中最后一个有效 Monquery 样本时间。

两者不同是正常现象：刷新不能要求 Monquery 立即产生新的完整采样。

## 6. 时间模型、平滑与缺失值

### 6.1 5 分钟桶

```text
STEP = 300 秒
一天 = 288 个 5 分钟槽
最近已完成槽 = max(0, 当前槽 - 1)
```

当前资源统计刻意避开仍可能未完成上报的当前槽。例如当前时间为 10:07，优先使用 10:00 至 10:04 的已完成槽。

浏览器先将趋势查询起止时间向下对齐到 5 分钟边界。自定义时间输入由浏览器本地时区解析。

### 6.2 服务端自然日与缓存

趋势服务以固定 UTC+08:00 切分 Lock Bot 历史 occupancy 的自然日，并将零点前的趋势作为历史数据走 SQLite 缓存，当天部分优先实时请求 Monquery。

Monquery 请求时间字符串当前由 Node 进程的本地 `Date` 字段格式化。因此部署机应使用中国标准时间；若部署到其他时区，UTC+08 日界与 Monquery 查询格式可能不一致，不能宣称现有实现完全不依赖服务器时区。

### 6.3 缺失、平滑和降采样

`null` 表示上游尚无完整样本、指标缺失、无 Lock Bot 授权或历史数据尚未成功回填。Canvas 遇到 `null` 会断线，绝不将其转换为 0%。

XPU 与显存的连续有效点使用两点移动平均：

```text
Smooth(t) = average(value(t - 1), value(t))
```

长范围只对绘图数据进行桶均值降采样：

| 查询跨度 | 每个显示点包含的原始点 | 显示粒度 |
| --- | ---: | --- |
| 不超过 2 天 | 1 | 5 分钟 |
| 2 至 7 天 | 3 | 15 分钟 |
| 7 至 30 天 | 24 | 2 小时 |
| 30 至 90 天 | 72 | 6 小时 |

原始查询范围、缓存粒度和统计数据不因显示降采样而改变。

## 7. 锁定率趋势的当前实现

趋势锁定率由历史 occupancy 与当日仍在执行的 `state` 合并得到：

```text
LockRate(t) = uniqueLockedCards(t) / (48 × 8) × 100%
```

去重键为 `(规范化节点名, 卡号)`。有有效卡号的 `DEVICE` 记录只计一张卡；没有有效卡号的记录及节点级记录按 8 张卡展开。

这里的 **384 卡分母是当前服务端写死的 Monquery 节点清单长度**，与页面顶部生产口径的 49 节点 / 392 卡不同。此外，服务端目前会解析 bdc 名称并将其锁定记录加入分子，但不会将 bdc 加入 384 卡分母。

因此，“节点利用率趋势”当前是服务端既有实现的 Lock Bot 锁定趋势，不能直接当作严格的 49 节点资源分配比例；它也不能与顶部“节点利用率”卡片互换使用。若要将趋势图统一为 49 节点、392 卡口径，需要单独调整趋势服务的节点过滤及分母，本文不将该未完成改动描述为已实现。

## 8. SQLite 缓存与安全

缓存路径：

```text
web/.devdata/xpu-monitor.sqlite
```

`TrendStore` 自动创建目录、数据库和表，并启用 WAL。主要表如下：

| 表 | 保存内容 |
| --- | --- |
| `trend_samples` | 集群 XPU、显存聚合样本 |
| `trend_windows` | 已完整读取的历史 Monquery 窗口 |
| `lock_trend_days` | 某权限作用域在某自然日的锁定趋势元数据 |
| `lock_trend_samples` | 每个 5 分钟桶的锁定卡数 |

历史 Monquery 窗口缺失时按日回填，同一窗口的并发请求通过进程内 `inflight` 合并。当日 Monquery 优先实时请求；实时失败时可以使用已有缓存样本。历史 Lock Bot occupancy 也按自然日缓存，缺失日期以受控并发回填。

SQLite 不保存 JWT、密码、用户名、用户 ID、原始 occupancy 响应或原始 state 响应；仅保存趋势时间桶、聚合利用率、锁定卡数及 Bot 作用域哈希。

该缓存设计适用于单实例 Node 进程。多实例部署不能无协调地同时写同一个 SQLite 文件。

## 9. 运行与验收

服务依赖 Node 内置 `node:sqlite`，需要 Node 22.5 及以上，建议使用 Node 22.23.1。

```bash
cd web
npm ci
npm run build
npm start
```

服务端读取项目根目录 `config.json` 的监听地址、端口和 Lock Bot、Monquery 后端配置。若本机设置了 HTTP 代理，使用 `curl` 访问本地服务时应添加 `--noproxy '*'`。

验收项目：

- [ ] Lock Bot 返回 46 个计算节点和 3 个 bdc 节点时，顶部总节点显示 49、总卡数显示 392。
- [ ] 默认最近 3 小时加载后，8 个统计卡片与三条趋势均可展示。
- [ ] LOCKED 与 BUSY 可独立变化；BUSY 优先遵循单卡 XPU 或显存 `>= 10%`。
- [ ] bdc 节点只参与 Lock Bot 当前资源统计，不被解释为有 Monquery 实际负载。
- [ ] 刷新后“已刷新”更新；只有上游产生完整样本时“数据统计截止”前移。
- [ ] 自定义范围跨 UTC+08 零点时，历史缓存与当日实时数据能连续返回。
- [ ] 7、30、90 天范围首次可回填，后续优先命中 SQLite；缺失样本显示断线而非 0%。
- [ ] SQLite 不含 JWT、密码、用户名、用户 ID 或原始 Lock Bot 响应。
