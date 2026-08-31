"""Cached report snapshots shared by the public report API and scheduler."""

from __future__ import annotations

import copy
import logging
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any

from lockbot.backend.app.bots.manager import bot_manager
from lockbot.backend.app.bots.models import Bot
from lockbot.backend.app.config import REPORT_TEST_OCCUPANCY
from lockbot.core.query_render import _get_ip
from lockbot.core.xpu_collector import collect_node_usage

logger = logging.getLogger(__name__)

REPORT_REFRESH_SECONDS = 5 * 60
REPORT_CACHE_SECONDS = 60
_TEST_REPORT_USERNAMES = ("test-alex", "test-blake", "test-casey", "test-devon", "test-erin", "test-frankie")
_TEST_OCCUPANCY_MIN_SECONDS = 60 * 60
_TEST_OCCUPANCY_MAX_SECONDS = 8 * 60 * 60


class ReportUnavailableError(RuntimeError):
    """Raised when a report cannot be collected because its bot is not running."""


class ReportSnapshotService:
    """Collect and retain public status snapshots, one per running bot.

    SSH collection is deliberately performed outside a bot's state lock.  A per-bot
    lock coalesces concurrent page refreshes so a popular report page never starts
    duplicate probes for the same set of machines.
    """

    def __init__(self) -> None:
        self._snapshots: dict[int, tuple[float, dict[str, Any]]] = {}
        self._snapshot_lock = threading.RLock()
        self._bot_locks: dict[int, threading.Lock] = {}
        self._scheduler_thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def start(self) -> None:
        """Start the periodic refresher.  Safe to call more than once."""
        if self._scheduler_thread and self._scheduler_thread.is_alive():
            return
        self._stop_event.clear()
        self._scheduler_thread = threading.Thread(target=self._run, daemon=True, name="ReportSnapshotScheduler")
        self._scheduler_thread.start()

    def stop(self) -> None:
        """Stop the periodic refresher without affecting bot scheduling."""
        self._stop_event.set()
        if self._scheduler_thread and self._scheduler_thread.is_alive():
            self._scheduler_thread.join(timeout=10)
        self._scheduler_thread = None

    def invalidate(self, bot_id: int) -> None:
        """Mark an existing report stale after a lock or release changes state."""
        with self._snapshot_lock:
            if bot_id in self._snapshots:
                _, snapshot = self._snapshots[bot_id]
                self._snapshots[bot_id] = (0.0, snapshot)

    def get_or_refresh(self, bot: Bot, *, force: bool = False) -> tuple[dict[str, Any], bool]:
        """Return a snapshot and whether it was served from the one-minute cache."""
        if bot.status != "running":
            raise ReportUnavailableError("Bot is not running")

        with self._snapshot_lock:
            lock = self._bot_locks.setdefault(bot.id, threading.Lock())
        with lock:
            now = time.time()
            with self._snapshot_lock:
                entry = self._snapshots.get(bot.id)
            if entry and not force and now - entry[0] < REPORT_CACHE_SECONDS:
                return copy.deepcopy(entry[1]), True

            snapshot = self._collect(bot)
            with self._snapshot_lock:
                self._snapshots[bot.id] = (time.time(), snapshot)
            return copy.deepcopy(snapshot), False

    def _collect(self, bot: Bot) -> dict[str, Any]:
        instance = bot_manager.get_instance(bot.id)
        if instance is None:
            raise ReportUnavailableError("Bot instance is unavailable")

        runtime_bot = instance.bot
        with runtime_bot._lock:
            state = copy.deepcopy(runtime_bot.state.bot_state)
            cluster_configs = copy.deepcopy(runtime_bot.config.get_val("CLUSTER_CONFIGS") or {})
            memory_threshold = runtime_bot.config.get_val("MEM_BUSY_THRESHOLD", 10)
            utilization_threshold = runtime_bot.config.get_val("UTILIZATION_BUSY_THRESHOLD", 10)
            config = runtime_bot.config

        node_ips = {node_name: _get_ip(cluster_configs, node_name) for node_name in state}
        node_ips = {node_name: ip for node_name, ip in node_ips.items() if ip}
        xpu_usage = collect_node_usage(node_ips, config) if node_ips else {}
        generated_at = datetime.now(timezone.utc)
        return _build_snapshot(
            bot,
            state,
            cluster_configs,
            xpu_usage,
            memory_threshold,
            utilization_threshold,
            generated_at,
        )

    def _run(self) -> None:
        # Collect straight away after startup; subsequent passes are five minutes apart.
        while not self._stop_event.is_set():
            self.refresh_running_bots()
            self._stop_event.wait(REPORT_REFRESH_SECONDS)

    def refresh_running_bots(self) -> None:
        """Best-effort periodic refresh.  One bad node must not stop other reports."""
        from lockbot.backend.app.database import SessionLocal

        db = SessionLocal()
        try:
            bots = db.query(Bot).filter(Bot.status == "running", Bot.is_deleted.is_(False)).all()
            for bot in bots:
                if self._stop_event.is_set():
                    return
                try:
                    self.get_or_refresh(bot, force=True)
                except Exception:
                    logger.exception("Failed to refresh public report for bot %d", bot.id)
        except Exception:
            logger.exception("Failed to enumerate bots for public report refresh")
        finally:
            db.close()


