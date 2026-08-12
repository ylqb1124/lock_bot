# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

> This environment exposes only `python3` on PATH (no `python`). Prefer module form when the console script is unavailable: `python3 -m pytest`, `python3 -m ruff`, `python3 tools/gen_keys.py`.

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run all tests
pytest

# Run a single test file
pytest tests/core/test_device_bot.py

# Run a single test function
pytest tests/core/test_device_bot.py::test_lock_device -xvs

# Lint + format check
ruff check python/ tests/
ruff format --check python/ tests/

# Auto-fix lint issues
ruff check --fix python/ tests/
ruff format python/ tests/

# Run backend dev server
uvicorn lockbot.backend.app.main:app --host 0.0.0.0 --port 8000 --reload

# Run frontend dev server
cd frontend && npm install && npm run dev

# Docker build
docker build -f docker/Dockerfile -t lockbot .

# Generate encryption keys for deployment
python tools/gen_keys.py
```

## Local tmux deployment (restart after code changes)

The running instance lives in a tmux session named `lockbot`, where `uvicorn` (port **8875**, no `--reload`) is the session's **only foreground process**. Code changes require a manual restart.

> **Gotcha:** `tmux send-keys -t lockbot C-c` kills uvicorn, and since it's the session's only process, the **session (and tmux server) dies with it**. Don't rely on Ctrl-C to leave a usable prompt behind. The reliable flow is kill-and-recreate.

```bash
# 1. Discover the exact startup command + env vars currently in use
ps aux | grep '[u]vicorn'

# 2. Kill the old session (no-op if already dead)
tmux kill-session -t lockbot 2>/dev/null

# 3. Recreate it with the SAME env vars + command (substitute real secrets from step 1)
tmux new-session -d -s lockbot 'export PATH="$HOME/.local/bin:$PATH" \
  && export JWT_SECRET="<...>" && export ENCRYPTION_KEY="<...>" \
  && export DEV_MODE="true" && export DATA_DIR="/home/users/v_qiujie04/lock_bot/.data" \
  && export PYTHONPATH="/home/users/v_qiujie04/lock_bot/python" \
  && uvicorn lockbot.backend.app.main:app --host 0.0.0.0 --port 8875 2>&1 | tee /tmp/jieLockBot.log'

