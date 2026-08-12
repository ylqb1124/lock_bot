"""Occupancy outbox persistence and idempotency tests."""

from datetime import datetime, timezone

from lockbot.backend.app.bots import occupancy


def _event(event_id="event-1", **overrides):
    event = {
        "event_id": event_id,
        "session_id": "session-1",
        "resource_type": "device",
        "node_key": "n1",
        "device_id": 2,
        "user_id": "u1",
        "lock_mode": "exclusive",
        "start_time": 1_000,
        "end_time": 1_120,
    }
    event.update(overrides)
    return event


def test_outbox_insert_is_idempotent(monkeypatch, db_session):
    monkeypatch.setattr(occupancy, "SessionLocal", lambda: db_session)
    event = _event()
    assert occupancy.record_occupancy_events(7, [event]) == {"event-1"}
    assert occupancy.record_occupancy_events(7, [event]) == {"event-1"}
    rows = db_session.query(occupancy.OccupancyRecord).all()
    assert len(rows) == 1
    assert rows[0].device_id == 2
    assert rows[0].duration_seconds == 120


def test_outbox_stores_beijing_time_and_day_key(monkeypatch, db_session):
    monkeypatch.setattr(occupancy, "SessionLocal", lambda: db_session)
    start = int(datetime(2026, 7, 16, 23, 39, 13, tzinfo=timezone.utc).timestamp())
    end = int(datetime(2026, 7, 17, 5, 39, 13, tzinfo=timezone.utc).timestamp())

    assert occupancy.record_occupancy_events(7, [_event(start_time=start, end_time=end)]) == {"event-1"}

    row = db_session.query(occupancy.OccupancyRecord).one()
    assert row.start_time == datetime(2026, 7, 17, 7, 39, 13)
    assert row.end_time == datetime(2026, 7, 17, 13, 39, 13)
    assert row.day_key_cn == "2026-07-17"
    assert row.duration_seconds == 21_600


def test_query_occupancy_uses_beijing_day_overlap(monkeypatch, db_session):
    monkeypatch.setattr(occupancy, "SessionLocal", lambda: db_session)
    start = int(datetime(2026, 7, 16, 15, 30, tzinfo=timezone.utc).timestamp())
    end = int(datetime(2026, 7, 16, 17, 30, tzinfo=timezone.utc).timestamp())

    assert occupancy.record_occupancy_events(7, [_event(start_time=start, end_time=end)]) == {"event-1"}

    july_16 = occupancy.query_occupancy(7, date_str="2026-07-16")
    july_17 = occupancy.query_occupancy(7, date_str="2026-07-17")
    july_18 = occupancy.query_occupancy(7, date_str="2026-07-18")
    assert len(july_16) == 1
    assert len(july_17) == 1
    assert july_18 == []
    assert july_17[0]["start_time_cn"] == "2026-07-16T23:30:00"
    assert july_17[0]["end_time_cn"] == "2026-07-17T01:30:00"
