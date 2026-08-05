"""Validation and resolution helpers for time-based lock policies."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    BEIJING_TZ = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:  # Minimal containers may omit the system tzdata package.
    BEIJING_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
UNLIMITED = -1
MIN_POLICY_DURATION = 300
MAX_POLICY_DURATION = 604800
MAX_POLICY_COUNT = 16


class LockPolicyValidationError(ValueError):
    """Raised when a scheduled lock policy is malformed or ambiguous."""


def _parse_time(value: object, field: str) -> int:
    if not isinstance(value, str):
        raise LockPolicyValidationError(f"{field} must use HH:MM format")
    parts = value.split(":")
    if len(parts) != 2 or any(not part.isdigit() for part in parts):
        raise LockPolicyValidationError(f"{field} must use HH:MM format")
    hour, minute = (int(part) for part in parts)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise LockPolicyValidationError(f"{field} must use a valid time")
    return hour * 60 + minute


def _interval_parts(start: int, end: int) -> list[tuple[int, int]]:
    if start < end:
        return [(start, end)]
    return [(start, 24 * 60), (0, end)]


def _validate_limit(value: object, field: str, *, count: bool) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LockPolicyValidationError(f"{field} must be an integer")
    if value == UNLIMITED:
        return value
    if count and not (1 <= value <= MAX_POLICY_COUNT):
        raise LockPolicyValidationError(f"{field} must be -1 or between 1 and {MAX_POLICY_COUNT}")
    if not count and not (MIN_POLICY_DURATION <= value <= MAX_POLICY_DURATION):
        raise LockPolicyValidationError(
            f"{field} must be -1 or between {MIN_POLICY_DURATION} and {MAX_POLICY_DURATION}"
        )
    return value


def validate_lock_policies(value: object) -> list[dict]:
    """Validate and normalize a list of scheduled lock policies.

    Policy intervals are half-open: ``start_time`` is included and
    ``end_time`` is excluded. This makes adjacent policies such as 08:00-12:00
    and 12:00-18:00 valid without overlap.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise LockPolicyValidationError("LOCK_POLICIES must be a list")

    normalized: list[dict] = []
    intervals: list[list[tuple[int, int]]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise LockPolicyValidationError(f"LOCK_POLICIES[{index}] must be an object")
        required = {"start_time", "end_time", "max_lock_count", "max_lock_duration"}
        missing = required - raw.keys()
        if missing:
            raise LockPolicyValidationError(f"LOCK_POLICIES[{index}] missing: {', '.join(sorted(missing))}")
        start = _parse_time(raw["start_time"], f"LOCK_POLICIES[{index}].start_time")
        end = _parse_time(raw["end_time"], f"LOCK_POLICIES[{index}].end_time")
        if start == end:
            raise LockPolicyValidationError(f"LOCK_POLICIES[{index}] must not cover an empty interval")
        count = _validate_limit(raw["max_lock_count"], f"LOCK_POLICIES[{index}].max_lock_count", count=True)
        duration = _validate_limit(
            raw["max_lock_duration"], f"LOCK_POLICIES[{index}].max_lock_duration", count=False
        )
        current_parts = _interval_parts(start, end)
        for previous_parts in intervals:
            if any(
                left < right_end and right < left_end
                for left, left_end in previous_parts
                for right, right_end in current_parts
            ):
                raise LockPolicyValidationError("LOCK_POLICIES time ranges must not overlap")
        intervals.append(current_parts)
        normalized.append(
            {
                "start_time": f"{start // 60:02d}:{start % 60:02d}",
                "end_time": f"{end // 60:02d}:{end % 60:02d}",
                "max_lock_count": count,
                "max_lock_duration": duration,
            }
        )
    return normalized


def _as_beijing_datetime(now: datetime | int | float | None) -> datetime:
    if now is None:
        return datetime.now(BEIJING_TZ)
    if isinstance(now, (int, float)):
        return datetime.fromtimestamp(now, tz=BEIJING_TZ)
    if now.tzinfo is None:
        return now.replace(tzinfo=BEIJING_TZ)
    return now.astimezone(BEIJING_TZ)


def resolve_lock_policy(
    policies: list[dict] | None,
    now: datetime | int | float | None = None,
) -> dict | None:
    """Return the policy active at ``now`` in Beijing time, if any."""
    if not policies:
        return None
    local_now = _as_beijing_datetime(now)
    minute = local_now.hour * 60 + local_now.minute
    for policy in policies:
        start = _parse_time(policy["start_time"], "start_time")
        end = _parse_time(policy["end_time"], "end_time")
        active = minute >= start and minute < end if start < end else minute >= start or minute < end
        if active:
            return policy
    return None


def next_lock_policy_boundary(
    policies: list[dict] | None,
    now: datetime | int | float | None = None,
) -> datetime | None:
    """Return the next policy start/end boundary in Beijing time.

    Boundaries are minute-based and strictly after ``now``.  Returning a
    timezone-aware datetime lets callers use it both for scheduling and for
    deterministic tests.
    """
    if not policies:
        return None
    local_now = _as_beijing_datetime(now)
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    candidates: list[datetime] = []
    for policy in policies:
        candidates.extend(
            day_start + timedelta(days=offset, minutes=_parse_time(policy[field], field))
            for offset in (0, 1)
            for field in ("start_time", "end_time")
        )
    future = [candidate for candidate in candidates if candidate > local_now]
    return min(future) if future else None


def seconds_until_lock_policy_boundary(
    policies: list[dict] | None,
    now: datetime | int | float | None = None,
) -> float | None:
    """Return seconds until the next policy boundary, or ``None`` if absent."""
    boundary = next_lock_policy_boundary(policies, now)
    if boundary is None:
        return None
    current = _as_beijing_datetime(now)
    return max(0.0, (boundary - current).total_seconds())


def lock_policy_limits(
    policies: list[dict] | None,
    fallback_limits: tuple[int, int],
    now: datetime | int | float | None = None,
) -> tuple[int, int]:
    """Return the effective ``(count, duration)`` limits at *now*."""
    policy = resolve_lock_policy(policies, now)
    if policy is None:
        return int(fallback_limits[0]), int(fallback_limits[1])
    return int(policy["max_lock_count"]), int(policy["max_lock_duration"])


def iter_lock_policy_changes(
    policies: list[dict] | None,
    fallback_limits: tuple[int, int],
    start: datetime | int | float,
    end: datetime | int | float,
):
    """Yield effective policy changes in ``(start, end]``.

    A change is ``(boundary, new_limits, old_limits)``.  Policy ranges repeat
    every Beijing day; only boundaries that actually alter the final limits
    are yielded, so gaps and adjacent equal-limit policies are handled too.
    """
    if not policies:
        return
    local_start = _as_beijing_datetime(start)
    local_end = _as_beijing_datetime(end)
    if local_end <= local_start:
        return

    day_start = (local_start - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day_count = (local_end.date() - day_start.date()).days + 2
    candidates: set[datetime] = set()
    for offset in range(max(0, day_count)):
        current_day = day_start + timedelta(days=offset)
        for policy in policies:
            for field in ("start_time", "end_time"):
                candidates.add(current_day + timedelta(minutes=_parse_time(policy[field], field)))

    for boundary in sorted(candidate for candidate in candidates if local_start < candidate <= local_end):
        old_limits = lock_policy_limits(policies, fallback_limits, boundary - timedelta(seconds=1))
        new_limits = lock_policy_limits(policies, fallback_limits, boundary + timedelta(seconds=1))
        if old_limits != new_limits:
            yield boundary, new_limits, old_limits


def next_lock_policy_change(
    policies: list[dict] | None,
    fallback_limits: tuple[int, int],
    now: datetime | int | float | None = None,
) -> tuple[datetime, tuple[int, int], tuple[int, int]] | None:
    """Return the next boundary that changes effective limits, if any."""
    current = _as_beijing_datetime(now)
    # One full extra day is enough because policy boundaries repeat daily.
    horizon = current + timedelta(days=3)
    return next(iter_lock_policy_changes(policies, fallback_limits, current, horizon), None)
