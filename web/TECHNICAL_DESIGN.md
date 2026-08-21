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

集群视图当前的计算资源口径为 **94 个计算节点**，按每节点 8 张 XPU 计算，视图总资源为 **752 张卡**。node13、node80、node81、node85、node86 从北京时间 2026-08-06 00:00 起纳入历史分母，node53 从北京时间 2026-08-14 18:00 起纳入历史分母，node95 至 node114 从北京时间 2026-08-21 00:00 起纳入历史分母。Lock Bot 可能额外返回 bdc 节点，但它们没有 Monquery 数据，不参与节点使用率或锁定趋势。

| 节点类型 | 数量 | Monquery 利用率 | Lock Bot 锁定状态 | 在顶部“总节点/总卡数”统计中 |
| --- | ---: | --- | --- | --- |
| 计算节点 | 94 | 有 | 有 | 是 |
| bdc 节点 | 3 | 无 | 有 | 否 |
| 合计 | 94 | — | — | 是 |

共享范围配置当前包含 94 个计算节点。前端按该范围初始化 94 个节点，因此 Lock Bot 响应缺少节点时仍保留在资源分母中；bdc 节点不参与计算资源统计。节点上线后会提升到 `nodeIds` 与带 `effectiveFrom` 的 `nodeGroups`；日期值在中国时间零点生效，精确时间必须带 `+08:00`。

### 2.2 当前 Monquery 查询清单的实现边界

`api.js` 的当前负载查询使用 94 个 `node*` namespace，不包含 `bdc`。`trend-service.cjs` 对历史 XPU/显存趋势按 `nodeGroups.effectiveFrom` 切分请求窗口，只查询每个采样点已经生效的计算节点；两者均不决定 Lock Bot 资源总数。

当前范围为 94 节点，但历史趋势必须按采样时间使用对应的节点分母：

- **资源总览**：当前按 94 节点、752 卡统计。
- **锁定趋势**：按每个采样点已生效的节点集合计算分子和分母；当前为 94 节点、752 卡。
- **Monquery 趋势查询**：按每个采样点已生效的计算 namespace 聚合 XPU 与显存，不包含 bdc；当前为 94 个节点。

页面和文档不得用当前的 94 节点范围重算 2026-08-21 00:00（中国时间）之前的历史趋势。

其中 `node32`、`node34`、`node35`、`node37` 至 `node51`、`node53`、`node60` 至 `node81`、`node83` 至 `node86`、`node95` 至 `node114` 使用 `wxtky02-p800-8nic-vd` namespace，其他当前查询节点使用 `wxtky02-p800-backup-8nic-vd` namespace。

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

`ClusterDashboard.vue` 默认选择最近 24 小时，并在页面可见时每 60 秒刷新一次。一次加载并行执行三条链路：

1. **Lock Bot 当前状态**
   - 首次加载先取得当前用户可见的 Bot 列表。
   - 并发读取每个 Bot 的 `/state`。
   - 将状态适配为当前节点集合，用于顶部统计卡片。
2. **当前资源的完整 Monquery 数据**
   - 固定查询“当前时刻向前 3 小时”。
   - 请求整机 XPU、8 张卡的 XPU 及 8 张卡的显存，共 17 个指标。
   - 结果与 Lock Bot 当前状态一起适配为 `NodeData[]`，用于 BUSY 节点与 BUSY 卡统计。
3. **所选时间范围的集群趋势**
   - 调用 `GET /api/cluster-trend?start=<Unix 秒>&end=<Unix 秒>`。
   - 服务端按所选范围返回 XPU、显存和锁定率的自适应采样序列；浏览器再按显示范围平滑或降采样。

因此，顶部“当前资源”永远依据最近 3 小时内最新的已完成采样，而不是依据用户选择的历史趋势范围。选择 30 天或 90 天时，趋势图仍查询该历史范围，顶部 BUSY/LOCKED 统计仍独立查询当前数据。

### 3.3 Bot 合并

页面将所有成功响应的 Lock Bot `state` 规范化为当前的 94 个计算节点，并按卡合并，避免重复统计同一张卡。`bdc` 节点不会进入该计算资源集合。

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

