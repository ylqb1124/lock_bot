"""Regression tests for durable, exact occupancy completion events."""

from unittest.mock import patch

from lockbot.core.device_bot import DeviceBot
from lockbot.core.node_bot import NodeBot
from lockbot.core.queue_bot import QueueBot


def _events(bot):
    received = []

    def flush(events):
        received.extend(events)
        return {event["event_id"] for event in events}

    bot._on_occupancy_flush = flush
    return received


def _config(tmp_path, bot_id, bot_type, cluster_configs):
    return {
        "BOT_ID": bot_id,
        "DATA_DIR": str(tmp_path),
        "BOT_TYPE": bot_type,
        "CLUSTER_CONFIGS": cluster_configs,
        "DEFAULT_DURATION": 3600,
        "MAX_LOCK_DURATION": 10800,
        "EARLY_NOTIFY": False,
        "TIME_ALERT": 300,
        "WEBHOOK_URL": "",
    }


def test_node_early_unlock_records_actual_duration(tmp_path):
    bot = NodeBot(_config(tmp_path, "node", "NODE", ["n1"]))
    events = []
    bot._on_occupancy_end = lambda *event: events.append(event)
    with patch("lockbot.core.node_bot.time.time", return_value=1_000):
        bot.lock("u1", "lock n1 2h")
    with patch("lockbot.core.node_bot.time.time", return_value=1_600):
        bot.unlock("u1", "unlock n1")
    assert len(events) == 1
    assert events[0][3] - events[0][2] == 600


def test_queue_booking_is_not_occupancy_and_take_ends_preempted_session(tmp_path):
    bot = QueueBot(_config(tmp_path, "queue", "QUEUE", ["n1"]))
    events = _events(bot)
    with patch("lockbot.core.queue_bot.time.time", return_value=1_000):
        bot.lock("holder", "lock n1 2h")
        bot.book("waiter", "book n1 1h")
    assert not events
    with patch("lockbot.core.queue_bot.time.time", return_value=1_300):
        bot.take("waiter", "take n1 1h")
    assert len(events) == 1
    assert events[0]["user_id"] == "holder"
    assert events[0]["end_time"] == 1_300
    assert "occupancy_session_id" not in bot.state.bot_state["n1"]["booking_list"][0]


def test_device_events_are_card_granular(tmp_path):
    bot = DeviceBot(_config(tmp_path, "device", "DEVICE", {"n1": ["A", "A"]}))
    events = _events(bot)
    with patch("lockbot.core.device_bot.time.time", return_value=1_000):
        bot.lock("u1", "lock n1 dev0,1 1h")
    with patch("lockbot.core.device_bot.time.time", return_value=1_120):
        bot.unlock("u1", "unlock n1 dev0,1")
    assert len(events) == 2
    assert {event["device_id"] for event in events} == {0, 1}
    assert {event["end_time"] - event["start_time"] for event in events} == {120}


def test_outbox_deduplicates_same_completed_session(tmp_path):
    bot = NodeBot(_config(tmp_path, "dedupe", "NODE", ["n1"]))
    info = {"user_id": "u1", "start_time": 1_000, "duration": 3_600}
    bot._start_occupancy(info)
    bot._record_occupancy_end("n1", info, "exclusive", ended_at=1_100)
    bot._record_occupancy_end("n1", info, "exclusive", ended_at=1_100)
    assert len(bot._pending_occupancy_events) == 1