def _build_snapshot(
    bot: Bot,
    state: dict[str, Any],
    cluster_configs: dict[str, Any],
    xpu_usage: dict[str, Any],
    memory_threshold: float,
    utilization_threshold: float,
    generated_at: datetime,
) -> dict[str, Any]:
    now = time.time()
    nodes = []
    unlocked_resources = 0
    available_resources = 0
    occupied_resources = 0
    free_resources = 0
    total_resources = 0

    for node_name, node_state in state.items():
        usage = xpu_usage.get(node_name)
        if bot.bot_type == "DEVICE":
            devices = []
            per_card = getattr(usage, "per_card", None) or []
            for index, device in enumerate(node_state if isinstance(node_state, list) else []):
                card_usage = per_card[index] if index < len(per_card) else None
                users = _users(device.get("current_users", []), now)
                lock_status = device.get("status", "idle")
                if REPORT_TEST_OCCUPANCY and lock_status == "idle" and not users and _has_observed_usage(card_usage):
                    lock_status = "exclusive"
                    users = [_test_report_user()]
                is_idle = lock_status == "idle"
                is_occupied = not is_idle
                total_resources += 1
                unlocked_resources += int(is_idle)
                available_resources += int(not is_occupied)
                occupied_resources += int(is_occupied)
                gpu_status = _gpu_status(getattr(card_usage, "mem", None), memory_threshold)
                usage_status = _usage_status(
                    getattr(card_usage, "util", None),
                    getattr(card_usage, "mem", None),
                    utilization_threshold,
                    memory_threshold,
                )
                free_resources += int(gpu_status == "free")
                devices.append(
                    {
                        "id": device.get("dev_id", index),
                        "model": device.get("dev_model", ""),
                        "lock_status": lock_status,
                        "gpu_status": gpu_status,
                        "usage_status": usage_status,
                        "users": users,
                        "remaining_seconds": _remaining_seconds(users),
                        "util": getattr(card_usage, "util", None),
                        "mem": getattr(card_usage, "mem", None),
                        "container": getattr(card_usage, "container", ""),
                    }
                )
            node_gpu_status = _node_gpu_status(per_card, memory_threshold)
            node_usage_status = _node_usage_status(per_card, utilization_threshold, memory_threshold)
            nodes.append(
                {
                    "name": node_name,
                    "ip": _get_ip(cluster_configs, node_name),
                    "lock_status": _device_node_status(devices),
                    "gpu_status": node_gpu_status,
                    "usage_status": node_usage_status,
                    "util": getattr(usage, "util", None),
                    "mem": getattr(usage, "mem", None),
                    "container": getattr(usage, "container", ""),
                    "devices": devices,
                    "users": [],
                    "bookings": [],
                }
            )
            continue

        node = node_state if isinstance(node_state, dict) else {}
        users = _users(node.get("current_users", []), now)
        bookings = _users(node.get("booking_list", []), now)
        lock_status = node.get("status", "idle")
        if REPORT_TEST_OCCUPANCY and lock_status == "idle" and not users and _has_observed_usage(usage):
            lock_status = "exclusive"
            users = [_test_report_user()]
            if bot.bot_type == "QUEUE" and not bookings:
                bookings = [_test_report_user()]
        is_occupied = lock_status != "idle" or bool(bookings)
        total_resources += 1
        unlocked_resources += int(lock_status == "idle")
        available_resources += int(not is_occupied)
        occupied_resources += int(is_occupied)
        gpu_status = _gpu_status(getattr(usage, "mem", None), memory_threshold)
        usage_status = _usage_status(
            getattr(usage, "util", None),
            getattr(usage, "mem", None),
            utilization_threshold,
            memory_threshold,
        )
        free_resources += int(gpu_status == "free")
        nodes.append(
            {
                "name": node_name,
                "ip": _get_ip(cluster_configs, node_name),
                "lock_status": lock_status,
                "gpu_status": gpu_status,
                "usage_status": usage_status,
                "util": getattr(usage, "util", None),
                "mem": getattr(usage, "mem", None),
                "container": getattr(usage, "container", ""),
                "devices": [],
                "users": users,
                "bookings": bookings,
            }
        )

    nodes.sort(key=lambda row: _natural_node_key(row["name"]))
    in_use_resources = sum(
        1
        for node in nodes
        for resource in (node["devices"] if bot.bot_type == "DEVICE" else [node])
        if resource["usage_status"] == "in_use"
    )
    return {
        "bot": {"id": bot.id, "name": bot.name, "type": bot.bot_type, "status": bot.status},
        "generated_at": generated_at.isoformat(),
        "summary": {
            "total_resources": total_resources,
            "unlocked_resources": unlocked_resources,
            "available_resources": available_resources,
            "occupied_resources": occupied_resources,
            "free_resources": free_resources,
            "in_use_resources": in_use_resources,
            "utilization_threshold": utilization_threshold,
            "memory_threshold": memory_threshold,
        },
        "nodes": nodes,
    }


