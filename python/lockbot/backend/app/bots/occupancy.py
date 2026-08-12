"""
Occupancy record model and service — tracks who occupied which node, when, and for how long.

Records are written when a lock is released (manual unlock, auto-expiry, or kickout).
Data older than 365 days is cleaned up automatically on each write.
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, Session, mapped_column

from lockbot.backend.app.database import Base, SessionLocal

logger = logging.getLogger(__name__)

# Number of days to retain occupancy records
RETENTION_DAYS = 365
CN_TZ = timezone(timedelta(hours=8))


def _epoch_to_cn_datetime(timestamp: int) -> datetime:
    """Convert epoch seconds to a Beijing-time datetime for storage."""
    return datetime.fromtimestamp(timestamp, tz=CN_TZ).replace(tzinfo=None)


def _cn_day_start(date_str: str) -> datetime | None:
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return None


class OccupancyRecord(Base):
    __tablename__ = "occupancy_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str | None] = mapped_column(String(80), unique=True, nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(32), index=True, nullable=True)
    resource_type: Mapped[str] = mapped_column(String(16), nullable=False, default="node")
    bot_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    node_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    device_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    lock_mode: Mapped[str] = mapped_column(String(16), nullable=False)  # exclusive | shared
    start_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    day_key_cn: Mapped[str | None] = mapped_column(String(10), index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)

    __table_args__ = (UniqueConstraint("event_id", name="uq_occupancy_event_id"), {"sqlite_autoincrement": True})


def record_occupancy(
    bot_id: int,
    node_key: str,
    user_id: str,
    start_time: int,
    end_time: int,
    lock_mode: str,
    *,
    event_id: str | None = None,
    session_id: str | None = None,
    resource_type: str = "node",
    device_id: int | None = None,
) -> None:
    """Write one occupancy record and lazily clean up expired records.

    All parameters are epoch seconds.  Failures are logged and never propagate.
    """
    try:
        db = SessionLocal()
        try:
            _cleanup_old_records(db, bot_id)
            start_time_cn = _epoch_to_cn_datetime(start_time)
            end_time_cn = _epoch_to_cn_datetime(end_time)
            record = OccupancyRecord(
                bot_id=bot_id,
                event_id=event_id,
                session_id=session_id,
                resource_type=resource_type,
                node_key=node_key,
                device_id=device_id,
                user_id=user_id,
                lock_mode=lock_mode,
                start_time=start_time_cn,
                end_time=end_time_cn,
                duration_seconds=max(0, end_time - start_time),
                day_key_cn=start_time_cn.date().isoformat(),
            )
            db.add(record)
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.warning(
            "Failed to record occupancy bot=%d node=%s user=%s",
            bot_id,
            node_key,
            user_id,
            exc_info=True,
        )


def record_occupancy_events(bot_id: int, events: list[dict]) -> set[str]:
    """Store outbox events idempotently; return event ids safely delivered."""
    delivered: set[str] = set()
    seen: set[str] = set()
    db = SessionLocal()
    try:
        for event in events:
            event_id = event["event_id"]
            if event_id in seen:
                continue
            seen.add(event_id)
            existing = db.query(OccupancyRecord.id).filter(OccupancyRecord.event_id == event_id).first()
            if existing:
                delivered.add(event_id)
                continue
            start_time_cn = _epoch_to_cn_datetime(event["start_time"])
            end_time_cn = _epoch_to_cn_datetime(event["end_time"])
            db.add(
                OccupancyRecord(
                    bot_id=bot_id,
                    event_id=event_id,
                    session_id=event["session_id"],
                    resource_type=event["resource_type"],
                    node_key=event["node_key"],
                    device_id=event.get("device_id"),
                    user_id=event["user_id"],
                    lock_mode=event["lock_mode"],
                    start_time=start_time_cn,
                    end_time=end_time_cn,
                    duration_seconds=max(0, event["end_time"] - event["start_time"]),
                    day_key_cn=start_time_cn.date().isoformat(),
                )
            )
            delivered.add(event_id)
        _cleanup_old_records(db, bot_id)
        db.commit()
        return delivered
    except Exception:
        db.rollback()
        logger.warning("Failed to flush occupancy outbox for bot=%d", bot_id, exc_info=True)
        return set()
    finally:
        db.close()


def _cleanup_old_records(db: Session, bot_id: int) -> None:
    """Delete occupancy records older than RETENTION_DAYS for a given bot."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=RETENTION_DAYS)
    try:
        db.query(OccupancyRecord).filter(
            OccupancyRecord.bot_id == bot_id,
            OccupancyRecord.created_at < cutoff,
        ).delete()
    except Exception:
        logger.warning("Failed to clean up old occupancy records", exc_info=True)


def query_occupancy(
    bot_id: int,
    date_str: str | None = None,
    node_key: str | None = None,
) -> list[dict]:
    """Query occupancy records for a bot on a given date (YYYY-MM-DD).

    Returns a list of dicts with keys:
        node_key, user_id, lock_mode, start_time, end_time, duration_seconds.
    """
    db = SessionLocal()
    try:
        q = db.query(OccupancyRecord).filter(OccupancyRecord.bot_id == bot_id)
        if date_str:
            day = _cn_day_start(date_str)
            if day is None:
                return []
            next_day = day + timedelta(days=1)
            q = q.filter(
                OccupancyRecord.start_time < next_day,
                OccupancyRecord.end_time > day,
            )
        if node_key:
            q = q.filter(OccupancyRecord.node_key == node_key)
        records = q.order_by(OccupancyRecord.start_time.asc()).all()
        return [
            {
                "node_key": r.node_key,
                "user_id": r.user_id,
                "lock_mode": r.lock_mode,
                "resource_type": r.resource_type,
                "device_id": r.device_id,
                "start_time": r.start_time.isoformat(),
                "end_time": r.end_time.isoformat(),
                "start_time_cn": r.start_time.isoformat(),
                "end_time_cn": r.end_time.isoformat(),
                "duration_seconds": r.duration_seconds,
                "day_key_cn": r.day_key_cn or r.start_time.date().isoformat(),
            }
            for r in records
        ]
    finally:
        db.close()
