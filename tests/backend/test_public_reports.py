"""Public report API coverage."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch


def _sample_bot(name="report-bot"):
    return {
        "name": name,
        "bot_type": "DEVICE",
        "webhook_url": "https://example.com/webhook",
        "aes_key": "testaeskey",
        "token": "testtoken",
        "cluster_configs": {"node1": {"ip": "10.0.0.1", "devices": ["p800"] * 8}},
    }


def _snapshot(bot_id):
    return {
        "bot": {"id": bot_id, "name": "report-bot", "type": "DEVICE", "status": "running"},
        "generated_at": "2026-08-28T08:00:00+00:00",
        "summary": {
            "total_resources": 8,
            "unlocked_resources": 8,
            "available_resources": 8,
            "occupied_resources": 0,
            "free_resources": 8,
            "in_use_resources": 0,
            "utilization_threshold": 10,
            "memory_threshold": 10,
        },
        "nodes": [],
    }


def test_public_report_requires_no_login(client, admin_header, db_session):
    from lockbot.backend.app.bots.models import Bot

    created = client.post("/api/bots", json=_sample_bot(), headers=admin_header).json()
    bot = db_session.get(Bot, created["id"])
    bot.status = "running"
    db_session.commit()

    with patch("lockbot.backend.app.reports.router.report_snapshot_service.get_or_refresh") as refresh:
        refresh.return_value = (_snapshot(bot.id), True)
        response = client.get(f"/api/public/reports/{bot.id}")

    assert response.status_code == 200
    assert response.json()["cached"] is True
    assert response.json()["summary"]["total_resources"] == 8
    refresh.assert_called_once()
    assert refresh.call_args.kwargs == {"force": False}
    assert refresh.call_args.args[0].id == bot.id


def test_public_report_missing_bot_returns_404(client):
    assert client.get("/api/public/reports/99999").status_code == 404


def test_public_report_refresh_is_one_minute_cache(client, admin_header, db_session):
    from lockbot.backend.app.bots.models import Bot

    created = client.post("/api/bots", json=_sample_bot("report-refresh"), headers=admin_header).json()
    bot = db_session.get(Bot, created["id"])
    bot.status = "running"
    db_session.commit()

    with patch("lockbot.backend.app.reports.router.report_snapshot_service.get_or_refresh") as refresh:
        refresh.return_value = (_snapshot(bot.id), True)
        response = client.post(f"/api/public/reports/{bot.id}/refresh")

    assert response.status_code == 200
    assert response.json()["cache_seconds"] == 60
    # force=False is intentional: public callers may not bypass the one-minute guard.
    refresh.assert_called_once()
    assert refresh.call_args.kwargs == {"force": False}
    assert refresh.call_args.args[0].id == bot.id


def test_report_snapshot_separates_lock_occupancy_from_gpu_utilization():
    from lockbot.backend.app.reports.service import _build_snapshot
    from lockbot.core.xpu_collector import CardUsage, NodeUsage

    bot = SimpleNamespace(id=1, name="report-bot", bot_type="DEVICE", status="running")
    state = {
        "node27": [
            {"dev_id": 0, "dev_model": "p800", "status": "idle", "current_users": []},
            {
                "dev_id": 1,
                "dev_model": "p800",
                "status": "exclusive",
                "current_users": [{"user_id": "alice", "start_time": 0, "duration": 0}],
            },
        ]
    }
    usage = NodeUsage(
        util=45.0,
        mem=30.0,
        container="",
        per_card=[CardUsage(0.0, 20.0, "job"), CardUsage(0.0, 0.0, "")],
    )

    snapshot = _build_snapshot(bot, state, {}, {"node27": usage}, 10, 10, datetime.now(timezone.utc))

    assert snapshot["summary"]["available_resources"] == 1
    assert snapshot["summary"]["occupied_resources"] == 1
    assert snapshot["summary"]["in_use_resources"] == 1
    assert snapshot["nodes"][0]["devices"][0]["lock_status"] == "idle"
    assert snapshot["nodes"][0]["devices"][0]["usage_status"] == "in_use"


def test_report_snapshot_adds_report_only_test_occupancy_for_observed_usage():
    from lockbot.backend.app.reports.service import _build_snapshot
    from lockbot.core.xpu_collector import CardUsage, NodeUsage

    device_bot = SimpleNamespace(id=1, name="report-bot", bot_type="DEVICE", status="running")
    device_state = {"node27": [{"dev_id": 0, "dev_model": "p800", "status": "idle", "current_users": []}]}
    device_usage = NodeUsage(util=25.0, mem=20.0, container="", per_card=[CardUsage(5.0, 4.0, "job")])

    with patch("lockbot.backend.app.reports.service.REPORT_TEST_OCCUPANCY", True), patch(
        "lockbot.backend.app.reports.service.random.choice", return_value="test-alex"
    ), patch("lockbot.backend.app.reports.service.random.randint", return_value=7200):
        device_snapshot = _build_snapshot(
            device_bot,
            device_state,
            {},
            {"node27": device_usage},
            10,
            10,
            datetime.now(timezone.utc),
        )

    assert device_state["node27"][0]["status"] == "idle"
    assert device_snapshot["summary"]["occupied_resources"] == 1
    assert device_snapshot["nodes"][0]["devices"][0]["lock_status"] == "exclusive"
    assert device_snapshot["nodes"][0]["devices"][0]["users"] == [{"id": "test-alex", "remaining_seconds": 7200}]

    queue_bot = SimpleNamespace(id=2, name="queue-report", bot_type="QUEUE", status="running")
    queue_state = {"queue-a": {"status": "idle", "current_users": [], "booking_list": []}}
    queue_usage = NodeUsage(util=15.0, mem=0.0, container="", per_card=None)

    with patch("lockbot.backend.app.reports.service.REPORT_TEST_OCCUPANCY", True), patch(
        "lockbot.backend.app.reports.service.random.choice", side_effect=["test-alex", "test-blake"]
    ), patch("lockbot.backend.app.reports.service.random.randint", return_value=7200):
        queue_snapshot = _build_snapshot(
            queue_bot,
            queue_state,
            {},
            {"queue-a": queue_usage},
            10,
            10,
            datetime.now(timezone.utc),
        )

    queue_node = queue_snapshot["nodes"][0]
    assert queue_state["queue-a"]["status"] == "idle"
    assert queue_node["lock_status"] == "exclusive"
    assert queue_node["users"] == [{"id": "test-alex", "remaining_seconds": 7200}]
    assert queue_node["bookings"] == [{"id": "test-blake", "remaining_seconds": 7200}]
