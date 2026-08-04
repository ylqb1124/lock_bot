from datetime import datetime, timezone

import pytest
from lockbot.core.config import Config, ConfigValidationError
from lockbot.core.lock_policy import BEIJING_TZ, resolve_lock_policy, validate_lock_policies
from lockbot.core.node_bot import NodeBot


def _policy(start="08:00", end="22:00", count=2, duration=7200):
    return {
        "start_time": start,
        "end_time": end,
        "max_lock_count": count,
        "max_lock_duration": duration,
    }


def test_policy_validation_supports_adjacent_and_overnight_ranges():
    policies = validate_lock_policies([_policy(), _policy("22:00", "08:00", -1, -1)])
    assert policies[0]["start_time"] == "08:00"
    assert policies[1]["max_lock_count"] == -1


def test_policy_validation_rejects_overlap_and_empty_ranges():
    with pytest.raises(ValueError, match="must not overlap"):
        validate_lock_policies([_policy(), _policy("20:00", "23:00")])
    with pytest.raises(ValueError, match="empty interval"):
        validate_lock_policies([_policy("08:00", "08:00")])


def test_policy_resolution_uses_beijing_time_and_fallback():
    policies = validate_lock_policies([_policy(), _policy("22:00", "08:00", -1, -1)])
    # 00:00 UTC is 08:00 Beijing, so the daytime policy is active.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, tzinfo=timezone.utc))["max_lock_count"] == 2
    # 15:00 UTC is 23:00 Beijing, so the overnight policy is active.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, 15, tzinfo=timezone.utc))["max_lock_count"] == -1
    # 07:00 Beijing is still inside the overnight policy.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, 7, tzinfo=BEIJING_TZ))["max_lock_count"] == -1
    assert resolve_lock_policy([_policy()], datetime(2024, 1, 1, 23, tzinfo=BEIJING_TZ)) is None


def test_config_uses_policy_limits_for_node_and_falls_back_for_device():
    policies = [_policy()]
    node_config = Config({"BOT_TYPE": "NODE", "LOCK_POLICIES": policies, "MAX_LOCK_COUNT": 16})
    assert node_config.get_lock_limits(datetime(2024, 1, 1, 12, tzinfo=timezone.utc)) == (2, 7200)
    assert node_config.get_lock_limits(datetime(2024, 1, 1, 23, tzinfo=timezone.utc)) == (16, -1)

    device_config = Config({"BOT_TYPE": "DEVICE", "LOCK_POLICIES": policies, "MAX_LOCK_COUNT": 16})
    assert device_config.get_lock_limits(datetime(2024, 1, 1, 12, tzinfo=timezone.utc)) == (16, -1)


def test_node_lock_uses_scheduled_count_and_duration(tmp_path, monkeypatch):
    fixed_timestamp = datetime(2024, 1, 1, 12, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr("lockbot.core.node_bot.time.time", lambda: fixed_timestamp)
    bot = NodeBot(
        config_dict={
            "BOT_ID": "policy-test",
            "DATA_DIR": str(tmp_path),
            "BOT_TYPE": "NODE",
            "CLUSTER_CONFIGS": ["node1", "node2"],
            "LOCK_POLICIES": [_policy(count=1, duration=1800)],
        }
    )
    bot.state.bot_state = {
        "node1": {"status": "idle", "current_users": [], "booking_list": []},
        "node2": {"status": "idle", "current_users": [], "booking_list": []},
    }

    assert "30 分钟" in bot.lock("u1", "lock node1 1h")["message"]["body"][0]["content"]
    assert "node1" in bot.lock("u1", "lock node1 30m")["message"]["body"][0]["content"]
    assert "最多同时" in bot.lock("u1", "lock node2 30m")["message"]["body"][0]["content"]


def test_config_rejects_invalid_policy():
    with pytest.raises(ConfigValidationError):
        Config({"LOCK_POLICIES": [{**_policy(), "max_lock_count": 0}]})
