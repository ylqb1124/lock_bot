"""Occupancy outbox persistence and idempotency tests."""

from lockbot.backend.app.bots import occupancy


def _event(event_id="event-1"):
    return {
        "event_id": event_id, "session_id": "session-1", "resource_type": "device",
        "node_key": "n1", "device_id": 2, "user_id": "u1", "lock_mode": "exclusive",
        "start_time": 1_000, "end_time": 1_120,
    }


def test_outbox_insert_is_idempotent(monkeypatch, db_session):
    monkeypatch.setattr(occupancy, "SessionLocal", lambda: db_session)
    event = _event()
    assert occupancy.record_occupancy_events(7, [event]) == {"event-1"}
    assert occupancy.record_occupancy_events(7, [event]) == {"event-1"}
    rows = db_session.query(occupancy.OccupancyRecord).all()
    assert len(rows) == 1
    assert rows[0].device_id == 2
    assert rows[0].duration_seconds == 120
