"""Validation and resolution helpers for Beijing-time weekly lock policies."""

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
CROSS_POLICY_GRACE_DURATION = 2 * 60 * 60
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_WEEKDAY_INDEX = {day: index for index, day in enumerate(WEEKDAYS)}


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


def _validate_weekdays(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise LockPolicyValidationError(f"{field} must be a non-empty list of weekdays")
    if any(not isinstance(day, str) or day not in _WEEKDAY_INDEX for day in value):
        raise LockPolicyValidationError(f"{field} must contain only: {', '.join(WEEKDAYS)}")
    if len(set(value)) != len(value):
        raise LockPolicyValidationError(f"{field} must not contain duplicate weekdays")
    return [day for day in WEEKDAYS if day in value]


def _policy_weekdays(policy: dict) -> frozenset[int]:
    """Return policy start weekdays; omitted values preserve daily legacy behavior."""
    raw_weekdays = policy.get("weekdays")
    if raw_weekdays is None:
        return frozenset(range(7))
    return frozenset(_WEEKDAY_INDEX[day] for day in raw_weekdays)


def _coverage_parts(start: int, end: int, weekdays: frozenset[int]) -> list[tuple[int, int, int]]:
    """Return ``(weekday, start, end)`` segments for overlap validation."""
    parts: list[tuple[int, int, int]] = []
    for weekday in weekdays:
        if start < end:
            parts.append((weekday, start, end))
        else:
            parts.append((weekday, start, 24 * 60))
            parts.append(((weekday + 1) % 7, 0, end))
    return parts


def _policy_active_at(policy: dict, local_now: datetime) -> bool:
    start = _parse_time(policy["start_time"], "start_time")
    end = _parse_time(policy["end_time"], "end_time")
    minute = local_now.hour * 60 + local_now.minute
    weekdays = _policy_weekdays(policy)
    if start < end:
        return local_now.weekday() in weekdays and start <= minute < end
    if minute >= start:
        return local_now.weekday() in weekdays
    return minute < end and (local_now.weekday() - 1) % 7 in weekdays


def _policy_boundaries(policy: dict, day_start: datetime) -> tuple[datetime, datetime] | None:
    """Return actual boundaries for the date on which a weekly policy begins."""
    if day_start.weekday() not in _policy_weekdays(policy):
        return None
    start = _parse_time(policy["start_time"], "start_time")
    end = _parse_time(policy["end_time"], "end_time")
    start_at = day_start + timedelta(minutes=start)
    end_at = day_start + timedelta(days=1 if start > end else 0, minutes=end)
    return start_at, end_at


def validate_lock_policies(value: object) -> list[dict]:
    """Validate and normalize scheduled lock policies.

    Intervals are half-open: ``start_time`` is included and ``end_time`` is
    excluded. ``weekdays`` is optional for backward compatibility; omitted
    policies apply every day. Cross-midnight ranges belong to their start day.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise LockPolicyValidationError("LOCK_POLICIES must be a list")

    normalized: list[dict] = []
    intervals: list[list[tuple[int, int, int]]] = []
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
        duration = _validate_limit(raw["max_lock_duration"], f"LOCK_POLICIES[{index}].max_lock_duration", count=False)
        weekdays = (
            _validate_weekdays(raw["weekdays"], f"LOCK_POLICIES[{index}].weekdays") if "weekdays" in raw else None
        )
        current_parts = _coverage_parts(start, end, _policy_weekdays({"weekdays": weekdays}))
        for previous_parts in intervals:
            if any(
                left_day == right_day and left < right_end and right < left_end
                for left_day, left, left_end in previous_parts
                for right_day, right, right_end in current_parts
            ):
                raise LockPolicyValidationError("LOCK_POLICIES time ranges must not overlap")
        intervals.append(current_parts)
        policy = {
            "start_time": f"{start // 60:02d}:{start % 60:02d}",
            "end_time": f"{end // 60:02d}:{end % 60:02d}",
            "max_lock_count": count,
            "max_lock_duration": duration,
        }
        if weekdays is not None:
            policy["weekdays"] = weekdays
        normalized.append(policy)
    return normalized


def _as_beijing_datetime(now: datetime | int | float | None) -> datetime:
    if now is None:
        return datetime.now(BEIJING_TZ)
    if isinstance(now, (int, float)):
        return datetime.fromtimestamp(now, tz=BEIJING_TZ)
    if now.tzinfo is None:
        return now.replace(tzinfo=BEIJING_TZ)
    return now.astimezone(BEIJING_TZ)


def resolve_lock_policy(policies: list[dict] | None, now: datetime | int | float | None = None) -> dict | None:
    """Return the policy active at ``now`` in Beijing time, if any."""
    if not policies:
        return None
    local_now = _as_beijing_datetime(now)
    return next((policy for policy in policies if _policy_active_at(policy, local_now)), None)


def next_lock_policy_boundary(
    policies: list[dict] | None, now: datetime | int | float | None = None
) -> datetime | None:
    """Return the next policy start/end boundary in Beijing time."""
    if not policies:
        return None
    local_now = _as_beijing_datetime(now)
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    candidates: list[datetime] = []
    for offset in range(8):
        current_day = day_start + timedelta(days=offset)
        for policy in policies:
            boundaries = _policy_boundaries(policy, current_day)
            if boundaries is not None:
                candidates.extend(boundaries)
    future = [candidate for candidate in candidates if candidate > local_now]
    return min(future) if future else None


def next_lock_policy_start(policies: list[dict] | None, now: datetime | int | float | None = None) -> datetime | None:
    """Return the next configured policy start in Beijing time."""
    if not policies:
        return None
    local_now = _as_beijing_datetime(now)
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    candidates: list[datetime] = []
    for offset in range(8):
        current_day = day_start + timedelta(days=offset)
        for policy in policies:
            boundaries = _policy_boundaries(policy, current_day)
            if boundaries is not None:
                candidates.append(boundaries[0])
    future = [candidate for candidate in candidates if candidate > local_now]
    return min(future) if future else None


def seconds_until_lock_policy_boundary(
    policies: list[dict] | None, now: datetime | int | float | None = None
) -> float | None:
    """Return seconds until the next policy boundary, or ``None`` if absent."""
    boundary = next_lock_policy_boundary(policies, now)
    if boundary is None:
        return None
    return max(0.0, (boundary - _as_beijing_datetime(now)).total_seconds())


def lock_policy_limits(
    policies: list[dict] | None, fallback_limits: tuple[int, int], now: datetime | int | float | None = None
) -> tuple[int, int]:
    """Return effective ``(count, duration)`` limits at *now*."""
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
    """Yield effective policy changes in ``(start, end]`` across weekly policies."""
    if not policies:
        return
    local_start = _as_beijing_datetime(start)
    local_end = _as_beijing_datetime(end)
    if local_end <= local_start:
        return

    day_start = (local_start - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day_count = (local_end.date() - day_start.date()).days + 2
    candidates: set[datetime] = set()
    for offset in range(day_count):
        current_day = day_start + timedelta(days=offset)
        for policy in policies:
            boundaries = _policy_boundaries(policy, current_day)
            if boundaries is not None:
                candidates.update(boundaries)

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
    return next(iter_lock_policy_changes(policies, fallback_limits, current, current + timedelta(days=8)), None)


def policy_crossing_duration_limit(
    policies: list[dict] | None,
    fallback_limits: tuple[int, int],
    now: datetime | int | float,
    end_time: datetime | int | float,
) -> int | None:
    """Return the request limit before the next scheduled policy start.

    The next policy start is a boundary even if its limits are more permissive.
    Requests may use a short, two-hour grace period when that boundary is near.
    """
    current = _as_beijing_datetime(now)
    end_timestamp = _as_beijing_datetime(end_time).timestamp()
    if end_timestamp <= current.timestamp():
        return None
    boundary = next_lock_policy_start(policies, current)
    if boundary is None or boundary.timestamp() >= end_timestamp:
        return None
    until_boundary = max(0, int(boundary.timestamp() - current.timestamp()))
    allowed_duration = max(until_boundary, CROSS_POLICY_GRACE_DURATION)
    if end_timestamp - current.timestamp() > allowed_duration:
        return allowed_duration
    return None


def parse_quiet_hours(value: object) -> tuple[int, int] | None:
    """Parse a ``"HH:MM-HH:MM"`` quiet-hours window into ``(start_min, end_min)``.

    Returns ``None`` when disabled (empty/blank) or malformed, so callers can
    treat an unparsable config as "no suppression" rather than raising.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    parts = text.split("-")
    if len(parts) != 2:
        return None
    try:
        start = _parse_time(parts[0].strip(), "quiet_hours.start")
        end = _parse_time(parts[1].strip(), "quiet_hours.end")
    except LockPolicyValidationError:
        return None
    if start == end:
        return None
    return start, end


def in_quiet_hours(value: object, when: datetime | int | float | None = None) -> bool:
    """Return True when *when* (Beijing time) falls inside the quiet window.

    The window is half-open ``[start, end)`` and may wrap past midnight
    (e.g. ``"22:00-06:00"``).
    """
    window = parse_quiet_hours(value)
    if window is None:
        return False
    start, end = window
    local = _as_beijing_datetime(when)
    minute_of_day = local.hour * 60 + local.minute
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end