# 4. Verify startup (look for "Application startup complete." and "Auto-recovered bot")
sleep 4 && tmux capture-pane -t lockbot -p | tail -20
```

Logs also tail to `/tmp/jieLockBot.log`. The secrets (`JWT_SECRET`, `ENCRYPTION_KEY`) are runtime-only env vars — always copy them from the live process in step 1 rather than hardcoding.

## Architecture

**Two deployment modes share the same `python/lockbot/core/` library:**

### 1. Platform Mode (recommended)
- **Backend**: FastAPI app at `python/lockbot/backend/app/main.py` — lifespan creates DB tables, runs migrations, seeds dev users, starts `BotManager`
- **Frontend**: Vue 3 + Element Plus in `frontend/` — built via Vite, served as static files by FastAPI
- **BotManager** (`backend/app/bots/manager.py`): In-process multi-bot lifecycle manager. Uses a shared `BotScheduler` to drive all bot timer checks. Bots are identified by integer bot_id and receive webhook callbacks at `/api/bots/webhook/{bot_id}`
- **Auth**: JWT with roles (super_admin/admin/user), `must_change_password` flag, `token_version` for invalidation
- **DB**: SQLite via SQLAlchemy, auto-migrated on startup (see migration functions in `main.py`)
- **Rate limiting**: slowapi, disabled in tests via `conftest.py` mock

### 2. Standalone Mode (legacy/deprecated)
- Flask entry point at `python/lockbot/core/entry.py`
- Single bot per process, creates its own `BotScheduler`

### Core Library (`python/lockbot/core/`)

**Bot class hierarchy:**
- `BaseLockBot` (`base_bot.py`) — common infrastructure: config/state/lock/adapter, timer routine, help text, error formatting, `_record_occupancy_end` hook (calls `_on_occupancy_end` callback to persist occupancy records on unlock/expiry/kickout)
- `DeviceBot` (`device_bot.py`) — per-GPU locking with exclusive/shared modes, device usage alert, command parsing via regex
- `NodeBot` (`node_bot.py`) — whole-node locking with exclusive/shared modes
- `QueueBot` (`queue_bot.py`) — extends `NodeBot`, adds `book`/`take` commands for queue scheduling with auto-promotion and a `kicklock` command (kick current holder then immediately lock). It drops `slock` (no shared-lock command) and always renders `/query` with `memory_based=False` so the booking column shows.

**BotInstance** (`bot_instance.py`): Factory that wraps a bot + config + state + optional scheduler. Map: `"NODE" → NodeBot`, `"QUEUE" → QueueBot`, `"DEVICE" → DeviceBot`.

**BotState** (`base_bot.py.BotState`): Each bot class defines an inner `_state_class` with a `_loader` static method (e.g., `create_or_load_node_state`, `create_or_load_device_state`) that loads/creates state from JSON files.

**BotScheduler** (`scheduler.py`): Single daemon thread with a min-heap of `(fire_at, generation, bot_id)`. Replaces per-bot `threading.Timer`. On each tick, calls `bot._check_and_notify()` which checks lock expiry, sends notifications, then returns the next desired check interval. Tracks consecutive failures and fires `on_fatal_error` callback after 5 failures.

**Config** (`config.py`): Instance-level `Config(config_dict)` with `get_val()`/`set_val()`. Class-level methods (`Config.get()`, `Config.set()`) are deprecated. Paths like `STATE_FILENAME` are derived from `BOT_ID + DATA_DIR`. Schema defines defaults, descriptions, and whether env override is allowed. Notable GPU-related keys: `XPU_USAGE_TTL` (cache TTL), `MEM_BUSY_THRESHOLD` (GPU mem % to consider busy), `CONTAINER_MIN_MEM_PCT` (min GPU mem % to show container name). Lock-limit keys: `MAX_LOCK_COUNT`, `MAX_LOCK_DURATION`, and `LOCK_POLICIES` (see below). `Config.lock_limits(now)` resolves the effective `(max_lock_count, max_lock_duration)` for a given time, applying any active policy over the base config.

**MessageAdapter** (`message_adapter.py`): Abstract base for IM platforms, with methods: `verify_request`, `decrypt_payload`, `extract_command`, `build_reply`, `send`. Only `InfoflowAdapter` (如流, in `platforms/infoflow.py`) is implemented. ROADMAP plans Slack/DingTalk/Feishu/WeChat adapters.

**Command routing** (`handler.py`): Parses incoming text → dispatches to bot methods. Each bot advertises its own `supported_commands()`: DEVICE/NODE = `lock`, `slock`, `unlock`/`free`, `kickout`, `query`, `help`/`h`; QUEUE = same minus `slock`, plus `book`, `take`, `kicklock`. `free` is an alias for `unlock`. A bare node key (or a comma/、-separated list of node keys, e.g. `node1,node2`) is treated as a `query` of those nodes; unknown node names in a query surface an invalid-node error. Empty input = query all. The legacy Flask helpers (`decrypt_message`, `handle_request`, `page_not_found`) in this module are deprecated in favor of `backend/app/bots/webhook_handler.py`.

**Scheduled lock policies** (`lock_policy.py`): Beijing-time (`Asia/Shanghai`) recurring windows that override `MAX_LOCK_COUNT`/`MAX_LOCK_DURATION` during matching times; unmatched times fall back to the base config values. Config key `LOCK_POLICIES` is a list of `{start_time, end_time, max_lock_count, max_lock_duration, weekdays?}`. Intervals are half-open (start inclusive, end exclusive), must not overlap, and cross-midnight ranges belong to their start day; `weekdays` is optional (omitted = every day). Limits use `-1` for unlimited. `validate_lock_policies` normalizes/validates on config set. `BaseLockBot` uses this for two things: (1) `_check_and_notify_lock_policy` sends a preview notification before a policy window starts and a transition notification when it changes (dedup via `_policy_notification_events`), both `@all` the group(s) in `GROUP_ID`; (2) `policy_crossing_duration_limit` rejects lock requests whose duration would cross into a stricter upcoming window (with a `CROSS_POLICY_GRACE_DURATION` grace), returning the concise applicable maximum. Config key `POLICY_NOTIFY_QUIET_HOURS` (`"HH:MM-HH:MM"`, default `"06:00-12:00"`, empty disables) mutes both the preview and transition notifications whose **switch (boundary) time** falls inside that Beijing-time window; `in_quiet_hours`/`parse_quiet_hours` (in `lock_policy.py`) implement the half-open, midnight-wrapping check and degrade to "no suppression" on malformed input.

**Query rendering** (`query_render.py`): Builds markdown tables for `/query` output. `build_device_query` for DEVICE bots (device-level rows), `build_node_query` for NODE/QUEUE bots (node-level rows). Sort order: my nodes → idle (FREE) → PARTIAL → BUSY, within each tier by remaining duration ascending. When `build_device_query` is passed an `xpu_usage` map it renders an 8-column table (adds GPU 利用率/MEM%, GPU 显存利用率, and container name — container shown only when GPU mem ≥ `CONTAINER_MIN_MEM_PCT` threshold); otherwise 5 columns. Mixed-lock nodes (some cards locked, some free) show per-card breakdown with individual container names.

**GPU usage collection** (`xpu_collector.py`): `collect_node_usage(node_ips, config)` SSHes into nodes running a remote script that wraps `xpu-smi` / `xpu-smi -m` / container resolution. Returns `NodeUsage(util, mem, container, per_card)` namedtuples where `per_card` is a list of `CardUsage(util, mem, container)` per GPU card. Util/mem are node-average percentages; per-card data enables DEVICE bots to show individual card containers in mixed-lock renders. Container resolution uses `/proc/<pid>/cgroup` → `docker ps`. Uses per-node TTL caching (`XPU_USAGE_TTL`) and `ThreadPoolExecutor` concurrency; any failure degrades to `NodeUsage(None, None, "")`. All three bot types collect usage on `/query` whenever the target nodes have resolvable IPs: NODE and QUEUE set `_collect_xpu_on_query = True` (drives the memory-based status badge, the extra XPU columns, and the container column), and DEVICE collects on both the bare-AT (all nodes) and single-node query paths. SSH is always performed outside the bot lock (node IPs read under the lock, the SSH I/O runs lock-free).

**Usage rendering** (`usage_render.py`): Configurable line templating via `USAGE_LINE_TEMPLATE` / `USAGE_IDLE_TEMPLATE`, with `USAGE_SORT` (name/dur_asc/dur_desc) and `USAGE_GROUP` (none/idle_first/idle_last). `render_line()` gracefully falls back to a default template on format errors.

**I/O** (`io.py`): JSON-based state persistence. Each bot saves to `{DATA_DIR}/{bot_id}/bot_state.json`. Includes backward-compatible migrations for old field formats (`timestamp` → `start_time`, `in_use`/`is_shared` → `status`).

**I18n** (`i18n/`): `en.py` and `zh.py` dictionaries, looked up via `t(key, config=config)` where config provides `LANGUAGE`.

**`yjb_xpu_smi/`**: Standalone xpu-smi monitoring scripts (not part of the lockbot package).

**Device usage alert** (`device_usage_alert.py`): Checks GPU utilization levels and sends alerts when nodes exceed configurable busy/idle thresholds.

**Device usage utils** (`device_usage_utils.py`): Shared helpers for computing per-node busy/free card counts from lock state and GPU usage data.

### Backend API Structure (`python/lockbot/backend/app/`)

| Module | Purpose |
|--------|---------|
| `auth/` | Register, login, logout, JWT dependencies, role-based guards |
| `bots/` | CRUD, start/stop/restart lifecycle, webhook handler, encryption, BotManager |
| `bots/occupancy.py` | OccupancyRecord model + service: tracks who occupied which node, when, for how long. Auto-cleans records older than 8 days. Exposed at `GET /api/bots/{bot_id}/occupancy?date=YYYY-MM-DD&node=...` |
| `admin/` | User management (super_admin only) |
| `settings/` | Global settings key-value store |
| `audit/` | Audit log recording and querying |

### Frontend (`frontend/src/`)

- **Router**: Login, Register, BotList, BotForm (create), BotDetail (edit), ProfileSettings, ForceChangePassword, admin/Users, NotFound
- **Stores**: `auth.js` (Pinia — user state, token, role checks), `bots.js` (bot list state)
- **Components**: `BotCard`, `BotForm/`, `LogViewer`, `StatusBadge`, `DemoChat`, `AuthFooter`

### Testing

- `tests/core/` — unit tests for bot logic, config, scheduler, query rendering, usage rendering, XPU collection, device usage
- `tests/backend/` — API integration tests using FastAPI `TestClient` with in-memory SQLite (StaticPool), rate limiter disabled, bot auto-start patched to `RuntimeError`
- `conftest.py` fixtures: `client` (TestClient with DB override), `auth_header` (JWT token), `admin_header` (admin JWT), `db_session` (raw SQLAlchemy session)
- Test config is set before importing backend modules: `DATABASE_URL = "sqlite://"`, `ALLOW_REGISTER = True`

### CI/CD (`.github/workflows/`)

- `ci.yml`: pytest + ruff on push/PR
- `publish.yml`: PyPI publish on tag push
- `docker.yml`: Build and push to ghcr.io on tag push
- `pages.yml`: Demo page deploy to GitHub Pages

### Pre-commit (`.pre-commit-config.yaml`)

Runs ruff (fix + format) on Python, ESLint + Prettier on frontend files.
