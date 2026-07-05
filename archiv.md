# DeviceBot 逐卡容器名 & 渲染修正 — 存档

> 项目：`/home/users/liujie63/lock_bot`（GPU lock bot，如流/InfoFlow IM）
> 涉及机器人：DeviceBot（逐卡锁定）。**硬约束：NODE/QUEUE 机器人行为字节级不变。**

---

## 背景

DEVICE 机器人 `/query`（纯 AT 全集群查询）输出 7 列表格：
`IP | lock同学 | 节点状态 | 卡状态 | 剩余时间 | XPU%/MEM% | 容器名`

原问题：容器名列对整节点 8 张卡只显示**一个节点级容器名**（远程脚本只取全节点显存最大进程的容器，再复制到所有卡）。后续又对节点状态徽标、共享锁、空闲组的渲染提出修正。

---

## Phase A：真逐卡容器采集（采集层）

**文件：`python/lockbot/core/xpu_collector.py`**

- 远程脚本 `_remote_probe_script()`：保留原节点级 `container` 段（NODE 依赖）不动；**追加**逐卡段，输出于独立 marker `__LOCKBOT_CARD_CONTAINER_BEGIN/END__`。
  - 每卡取**显存最大**进程的 PID（`awk` 按卡号分组比较 `$NF` 去 `MiB`）。
  - cgroup → `docker ps` 解析容器名；`seen_pids` 缓存按 distinct PID 复用 `docker ps`。
  - 仅当容器名非空才输出 `card cname`。
- `_split_remote_output` → 4-tuple `(smi, smi_m, container, card_map)`（向后兼容）。
- 新增 `_parse_card_containers(section)` → `dict[int,str]`（跳过空/畸形行，重复卡号后者胜）。
- `_collect_one`：`per_card[i].container` 填**该卡自身**映射容器；低于 `CONTAINER_MIN_MEM_PCT`（默认 0.02）的卡置空；**达阈值但无映射的卡留空**（不回退节点级 container，否则复活"所有卡共用一个容器"的 bug）。
- `NodeUsage.container`（节点级 max-mem PID）保持不变 → NODE 用它，行为不变。

**测试：`tests/core/test_xpu_collector.py`** — `_remote_output` helper 加 card 段；split 改 4-tuple 断言；新增 `_parse_card_containers` 用例；`test_collect_one_populates_per_card` 改为真逐卡（per_card[0]/[1] 可不同）；新增低阈值置空、同 PID 同容器、无映射留空各一例。

---

## Phase B：DEVICE 渲染四点修正（纯渲染层，采集层不动）

**文件：`python/lockbot/core/query_render.py`** — 仅改 `build_device_query` 及 DEVICE 专用 helper。
**绝不改** `_format_xpu_cells`、`_with_xpu`、`build_node_query`（NODE 共用）。

### 新增/改动的 DEVICE-only helper
- `_dev_range(dev_ids)`：`devN` 或 `devA-B`。
- `_max_mem_container(usage, dev_ids)`：取组内**显存最大卡**的容器，一行一个；组内全无容器返回 `""`（不借节点级，避免复活 bug）；仅当 per_card 整体缺失/越界才回退 `usage.container`。
- `_group_mem_category(usage, dev_ids, threshold, fallback)`：按组卡平均显存 → `_mem_category`；无 per_card/越界/无显存 → `fallback`（节点级 cat，含采集失败 "na"）。
- 删除旧的 `_per_card_containers`（`<br>` 多容器版本，已被推翻）。

### 四点修正（均已端到端实测）

| 场景 | 修正前 | 修正后 |
|---|---|---|
| **场景3** 两人各锁半节点 | 节点状态徽标仅首行 | **两行都显示**按各组显存判定的徽标 |
| **场景4** 部分锁定+空闲 | 整节点统一徽标；空容器空白 | **逐组判定**（锁定高显存→BUSY、空闲0%→FREE）；空容器→`--` |
| **场景6** 共享锁 dev0 多用户 | 仅首用户行显示卡/XPU/容器 | **每个用户行完整重复**（dev0/徽标/XPU/容器） |
| **场景2/5** 一人锁整节点多容器 | `<br>` 列出所有容器 | **只显示显存最大卡的容器**，一行一个 |

### `build_device_query` 渲染循环关键点
- 每行 `dev_cell = fields["dev"] or _dev_range(dev_ids)` — 共享锁非首用户补回 dev。
- 每行 `group_cat = _group_mem_category(...)` → `node_status_cell = _STATUS_BADGE[group_cat]`（逐行徽标）。
- uniform 分支：util/mem = `_format_xpu_cells(usage)[0]`；容器 = `_max_mem_container(usage, all_dev_ids)`。
- 非 uniform 分支：util/mem = `_group_xpu_cells(usage, dev_ids)[0]`；容器 = `_max_mem_container(usage, dev_ids)`。
- 空容器 → `--`，但 `group_cat=="na"`（采集失败）保持空白配 N/A util。

**测试：`tests/core/test_device_query_render.py`** — `test_uniform_node_shows_single_max_mem_container`（单 max-mem 容器、无 `<br>`）；`test_shared_lock_repeats_each_user`（u1/u2 完整重复）；`test_mixed_lockers_both_rows_show_badge`、`test_partial_lock_idle_shows_free_and_dashes`（场景3/4）；改写 `test_mixed_lockers_per_group_xpu` 两行都有徽标。

---

## 实测输出（场景3/4/6/2-5）

```
场景3:
| node1(10.0.0.1) | user_a（独占） | BUSY | dev0-3 | ... | 70.0%/75.0% | job_a |
|                 | user_b（独占） | BUSY | dev4-7 | ... | 30.0%/40.0% | job_b |

场景4:
| node1(10.0.0.1) | user_a（独占） | BUSY | dev0-1 | ... | 60.0%/65.0% | job_a |
|                 | UNLOCK        | FREE | dev2-7 | --  | 0.0%/0.0%   | --    |

场景6:
| node1(10.0.0.1) | u1（共享） | BUSY | dev0 | ... | 45.0%/55.0% | shared_ctr |
|                 | u2（共享） | BUSY | dev0 | ... | 45.0%/55.0% | shared_ctr |

场景2/5 (dev4-7 显存98 > dev0-3 显存85 → 取 ctrY):
| node1(10.0.0.1) | lisi（独占） | BUSY | dev0-7 | ... | 88.0%/92.0% | ctrY |
```

---

## 验证

```bash
cd /home/users/liujie63/lock_bot
PYTHONPATH=python python3 -m pytest -q                              # 415 passed
PYTHONPATH=python python3 -m pytest tests/core/test_node_query_render.py -q  # 5 passed (NODE 隔离基线)
PYTHONPATH=python python3 -m ruff check python/ tests/             # 改动文件 0 错误（仓库剩 14 个 E501/B905 均为既有）
PYTHONPATH=python python3 -m ruff format --check python/ tests/
```

- 全量 **415 passed**；`test_node_query_render.py` 全绿 → NODE/QUEUE 隔离成功。
- 改动文件 ruff check + format 干净。

## 改动文件清单
- `python/lockbot/core/xpu_collector.py`（Phase A，采集层）
- `python/lockbot/core/query_render.py`（Phase B，渲染层）
- `tests/core/test_xpu_collector.py`
- `tests/core/test_device_query_render.py`
- **未动**：`build_node_query`、`_format_xpu_cells`、`_with_xpu`、`device_usage_utils.py`、i18n 表头、`NodeUsage`/`CardUsage` 结构。
