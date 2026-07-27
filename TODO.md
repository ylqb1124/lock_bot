# TODO: cluster.html 趋势图仍显示暂无数据

## 已完成：`/app` 集群趋势按范围动态采样

`/app` 的集群趋势采样间隔已调整为：

| 快捷时间范围 | 目标采样间隔 |
| --- | --- |
| 最近 15 分钟至最近 6 小时 | 1 分钟 |
| 最近 12 小时 | 2 分钟 |
| 最近 24 小时 | 4 分钟 |
| 最近 2 天 | 8 分钟 |
| 最近 7 天 | 20 分钟 |
| 最近 30 天 | 2 小时 |
| 最近 90 天 | 6 小时 |
| 最近 6 个月 | 12 小时 |

已验证 Monquery 对最近 15 分钟、1 小时和 6 小时窗口在 `interval=60` 时均能返回连续的 1 分钟数据。`interval=15` 虽被接口接受，但实际仍返回 60 秒间隔，不能作为 15 秒采样使用。

当前实现直接请求 Monquery，已禁用趋势数据库读写与服务端缓存；前端范围选择、服务端查询和横轴刻度均按上表间隔对齐，且不再进行二次聚合。自定义范围仅支持分钟精度，最长为 6 个自然月。趋势与当前资源查询固定使用 56 个节点（`node1–node12`、`node18–node51`、`node60–node69`），不再在运行时与 Lock Bot 取交集。顶部 BUSY 卡片仍维持最近一个已完成 5 分钟槽的判定，不跟随本策略变化。

## 当前现象

- 页面：[cluster.html](cluster.html)
- 两个趋势图 `XPU利用率趋势`、`显存利用率趋势` 仍显示 `暂无数据`。
- 顶部筛选 UI 能切换，例如 `Last 12 hours`。
- 已确认代理能返回最新 `cluster.html`。

## 已做改动

1. `cluster.html` 基于 `index.html` 生产监控页改造，增加了 `value.html` 风格的时间筛选区域。
2. 去掉了不需要的 `全部 / 个人` 可见切换 UI。
3. 趋势图绘制逻辑已改成 timestamp-based compact series，不再按固定 288 日内槽位绘制。
4. `processMonqueryData()` 已增加响应兼容：
   - 直接数组：`[...]`
   - 小写包装：`{ data: [...] }`
   - 大写包装：`{ Data: [...] }`
   - 指标入口兼容 `Items/items`
5. `avgLoadAndRender()` 已加浏览器 console 诊断：
   - 日志名：`Cluster trend data summary`
   - 字段包括：`displayStart/displayEnd/queryStart/queryEnd/rawEntries/parsedTimes/xpuPoints/memPoints`
6. 快捷筛选时间已做 5 分钟对齐：
   - 新增 `floorToFiveMinute(date)`
   - 新增 `normalizeTrendQueryRange(start, end)`
   - `setQuickRange(minutes)` 现在使用最近 5 分钟整点作为结束时间
   - `avgLoadAndRender()` 请求 Monquery 前会用对齐后的 `queryStart/queryEnd`

## 已验证过的事实

1. 代理当前启动方式：
   - 工作目录：`/home/users/v_qiujie04/monitor`
   - 命令：`/home/users/v_qiujie04/.nvm/versions/node/v22.23.1/bin/node proxy.js`
   - 端口：`8900`
2. 本地 curl 验证页面能返回最新代码：
   - 包含 `floorToFiveMinute`
   - 包含 `normalizeTrendQueryRange`
   - 包含 `Cluster trend data summary`
3. 对齐后的截图时间窗有数据：
   - 查询：`20260710144500 -> 20260711024500`
   - 单节点返回：`xpu: 144`, `mem: 144`
   - 全量 `fetchMonqueryUtilization()` 返回：`entries: 48`, `times: 144`, `xpu: 144`, `mem: 144`
4. 因此后端数据和 Node 侧解析路径不是完全断的；浏览器运行时仍显示空，下一步应以浏览器实际请求/console 为准。

## 下一步重点排查

1. 打开浏览器 DevTools Console，看 `Cluster trend data summary` 实际输出：
   - 如果 `fetchOk: false`：看具体 fetch error。
   - 如果 `rawEntries: 0`：浏览器实际请求参数或登录/代理状态不同于 Node 诊断。
   - 如果 `rawEntries > 0` 但 `parsedTimes: 0`：浏览器拿到的 response shape 与当前 parser 仍不匹配。
   - 如果 `parsedTimes > 0` 但仍显示 `暂无数据`：问题在 `computeMA()` 到 `avgDrawChart()` 之间，重点查数组赋值和 canvas 绘制。
2. 在 Network 面板找到 `/monquery/monquery/getHistoryitemdata` 请求，确认：
   - `start/end` 是否是 5 分钟整点，例如秒数为 `00`
   - response 是否包含 `success: true`
   - response 的数据字段到底是 `data`、`Data` 还是其它
   - `Items.XPU_AVERAGE_UTILIZATION` 和 `Items.XPU0_MEM_UTILIZATION` 是否有点
3. 如果浏览器没有发趋势图请求，查：
   - `avgLoadAndRender()` 是否被调用
   - `initClusterRangeControls()` 是否在 auto-login 前执行
   - 快捷范围按钮是否被遮挡或事件没有触发
4. 如果浏览器请求返回 401/403/502：
   - 不要继续改画图逻辑
   - 先查代理和内网 API 连通性
   - `curl` 验证必须带 `--noproxy '*'`
5. 如果浏览器请求返回数据但图仍空：
   - 临时在页面上显示 `avgTodayTimes.length / avgTodayXpuMA.length / avgTodayMemMA.length`
   - 检查 `avgDrawAllCharts()` 是否被调用
   - 检查 `avgDrawChart()` 的入参是否为非空数组

## 注意事项

1. 不要改坏 [index.html](index.html) 的生产数据链路。
2. `loadAllData()`、`adaptAndRender()`、顶部统计卡片路径目前不要大改，问题集中在 `cluster.html` 趋势图路径。
3. `api.js` 的 `fetchMonqueryItems()` 已经会返回 `data.data || []`，除非浏览器 Network 证明不是这个形态，否则优先不要动共享 API。
4. `cluster.html` 是未跟踪新文件；当前工作区还存在历史状态：
   - `D average.html`
   - `M value.html`
   这些不是本次趋势图排查产生的，不要随手 revert。
5. 修改 served 文件后需要重启代理。推荐流程：
   - `pkill -f "[p]roxy[.]js" 2>/dev/null; sleep 1`
   - 后台启动：`exec /home/users/v_qiujie04/.nvm/versions/node/v22.23.1/bin/node proxy.js`
   - 验证：`curl -s --noproxy '*' http://localhost:8900/cluster.html | grep -n 'Cluster trend data summary'`
6. 后台任务出现 `exit code 144` 通常是旧代理被后续 `pkill` 停掉，不代表最新代理启动失败。以当前 `ps aux | grep "[n]ode.*proxy[.]js"` 和 `ss -tln | grep 8900` 为准。
