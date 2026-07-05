# QueueBot 排队机器人专题报告

> 面向 lockbot 项目中 QUEUE 类型机器人的逻辑梳理、与 NODE 的关系、演进方案与体验问题。
> 代码基线：[python/lockbot/core/queue_bot.py](python/lockbot/core/queue_bot.py)、[node_bot.py](python/lockbot/core/node_bot.py)。

---

## 1. 目前的 Queue 逻辑

### 1.1 定位

QueueBot 在"整节点独占锁"的基础上，叠加了一套**预约排队 + 自动叫号**机制。它不真正控制机器访问权限，只是一个**社交约定层**——谁在用、谁在排、轮到谁了，靠通知和大家自觉遵守。

QUEUE 只使用两种节点状态：`idle`（空闲）和 `exclusive`（独占）。它**不支持共享锁**（`slock` 被显式禁用，[queue_bot.py:128-129](python/lockbot/core/queue_bot.py#L128-L129)）。

### 1.2 数据结构

每个节点在状态里的结构（[io.py:189-191](python/lockbot/core/io.py#L189-L191)）：

```python
{
    "status": "idle" | "exclusive",
    "current_users": [...],   # 当前占用者，QUEUE 下最多 1 人
    "booking_list": [...],    # 排队队列，有序，booking_list[0] 为队首
}
```

`booking_list` 是**有序列表**，队首优先。成员为 `{user_id, start_time, duration, is_notified}`。

### 1.3 五个核心命令

| 命令 | 作用 | 关键行为 |
|------|------|----------|
| **book** | 预约排队 | 追加到队尾；已在占用/队列中则拒绝 |
| **lock** | 锁定 | 仅"空闲且是队首(或队列空)"或"自己续锁"可成功 |
| **take** | 抢占 | 无视顺序强占，原占用者塞回队首 |
| **kicklock** | 清锁 | 清当前占用者，**保留队列** |
| **kickout**(继承) | 踢出 | 清占用者，**并清空整个队列** |

#### book（预约）— [queue_bot.py:131](python/lockbot/core/queue_bot.py#L131)

- 把用户 `append` 到队尾（[queue_bot.py:160-162](python/lockbot/core/queue_bot.py#L160-L162)）。
- 前置检查：若用户**已在 current_users 或已在 booking_list**，报错，不能重复排队（[queue_bot.py:142-146](python/lockbot/core/queue_bot.py#L142-L146)）。
- 检查预约时长不超过 `MAX_LOCK_DURATION`。
- **注意**：即使节点当前空闲，book 也只是入队、不会立即锁定，须等 lock 或定时器叫号。

#### lock（锁定）— [queue_bot.py:38](python/lockbot/core/queue_bot.py#L38)

准入条件——每个节点必须满足下列之一（[queue_bot.py:50-59](python/lockbot/core/queue_bot.py#L50-L59)）：

- **条件 A**：节点 `idle` **且**（队列为空 **或** 自己是队首 `is_first_user`）
- **条件 B**：自己已是 current_user（续锁）

成功后（[queue_bot.py:94-118](python/lockbot/core/queue_bot.py#L94-L118)）：

- 把自己从 booking_list 移除，status→exclusive，current_users=[自己]。
- **时长规则**：命令未带时长但之前 book 过 → 沿用预约时长；否则用命令时长（[queue_bot.py:99-102](python/lockbot/core/queue_bot.py#L99-L102)）。
- 锁定时长 > 预约时长时，通知后面排队者"等待时间延长"（[queue_bot.py:104-106,121-122](python/lockbot/core/queue_bot.py#L104-L106)）。

#### take（抢占）— [queue_bot.py:169](python/lockbot/core/queue_bot.py#L169)

- 强行占用，自己成为唯一 current_user。
- **原占用者被降级**：剩余时间>0 时重置计时、`insert(0,...)` 塞回**队首**（[queue_bot.py:212-220](python/lockbot/core/queue_bot.py#L212-L220)）。
- 原占用者 + 队列所有人都收到通知（[queue_bot.py:221-223](python/lockbot/core/queue_bot.py#L221-L223)）。
- **无任何"必须是队首"的限制**——任何人任何时候都能抢。

#### kicklock（清锁）— [queue_bot.py:235](python/lockbot/core/queue_bot.py#L235)

- 只清当前占用者，status→idle，记录占用结束。
- **保留 booking_list**——清完靠定时器把队首叫上来。

### 1.4 定时器驱动的自动叫号 — `_check_and_notify` [queue_bot.py:311](python/lockbot/core/queue_bot.py#L311)

由 BotScheduler 周期调用，是排队"活起来"的引擎：

1. **释放过期占用**（同 NodeBot）：current_users 剩余≤0 的移除，节点变 idle。
2. **空闲节点叫号**（QUEUE 独有，[queue_bot.py:399-413](python/lockbot/core/queue_bot.py#L399-L413)）：
   - 队首**未被通知** → 通知"机器空了，快来 lock"，记 start_time 作为响应计时起点。
   - 队首**已通知但超时**（距通知 ≥ `TIME_TO_LOCK`，**硬编码 5 分钟**，[queue_bot.py:325](python/lockbot/core/queue_bot.py#L325)）→ **踢出队列**，叫下一位。
3. **算下次唤醒时间**：取所有活跃锁到期、队首响应超时的最小值；未通知的队列 1 秒后再查。

### 1.5 完整生命周期

```
book 节点(被占用中) → 入队尾
      │
   占用者到期/unlock/kicklock → 定时器释放，节点 idle
      │
   定时器发现 idle+有队列 → 通知队首"机器空了"(5分钟倒计时)
      │
   ┌──┴───────────┐
 5分钟内 lock    5分钟超时 → 踢出队列 → 叫下一位
   │
[成功占用]

（旁路）任何人 take → 占用者被踢回队首，抢占者上位
```

---

## 2. Queue 与 Node 机器人的关系 / 需要做出的修改

### 2.1 继承关系

```
BaseLockBot
  ├── DeviceBot   (独立，按单卡锁)
  └── NodeBot     (整节点锁)
        └── QueueBot  (继承 NodeBot，加 book/take/kicklock)
```

QueueBot **是 NodeBot 的子类**，天然复用 NodeBot 的：`parse_command`、`query`、`unlock`、`kickout`、`_current_usage` 的大部分结构、以及 `_node_ips` 等。

### 2.2 QueueBot 相对 NodeBot 的差异一览

| 维度 | NodeBot | QueueBot |
|------|---------|----------|
| 特有命令 | 无 | `book` / `take` / `kicklock` |
| 共享锁 `slock` | 支持 | **禁用** |
| `booking_list` | 有字段但几乎不用 | 核心，驱动排队 |
| `lock` 准入 | 空闲即可 | 空闲**且队首**才行 |
| `_check_and_notify` | 只做到期释放 | 额外做自动叫号/晋升 |
| `_current_usage` | 节点用量 | 节点用量 + 排队列表 |
| `/query` 采集 GPU | `_collect_xpu_on_query=True` | **本次已改为继承 True** |

### 2.3 已做的修改（本次）

**打开 QueueBot 的 xpu 查询能力**：删除了原先 `QueueBot._collect_xpu_on_query = False`，使其回退继承 NodeBot 的 `True`。现在 QueueBot 的 `/query` 与 NODE 一致——SSH 采集 GPU 显存/利用率，展示带 XPU 列的表格 + 基于显存的忙/闲徽章。对应测试已由"断言不采集"改为"验证采集"。

> 注意：`query` 走 `build_node_query`（受 `_collect_xpu_on_query` 控制，已复用）；而 lock/unlock 回复里附带的用量走 QueueBot 自己的 `_current_usage`（含排队列表，本就不显示 GPU）。两条渲染路径独立。

### 2.4 与如流输出的关系

- **"怎么发"统一**：三个机器人都不直接和如流通信，都经 `self.adapter`（唯一实现 `InfoflowAdapter`）的 `build_reply` → `send`，共用同一个如流 webhook 接口。`markdown=True` 时用 MD body 渲染表格。
- **"发什么"独立**：每个机器人有各自的查询渲染（DEVICE 用 `build_device_query`，NODE/QUEUE 用 `build_node_query`）和用量渲染。

---

## 3. 未来的方案

以下为待决策的演进方向（尚未实施），按对**日常高频体验**的影响排序。

### 方案一：禁止 / 有条件禁止续锁（对应问题 A）

**动机**：占用者临到期反复续锁，会永久挡住后面排队的人。

- **选项 A（一刀切）**：`lock` 时若已是 current_user 直接拒绝。彻底，但没人排队时也不能延时，偏硬。
- **选项 B（有条件，推荐）**：仅当 `booking_list` 为空时允许续锁；一旦有人排队则禁止。精准命中痛点，不误伤"无人等待时延时"。

### 方案二：自动晋升（对应问题 B：排到了还要手动 lock）

**动机**：当前定时器只"通知队首快来 lock"，用户还得手动操作，5 分钟不发就丢名额。

**方向**：定时器发现节点空闲且有队列时，**直接把队首锁定**（用其预约时长，从队列移除），而非发通知等其自行 lock。配套：预约时长直接生效；多机同时空出时的处理需产品决策（是否一次性全给）。

### 方案三：收敛 take（对应问题 C：任意插队）

**背景**：`take` 是当前唯一能绕过排队顺序的技术口子。但结合团队实际——**大家都是同事，take/kickout/kicklock 极少使用，且用了会触发通知、双方会私聊沟通**，这类"强制类"命令更多是"社交威慑"而非日常操作。

**结论**：若团队文化如此，take 可作为**带通知的应急接管通道保留**，本方案**优先级下调**。仅当希望把排队变成"硬规则"时才需要收紧（移除 take / 限制只有队首可 take / 给占用者加保护期）。

### 方案四：超时策略优化（对应问题 4）

- `TIME_TO_LOCK` 5 分钟**改为可配置**。
- 队首超时未响应时**挪到队尾**而非直接踢出（需重新 book 太苛刻）。

### 方案五：语义与细节修正

- 统一 `kickout` / `kicklock` 对队列的处理（一个清空、一个保留，易混淆）。
- `book` 空闲且无队列的节点时，直接锁定而非绕一圈入队。
- 多机 `lock` 失败时，错误信息带上**具体卡住的节点名**。

**建议实施顺序**：方案二（自动晋升）→ 方案一（禁续锁，选 B）→ 方案四（超时优化）→ 方案五（细节）。方案三视团队使用频率再定。

---

## 4. 观察到的问题（体验视角）

从不同使用者角色走查排队全流程，发现以下会实际影响体验的问题：

### 强制类命令（据团队反馈，实际极少使用，优先级低）

- **P1 · take 无门槛**：任何人任何时候都能强抢，技术上是排队顺序的唯一绕过口。但实际靠"通知 + 私聊沟通"的社交约束运作，日常几乎不触发。
- **P2 · kickout 与 kicklock 语义不一致**：`kickout` 清空整个队列，`kicklock` 保留队列。名字相近、对队列存亡相反，易误伤排队者。

### 日常高频路径问题（真正影响体验）

- **P3 · 排到队首仍需手动 lock**：多一步操作，且有 5 分钟丢名额风险。（→ 方案二）
- **P4 · 续锁挡队列**：占用者可反复续锁把排队者挡在外面。（→ 方案一）
- **P5 · 5 分钟窗口硬编码 + 超时直接踢出**：半夜机器空出→通知→5 分钟没醒→名额没了，还得重排。（→ 方案四）
- **P6 · book 空机不立即可用**：在完全空闲、无队列的机器上 book，仍要等定时器叫号再手动 lock，反直觉。（→ 方案五）
- **P7 · 多机 lock 报错不指明节点**：`lock n1,n2` 全有或全无，失败时不说哪台卡住，难排查。（→ 方案五）

### 边界 / 健壮性问题

- **P8 · 通知发送失败=名额静默丢失**：叫号时先落库 `is_notified/start_time` 再发消息，发送异常仅记日志，倒计时照走，队首没收到却被踢。（做了自动晋升后可缓解）
- **P9 · 占用者临到期无感知**：`EARLY_NOTIFY=False` 时到期前无提醒，任务可能正在跑就被释放。排队场景建议默认开启提醒。
- **P10 · 占用者无法预约自己的连续使用**：book 会拒绝当前占用者。叠加"禁止续锁"后，长期连续使用者无合法延续路径（方案一选 B 可部分缓解）。
- **P11 · 等待时间估算不准**：`_booking_text` 按各人请求时长累加估算等待，实际受 take / 提前释放影响，可能偏差很大。

---

## 附：关键代码位置索引

| 功能 | 位置 |
|------|------|
| book | [queue_bot.py:131](python/lockbot/core/queue_bot.py#L131) |
| lock（准入条件） | [queue_bot.py:38](python/lockbot/core/queue_bot.py#L38) |
| take | [queue_bot.py:169](python/lockbot/core/queue_bot.py#L169) |
| kicklock | [queue_bot.py:235](python/lockbot/core/queue_bot.py#L235) |
| kickout（继承） | [node_bot.py:311](python/lockbot/core/node_bot.py#L311) |
| 自动叫号 `_check_and_notify` | [queue_bot.py:311](python/lockbot/core/queue_bot.py#L311) |
| `TIME_TO_LOCK` 硬编码 | [queue_bot.py:325](python/lockbot/core/queue_bot.py#L325) |
| 排队列表渲染 `_current_usage` | [queue_bot.py:474](python/lockbot/core/queue_bot.py#L474) |


