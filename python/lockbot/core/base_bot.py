r"""
lockbot - BaseLockBot
"""

import logging
import threading
import time
import uuid
from collections.abc import Callable
from importlib.metadata import version as _pkg_version

from lockbot.core.config import Config
from lockbot.core.i18n import t
from lockbot.core.lock_policy import (
    in_quiet_hours,
    iter_lock_policy_changes,
    lock_policy_limits,
    next_lock_policy_change,
    policy_crossing_duration_limit,
)
from lockbot.core.platforms.infoflow import InfoflowAdapter
from lockbot.core.request import webhook_response_succeeded
from lockbot.core.utils import format_duration, remaining_duration


def _get_version():
    try:
        return _pkg_version("lockbot")
    except Exception:
        return "unknown"


class BotState:
    """Manages bot state by delegating to a loader function."""

    _loader = None  # Subclasses or instances must set this

    def __init__(self, config=None):
        result = self._loader(config=config)
        if isinstance(result, tuple):
            self.bot_state, self.clamped_user_ids = result
        else:
            self.bot_state = result
            self.clamped_user_ids = set()


class BaseLockBot:
    """
    Base class for all lock bots.  Provides common infrastructure:
    - construction (config / state / lock / adapter)
    - show_error
    - timer_routine
    - print_help (template-method: header + _help_commands + footer)
    - _msg_with_usage  convenience helper
    - _build_alert_header
    """

    # Subclasses MUST define an inner _state_class(BotState) with a _loader.
    _state_class = None

    logger = logging.getLogger("lockbot.timer")

    # ------------------------------------------------------------------ init
    def __init__(self, config_dict=None, *, config=None, state=None, lock=None, adapter=None):
        """
        Create an isolated bot instance.

        Two usage patterns:
        - config_dict: pass a config dict, auto-creates config/state/lock
        - config/state/lock: inject existing objects directly (for testing)
        """
        if config is not None:
            self.config = config
        else:
            self.config = Config(config_dict or {})

        if state is not None:
            self.state = state
        else:
            self.state = self._state_class(config=self.config)

        self._lock = lock or threading.Lock()
        self.adapter = adapter or InfoflowAdapter(config=self.config)
        # Optional callback: invoked after a successful lock/slock so the
        # scheduler can recalculate its next wakeup without waiting for idle.
        self._on_state_changed: Callable[[], None] | None = None
        # Optional callback: invoked when a user's lock on a node ends
        # (manual unlock, auto-expiry, or kickout).  Signature:
        #   (node_key: str, user_id: str, start_time: int, end_time: int, lock_mode: str)
        self._on_occupancy_end: Callable[[str, str, int, int, str], None] | None = None
        # Completed sessions are first persisted with bot state, then delivered
        # through this callback.  The event id makes retries safe.
        self._pending_occupancy_events = self._load_pending_occupancy_events()
        self._on_occupancy_flush: Callable[[list[dict]], set[str]] | None = None
        # Last limits observed by the scheduler.  ``None`` means the initial
        # check has not established a baseline yet, so startup is silent.
        self._last_lock_policy_signature: tuple[int, int] | None = None
        self._last_lock_policy_check_at: float | None = None
        # Event keys are kept in memory intentionally.  A restart establishes
        # the current baseline and never replays an already elapsed preview.
        self._policy_notification_events: set[str] = set()

        self._notify_clamped_users()

    def _notify_clamped_users(self):
        """Send notification to users whose locks were shortened by max_duration reduction."""
        clamped = getattr(self.state, "clamped_user_ids", set())
        if not clamped:
            return
        max_dur = self.config.get_val("MAX_LOCK_DURATION")
        dur_str = format_duration(max_dur, config=self.config)
        msg = t("notify.duration_clamped", config=self.config, max_duration=dur_str)
        reply = self.adapter.build_reply(msg, list(clamped))
        try:
            self.adapter.send(reply)
        except Exception:
            self.logger.warning("Failed to notify clamped users: %s", clamped)

    def _notify_state_changed(self) -> None:
        """Call _on_state_changed if wired up (no-op otherwise)."""
        if self._on_state_changed is not None:
            self._on_state_changed()

    def _public_report_reply(self, user_id):
        """Build the short public report reply when this bot has a public web origin.

        Returning ``None`` keeps standalone/legacy installations working until
        ``PUBLIC_BASE_URL`` is configured.  Deployed platform bots receive the
        value through ``_build_config_dict``.
        """
        base_url = str(self.config.get_val("PUBLIC_BASE_URL", "") or "").rstrip("/")
        bot_id = self.config.get_val("BOT_ID")
        if not base_url or bot_id in (None, ""):
            return None
        url = f"{base_url}/#/report/{bot_id}"
        content = [
            t("query.public_report_link", config=self.config),
            (t("query.public_report_open", config=self.config), url),
        ]
        return self.adapter.build_reply(
            content,
            [user_id],
        )

    def _policy_duration_text(self, duration: int) -> str:
        if duration < 0:
            return t("help.unlimited", config=self.config)
        hours = duration / 3600
        return f"{hours:g}h"

    def _lock_duration_violation(
        self,
        now: int,
        start_time: int,
        total_duration: int,
        current_max_duration: int,
    ) -> int | None:
        """Return the applicable maximum if a request exceeds policy limits."""
        remaining = max(int(start_time) + int(total_duration) - int(now), 0)
        allowed_limits = []
        if current_max_duration > 0:
            allowed_limits.append(int(current_max_duration))

        policies = self.config.get_val("LOCK_POLICIES")
        fallback_limits = (
            int(self.config.get_val("MAX_LOCK_COUNT")),
            int(self.config.get_val("MAX_LOCK_DURATION")),
        )
        crossing_limit = policy_crossing_duration_limit(
            policies,
            fallback_limits,
            now,
            int(start_time) + int(total_duration),
        )
        if crossing_limit is not None:
            allowed_limits.append(crossing_limit)

        if not allowed_limits:
            return None
        allowed = min(allowed_limits)
        return allowed if remaining > allowed else None

    def _check_and_notify_lock_policy(self) -> float | None:
        """Send policy previews and confirmations and return the next wakeup.

        Policy events are based on effective limits rather than every raw
        interval edge.  The first check only establishes a baseline, which is
        what prevents a restart during the one-hour preview window from
        replaying that preview.
        """
        if self.config.get_val("BOT_TYPE") not in {"NODE", "QUEUE"}:
            return None

        now = time.time()
        policies = self.config.get_val("LOCK_POLICIES")
        fallback_limits = (
            int(self.config.get_val("MAX_LOCK_COUNT")),
            int(self.config.get_val("MAX_LOCK_DURATION")),
        )
        signature = lock_policy_limits(policies, fallback_limits, now)
        previous_check = self._last_lock_policy_check_at
        self._last_lock_policy_signature = signature
        self._last_lock_policy_check_at = now

        if previous_check is None:
            return self._next_policy_notification_delay(now, policies, fallback_limits)

        # Include the next hour so a check that lands inside a preview window
        # can send it even when the scheduler was delayed past its exact time.
        changes = list(iter_lock_policy_changes(policies, fallback_limits, previous_check, now + 3600))
        transitioned_now = any(boundary.timestamp() == now for boundary, _new, _old in changes)
        for boundary, new_limits, _old_limits in changes:
            boundary_ts = boundary.timestamp()
            event_id = str(int(boundary_ts))
            if boundary_ts <= now:
                self._send_policy_event(event_id, "transition", new_limits)
            else:
                preview_ts = boundary_ts - 3600
                if previous_check < preview_ts <= now < boundary_ts and not (preview_ts == now and transitioned_now):
                    self._send_policy_event(event_id, "preview", new_limits)

        return self._next_policy_notification_delay(now, policies, fallback_limits)

    def _next_policy_notification_delay(self, now: float, policies, fallback_limits) -> float | None:
        change = next_lock_policy_change(policies, fallback_limits, now)
        if change is None:
            return None
        boundary = change[0].timestamp()
        preview = boundary - 3600
        return max(0.0, preview - now) if now < preview else max(0.0, boundary - now)

    def _send_policy_event(self, event_id: str, phase: str, limits: tuple[int, int]) -> None:
        key = f"{event_id}:{phase}"
        if key in self._policy_notification_events:
            return

        # Suppress preview + switch notifications whose switch moment (event_id
        # is the boundary Unix timestamp) falls inside the Beijing-time quiet
        # window. Not recorded in _policy_notification_events: the check is
        # naturally one-shot per boundary and stays skippable if config changes.
        if in_quiet_hours(self.config.get_val("POLICY_NOTIFY_QUIET_HOURS", ""), int(event_id)):
            self.logger.info(
                "Policy %s notification suppressed (quiet hours): bot=%s boundary=%s",
                phase,
                self.config.get_val("BOT_NAME"),
                event_id,
            )
            return

        count_text = t("help.unlimited", config=self.config) if limits[0] < 0 else str(limits[0])
        duration_text = self._policy_duration_text(limits[1])
        message_key = "notify.lock_policy_upcoming" if phase == "preview" else "notify.lock_policy_changed"
        content = t(message_key, config=self.config, max_count=count_text, max_duration=duration_text)
        group_ids = {
            int(group_id.strip())
            for group_id in str(self.config.get_val("GROUP_ID", "") or "").split(",")
            if group_id.strip()
        }
        if not group_ids:
            self.logger.warning(
                "Policy %s notification skipped: bot=%s has no configured groups",
                phase,
                self.config.get_val("BOT_NAME"),
            )
            return

        succeeded = True
        for group_id in sorted(group_ids):
            try:
                reply = self.adapter.build_reply(content, [], group_id=group_id, at_all=True)
                responses = self.adapter.send(reply)
                failed = []
                for item in responses or []:
                    status = item[0] if isinstance(item, (tuple, list)) and item else None
                    response_text = item[1] if isinstance(item, (tuple, list)) and len(item) > 1 else ""
                    if not webhook_response_succeeded(status, response_text):
                        failed.append(item)
                if not responses or failed:
                    succeeded = False
                    summary = "; ".join(str(item)[:200] for item in failed)
                    self.logger.error(
                        "Policy %s webhook failed: bot=%s group=%s response=%s",
                        phase,
                        self.config.get_val("BOT_NAME"),
                        group_id,
                        summary,
                    )
            except Exception as exc:
                succeeded = False
                self.logger.error(
                    "Policy %s webhook exception: bot=%s group=%s error=%s",
                    phase,
                    self.config.get_val("BOT_NAME"),
                    group_id,
                    exc,
                    exc_info=True,
                )
        if succeeded:
            self._policy_notification_events.add(key)

    def _load_pending_occupancy_events(self) -> list[dict]:
        from lockbot.core.io import load_pending_occupancy_events

        return load_pending_occupancy_events(self.config)

    @staticmethod
    def _start_occupancy(user_info: dict) -> None:
        """Associate a newly acquired resource with one durable session."""
        user_info.setdefault("occupancy_session_id", uuid.uuid4().hex)

    def _record_occupancy_end(
        self,
        node_key: str,
        user_info: dict,
        lock_mode: str,
        *,
        device_id: int | None = None,
        ended_at: int | None = None,
    ) -> None:
        """Durably queue one completed session; duplicate calls are harmless."""
        start = int(user_info.get("start_time", 0))
        planned_end = start + int(user_info.get("duration", 0))
        end = planned_end if ended_at is None else int(ended_at)
        session_id = user_info.setdefault("occupancy_session_id", uuid.uuid4().hex)
        event_id = f"end:{session_id}"
        if any(event.get("event_id") == event_id for event in self._pending_occupancy_events):
            return
        # Retained for standalone integrations that still consume the legacy
        # callback. Managed mode uses the durable outbox callback below.
        if self._on_occupancy_end is not None:
            self._on_occupancy_end(node_key, user_info["user_id"], start, end, lock_mode)
        self._pending_occupancy_events.append(
            {
                "event_id": event_id,
                "session_id": session_id,
                "resource_type": "device" if device_id is not None else "node",
                "node_key": node_key,
                "device_id": device_id,
                "user_id": user_info["user_id"],
                "lock_mode": lock_mode,
                "start_time": start,
                "end_time": max(start, end),
            }
        )

    def _flush_pending_occupancy_events(self) -> None:
        if not self._pending_occupancy_events or self._on_occupancy_flush is None:
            return
        delivered = self._on_occupancy_flush(list(self._pending_occupancy_events))
        if delivered:
            self._pending_occupancy_events = [
                event for event in self._pending_occupancy_events if event["event_id"] not in delivered
            ]

    def _cleanup_expired_current_users(self, node_key: str, resource: dict, seen: set | None = None) -> bool:
        if resource["status"] == "idle":
            return False

        changed = False
        remaining_users = []
        for user_info in resource["current_users"]:
            if remaining_duration(user_info["start_time"], user_info["duration"]) > 0:
                remaining_users.append(user_info)
                continue

            if seen is None:
                self._record_occupancy_end(node_key, user_info, resource["status"])
            else:
                dedup_key = (node_key, user_info["user_id"])
                if dedup_key not in seen:
                    seen.add(dedup_key)
                    self._record_occupancy_end(node_key, user_info, resource["status"])
            changed = True

        if changed:
            resource["current_users"] = remaining_users
            if not remaining_users:
                resource["status"] = "idle"
        return changed

    def _save_and_notify(self) -> None:
        """Persist bot state to disk and wake the scheduler (if wired).

        Use this in every command handler that mutates state so it's
        impossible to forget either step.  The scheduler's
        ``_check_and_notify`` loop should still call ``save_bot_state_to_file``
        directly to avoid an unwanted reschedule from the timer thread.
        """
        self._persist_state()
        self._notify_state_changed()

    def _persist_state(self) -> None:
        """Persist state/outbox, then best-effort flush and persist the acknowledgement."""
        from lockbot.core.io import save_bot_state_to_file

        # Persist the outbox before attempting the DB write. A crash at any
        # point either leaves an event to retry or meets DB's unique event id.
        save_bot_state_to_file(
            self.state.bot_state, config=self.config, pending_occupancy_events=self._pending_occupancy_events
        )
        self._flush_pending_occupancy_events()
        save_bot_state_to_file(
            self.state.bot_state, config=self.config, pending_occupancy_events=self._pending_occupancy_events
        )

    # ---------------------------------------------------------- show_error
    def show_error(self, user_id, error_msg):
        """
        Show error message
        """
        return self.adapter.build_reply("\u274c" + error_msg, [user_id])

    def show_duration_limit_error(self, user_id, message_key, max_duration):
        """Reject an overlong request with the concise policy-limit calculation."""
        message = t(
            message_key,
            config=self.config,
            max_duration=format_duration(max_duration, config=self.config),
        )
        message += t("error.duration_limit_reason", config=self.config)
        return self.show_error(user_id, message)

    def _minimum_lock_count_error(self, user_id, node_keys):
        """Return an error reply when a request targets too few nodes, otherwise None."""
        min_count = self.config.get_val("MIN_LOCK_COUNT")
        if len(node_keys) < min_count:
            return self.show_error(
                user_id,
                t(
                    "error.min_lock_count_not_met",
                    config=self.config,
                    count=len(node_keys),
                    min_count=min_count,
                ),
            )
        return None

    # ------------------------------------------------------ _msg_with_usage
    def _msg_with_usage(self, msg_key, *, node_key=None, sep="", **kwargs):
        """Return ``t(msg_key, ...) + sep + self._current_usage(node_key)``."""
        return t(msg_key, config=self.config, **kwargs) + sep + self._current_usage(node_key)

    # ------------------------------------------------- _build_alert_header
    def _build_alert_header(self):
        """Build the common alert header used by ``_check_and_notify``."""
        EARLY_NOTIFY = self.config.get_val("EARLY_NOTIFY")
        TIME_ALERT = self.config.get_val("TIME_ALERT")

        if EARLY_NOTIFY:
            alert_info = t(
                "alert.early_time_remaining",
                config=self.config,
                time_alert=format_duration(TIME_ALERT, config=self.config),
            )
            alert_info += t("alert.early_extend_reminder", config=self.config)
            alert_info += t("alert.early_resource_list_header", config=self.config)
        else:
            alert_info = t("alert.auto_released_title", config=self.config)
            alert_info += t("alert.auto_released_list_header", config=self.config)
        return alert_info

    # --------------------------------------------------------- _help_header
    def _help_header(self):
        """Return the header section of the help text.  Override in subclasses."""
        EARLY_NOTIFY = self.config.get_val("EARLY_NOTIFY")

        parts = []
        parts.append(t("help.title", config=self.config))
        parts.append(t("help.section1_title", config=self.config))
        parts.append(
            t(
                "help.rule1_default_duration",
                config=self.config,
                default_duration=format_duration(self.config.get_val("DEFAULT_DURATION"), config=self.config),
            )
        )
        if EARLY_NOTIFY:
            parts.append(
                t(
                    "help.rule2_early_notification",
                    config=self.config,
                    time_alert=format_duration(self.config.get_val("TIME_ALERT"), config=self.config),
                )
            )
        else:
            parts.append(t("help.rule2_post_expiry_notification", config=self.config))
        return "".join(parts)

    # ---------------------------------------------------------- print_help
    def print_help(self, user_id, extra_info=None):
        """
        Show help message.  Uses the *template method* pattern:
        header + ``_help_commands()`` + footer.
        """
        reply_info = extra_info + "\n\n" if extra_info else ""
        # ---- header ----
        reply_info += self._help_header()

        # ---- commands (subclass hook) ----
        reply_info += self._help_commands()

        # ---- footer ----
        max_count, max_dur = self.config.get_lock_limits()
        if self.config.get_val("BOT_TYPE") in {"NODE", "QUEUE"}:
            reply_info += self._help_lock_limits_warning(max_count, max_dur)
        elif max_dur > 0:
            reply_info += self._help_max_duration_warning(max_dur)

        # Compact footer line
        footer_parts = [f"v{_get_version()}"]
        bot_id = self.config.get_val("BOT_ID")
        if bot_id:
            footer_parts.append(f"ID: {bot_id}")
        bot_owner = self.config.get_val("BOT_OWNER")
        if bot_owner:
            footer_parts.append(t("help.bot_owner", config=self.config, owner=bot_owner).strip())
        reply_info += " | ".join(footer_parts) + "\n"

        # ---- news (only on explicit help) ----
        if extra_info is None:
            news = self._get_news_content()
            if news:
                reply_info += "\n"
                reply_info += t("help.news_header", config=self.config)
                reply_info += news + "\n"

        # ---- project links (only on explicit help) ----
        help_links = []
        if extra_info is None:
            github_url = self._get_site_value("github_url") or self.config.get_val("GITHUB_URL")
            if github_url:
                help_links.append("\n")
                help_links.append((t("help.github_url", config=self.config), github_url))

        if help_links:
            reply_info = [reply_info] + help_links
        # Ensure a blank line before @mention
        if isinstance(reply_info, list):
            reply_info.append("\n")
        else:
            reply_info += "\n"
        return self.adapter.build_reply(reply_info, [user_id])

    def _help_commands(self):
        """Return the command-section of the help text.  Override in subclasses."""
        return ""

    def _help_max_duration_warning(self, max_duration):
        """Return the bot-type-specific maximum-duration notice for help."""
        return t(
            "help.max_duration_warning",
            config=self.config,
            max_duration=format_duration(max_duration, config=self.config),
        )

    def _help_lock_limits_warning(self, max_count, max_duration):
        """Return the current NODE/QUEUE count and duration limits for help."""
        count_text = t("help.unlimited", config=self.config) if max_count < 0 else str(max_count)
        duration_text = (
            t("help.unlimited", config=self.config)
            if max_duration < 0
            else format_duration(max_duration, config=self.config)
        )
        return t(
            "help.current_limits",
            config=self.config,
            min_count=self.config.get_val("MIN_LOCK_COUNT"),
            max_count=count_text,
            max_duration=duration_text,
        )

    _site_cache = {}
    _site_cache_ts = 0.0
    _SITE_CACHE_TTL = 6 * 3600  # 6 hours

    @classmethod
    def _invalidate_site_cache(cls):
        """Force next _get_site_value call to read from DB."""
        cls._site_cache = {}
        cls._site_cache_ts = 0.0

    @classmethod
    def _get_site_value(cls, key: str) -> str:
        """Read a site setting from DB with TTL cache."""
        import time

        now = time.time()
        if now - cls._site_cache_ts > cls._SITE_CACHE_TTL:
            cls._site_cache = {}
            cls._site_cache_ts = now
            try:
                from lockbot.backend.app.database import SessionLocal
                from lockbot.backend.app.settings.models import SiteSetting

                db = SessionLocal()
                try:
                    for row in db.query(SiteSetting).all():
                        cls._site_cache[row.key] = row.value.strip() if row.value else ""
                finally:
                    db.close()
            except Exception:
                pass
        return cls._site_cache.get(key, "")

    def _get_news_content(self) -> str:
        """Read news_content from site_settings (max 200 chars)."""
        text = self._get_site_value("news_content")
        if len(text) > 30:
            text = text[:30] + "..."
        return text
