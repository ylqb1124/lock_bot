"""Public report API coverage."""

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
        "summary": {"total_resources": 8, "unlocked_resources": 8, "free_resources": 8},
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