趋势采样间隔按所选范围自适应；当前支持 60、120、240、300、360、480、1200、7200、21600 和 43200 秒。

| 消费链路 | 指标 |
| --- | --- |
| 当前资源统计 | `XPU_AVERAGE_UTILIZATION`、`XPU0_XPU_UTILIZATION` 至 `XPU7_XPU_UTILIZATION`、`XPU0_MEM_UTILIZATION` 至 `XPU7_MEM_UTILIZATION` |
| 服务端集群趋势 | `XPU_AVERAGE_UTILIZATION`、`XPU0_MEM_UTILIZATION` 至 `XPU7_MEM_UTILIZATION` |

趋势服务对每个采样点分别聚合：整机 XPU 指标按有效节点样本等权平均；显存指标按有效卡级样本等权平均。缺失样本保留为 `null`，不补 0。

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

页面渲染 5 个卡片：

1. 总节点
2. 总卡数
3. 节点使用率
4. XPU 平均利用率 / 峰值利用率
5. 显存平均利用率 / 峰值利用率

总节点和总卡数的计算为：

```text
总节点 = 94 个计算节点
总卡数 = 94 × 8 = 752
```

“节点使用率”卡片展示所选时间段内 Lock Bot 锁定率的平均值：

```text
节点使用率 = average(LockRate(t))，其中 t 为所选时间段内的有效趋势采样点
```

每个 `LockRate(t)` 均按该时刻已生效的节点数和每节点 8 卡计算；缺失或不完整的 Lock Bot 历史数据不参与平均，且卡片显示 `--`。它反映资源已分配规模，不是 XPU 计算利用率。

### 5.2 趋势图与交互

页面展示三张 Canvas 图：

| 图表 | 序列 | 说明 |
| --- | --- | --- |
| XPU 利用率趋势 | `xpu` | 所选范围的集群实际计算负载 |
| 显存利用率趋势 | `memory` | 所选范围的集群显存压力 |
| 节点利用率趋势 | `lock` | 所选范围的 Lock Bot 锁定率 |

支持最近 15 分钟至最近 90 天的快捷范围、自定义起止时间、复制区间、刷新、均值线开关、峰值及均值标注、悬停十字线与 Tooltip。默认范围为最近 24 小时。

点击刷新时，快捷范围会重新以当前采样粒度边界计算；自定义范围保持用户输入的时间边界不变。

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

浏览器先将趋势查询起止时间向下对齐到所选采样粒度边界。自定义时间输入由浏览器本地时区解析。

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
LockRate(t) = uniqueLockedCards(t) / (该采样时刻已生效节点数 × 8) × 100%
```

去重键为 `(规范化节点名, 卡号)`。有有效卡号的 `DEVICE` 记录只计一张卡；没有有效卡号的记录及节点级记录按 8 张卡展开。

bdc 锁定记录会在趋势计算时过滤；未在该采样时刻生效的计算节点也不会进入锁定率分子或分母。当前“节点使用率趋势”与顶部“节点使用率”均沿用这一按采样时刻变化的分母口径。

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

- [ ] Lock Bot 返回 94 个计算节点和 bdc 节点时，顶部总节点显示 94、总卡数显示 752。
- [ ] 默认最近 24 小时加载后，8 个统计卡片与三条趋势均可展示。
- [ ] LOCKED 与 BUSY 可独立变化；BUSY 优先遵循单卡 XPU 或显存 `>= 10%`。
- [ ] bdc 节点不参与计算资源统计，也不被解释为有 Monquery 实际负载。
- [ ] 刷新后“已刷新”更新；只有上游产生完整样本时“数据统计截止”前移。
- [ ] 自定义范围跨 UTC+08 零点时，历史缓存与当日实时数据能连续返回。
- [ ] 7、30、90 天范围首次可回填，后续优先命中 SQLite；缺失样本显示断线而非 0%。
- [ ] SQLite 不含 JWT、密码、用户名、用户 ID 或原始 Lock Bot 响应。