def _users(items: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    users = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        start = item.get("start_time") or 0
        duration = item.get("duration") or 0
        try:
            expires_at = int(float(start) + float(duration))
        except (TypeError, ValueError):
            expires_at = 0
        users.append(
            {
                "id": str(item.get("user_id", "")),
                "remaining_seconds": max(0, int(expires_at - now)) if expires_at else None,
            }
        )
    return users


def _remaining_seconds(users: list[dict[str, Any]]) -> int | None:
    values = [user["remaining_seconds"] for user in users if user["remaining_seconds"] is not None]
    return min(values) if values else None


def _has_observed_usage(usage: Any) -> bool:
    """Return whether xpu-smi observed any non-zero XPU or memory utilization."""
    for value in (getattr(usage, "util", None), getattr(usage, "mem", None)):
        if isinstance(value, (int, float)) and value > 0:
            return True
    return False


def _test_report_user() -> dict[str, Any]:
    """Build report-only test data; this is never written back to bot state."""
    return {
        "id": random.choice(_TEST_REPORT_USERNAMES),
        "remaining_seconds": random.randint(_TEST_OCCUPANCY_MIN_SECONDS, _TEST_OCCUPANCY_MAX_SECONDS),
    }


def _gpu_status(mem: float | None, threshold: float) -> str:
    if mem is None:
        return "na"
    return "busy" if mem > threshold else "free"


def _usage_status(util: float | None, mem: float | None, utilization_threshold: float, memory_threshold: float) -> str:
    if util is None and mem is None:
        return "na"
    if (util is not None and util > utilization_threshold) or (mem is not None and mem > memory_threshold):
        return "in_use"
    return "idle"


def _node_gpu_status(per_card: list[Any], threshold: float) -> str:
    statuses = [_gpu_status(getattr(card, "mem", None), threshold) for card in per_card]
    statuses = [value for value in statuses if value != "na"]
    if not statuses:
        return "na"
    if all(value == "free" for value in statuses):
        return "free"
    if all(value == "busy" for value in statuses):
        return "busy"
    return "partial"


def _node_usage_status(per_card: list[Any], utilization_threshold: float, memory_threshold: float) -> str:
    statuses = [
        _usage_status(getattr(card, "util", None), getattr(card, "mem", None), utilization_threshold, memory_threshold)
        for card in per_card
    ]
    statuses = [value for value in statuses if value != "na"]
    if not statuses:
        return "na"
    if all(value == "idle" for value in statuses):
        return "idle"
    if all(value == "in_use" for value in statuses):
        return "in_use"
    return "partial"


def _device_node_status(devices: list[dict[str, Any]]) -> str:
    statuses = {device["lock_status"] for device in devices}
    if not statuses or statuses == {"idle"}:
        return "idle"
    if "idle" in statuses or len(statuses) > 1:
        return "partial"
    return next(iter(statuses))


def _natural_node_key(name: str) -> tuple[int, int | str]:
    if name.startswith("node") and name[4:].isdigit():
        return (0, int(name[4:]))
    return (1, name.casefold())


report_snapshot_service = ReportSnapshotService()
