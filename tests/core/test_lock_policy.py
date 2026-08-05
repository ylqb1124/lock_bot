from datetime import datetime, timedelta, timezone

import pytest
from lockbot.core.config import Config, ConfigValidationError
from lockbot.core.lock_policy import (
    BEIJING_TZ,
    next_lock_policy_boundary,
    policy_crossing_duration_limit,
    resolve_lock_policy,
    validate_lock_policies,
)
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


def test_next_policy_boundary_uses_strictly_future_beijing_minute():
    policies = validate_lock_policies([_policy("08:00", "22:00")])
    at_boundary = datetime(2024, 1, 1, 8, 0, tzinfo=BEIJING_TZ)
    assert next_lock_policy_boundary(policies, at_boundary) == datetime(2024, 1, 1, 22, 0, tzinfo=BEIJING_TZ)
    before_boundary = datetime(2024, 1, 1, 7, 59, 30, tzinfo=BEIJING_TZ)
    assert next_lock_policy_boundary(policies, before_boundary) == datetime(2024, 1, 1, 8, 0, tzinfo=BEIJING_TZ)


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


def test_crossing_policy_duration_is_capped_but_two_hours_can_cross():
    policies = validate_lock_policies(
        [
            _policy("08:00", "22:00", count=2, duration=7200),
            _policy("22:00", "08:00", count=-1, duration=36000),
        ]
    )
    fallback = (16, -1)
    at_two = datetime(2024, 1, 1, 2, 0, tzinfo=BEIJING_TZ)
    assert policy_crossing_duration_limit(policies, fallback, at_two, at_two + timedelta(hours=10)) == 6 * 3600
    assert policy_crossing_duration_limit(policies, fallback, at_two, at_two + timedelta(hours=6)) is None

    at_seven = datetime(2024, 1, 1, 7, 0, tzinfo=BEIJING_TZ)
    assert policy_crossing_duration_limit(policies, fallback, at_seven, at_seven + timedelta(hours=2)) is None
    assert policy_crossing_duration_limit(policies, fallback, at_seven, at_seven + timedelta(hours=3)) == 3600


def test_crossing_policy_duration_handles_fallback_gap():
    policies = validate_lock_policies([_policy("08:00", "22:00", count=2, duration=7200)])
    fallback = (16, -1)
    in_gap = datetime(2024, 1, 1, 23, 0, tzinfo=BEIJING_TZ)
    next_morning = in_gap + timedelta(hours=10)
    assert policy_crossing_duration_limit(policies, fallback, in_gap, next_morning) == 9 * 3600


def test_node_lock_uses_cross_policy_duration_limit(tmp_path, monkeypatch):
    from lockbot.core import node_bot

    policies = [
        _policy("08:00", "22:00", count=2, duration=7200),
        _policy("22:00", "08:00", count=-1, duration=36000),
    ]
    bot = NodeBot(
        config_dict={
            "BOT_ID": "cross-policy-node",
            "DATA_DIR": str(tmp_path),
            "BOT_TYPE": "NODE",
            "CLUSTER_CONFIGS": ["node1"],
            "LOCK_POLICIES": policies,
            "MAX_LOCK_COUNT": 16,
            "MAX_LOCK_DURATION": -1,
        }
    )

    monkeypatch.setattr(
        node_bot.time,
        "time",
        lambda: datetime(2024, 1, 1, 2, 0, tzinfo=BEIJING_TZ).timestamp(),
    )
    rejected = bot.lock("u1", "lock node1 10h")
    assert "6.0 小时" in rejected["message"]["body"][0]["content"]

    monkeypatch.setattr(
        node_bot.time,
        "time",
        lambda: datetime(2024, 1, 1, 7, 0, tzinfo=BEIJING_TZ).timestamp(),
    )
    accepted = bot.lock("u1", "lock node1 2h")
    assert "资源申请成功" in accepted["message"]["body"][0]["content"]

    rejected_renewal = bot.lock("u1", "lock node1 3h")
    assert "2.0 小时" in rejected_renewal["message"]["body"][0]["content"]


def test_queue_book_uses_cross_policy_duration_limit(tmp_path, monkeypatch):
    from lockbot.core import queue_bot
    from lockbot.core.queue_bot import QueueBot

    bot = QueueBot(
        config_dict={
            "BOT_ID": "cross-policy-queue",
            "DATA_DIR": str(tmp_path),
            "BOT_TYPE": "QUEUE",
            "CLUSTER_CONFIGS": ["node1"],
            "LOCK_POLICIES": [
                _policy("08:00", "22:00", count=2, duration=7200),
                _policy("22:00", "08:00", count=-1, duration=36000),
            ],
            "MAX_LOCK_COUNT": 16,
            "MAX_LOCK_DURATION": -1,
        }
    )
    monkeypatch.setattr(
        queue_bot.time,
        "time",
        lambda: datetime(2024, 1, 1, 2, 0, tzinfo=BEIJING_TZ).timestamp(),
    )
    bot.lock("holder", "lock node1 2h")
    rejected = bot.book("u1", "book node1 10h")
    assert "6.0 小时" in rejected["message"]["body"][0]["content"]


def test_help_uses_current_lock_limits(tmp_path):
    bot = NodeBot(
        config_dict={
            "BOT_ID": "help-policy-test",
            "DATA_DIR": str(tmp_path),
            "BOT_TYPE": "NODE",
            "CLUSTER_CONFIGS": ["node1"],
        }
    )
    bot.config.get_lock_limits = lambda now=None: (2, 7200)
    content = bot.print_help("u1")["message"]["body"][0]["content"]
    assert "最多同时占用2台机器" in content
    assert "最长2.0 小时" in content


def test_policy_transition_notifies_each_group_once(tmp_path, monkeypatch):
    from lockbot.core import base_bot

    class RecordingAdapter:
        def __init__(self):
            self.replies = []
            self.sent = []

        def build_reply(self, content, user_ids, group_id=None, markdown=False):
            reply = {"content": content, "user_ids": user_ids, "group_id": group_id}
            self.replies.append(reply)
            return reply

        def send(self, reply):
            self.sent.append(reply)
            return []

    policies = [_policy("08:00", "09:00", count=2, duration=7200)]
    bot = NodeBot(
        config_dict={
            "BOT_ID": "policy-transition",
            "DATA_DIR": str(tmp_path),
            "BOT_TYPE": "NODE",
            "CLUSTER_CONFIGS": ["node1"],
            "MAX_LOCK_COUNT": 16,
            "MAX_LOCK_DURATION": -1,
            "LOCK_POLICIES": policies,
            "GROUP_ID": "group-b, group-a",
        }
    )
    adapter = RecordingAdapter()
    bot.adapter = adapter

    fallback = datetime(2024, 1, 1, 7, 59, tzinfo=BEIJING_TZ).timestamp()
    monkeypatch.setattr(base_bot.time, "time", lambda: fallback)
    bot._check_and_notify_lock_policy()  # Establish the initial baseline silently.
    assert adapter.sent == []

    active = datetime(2024, 1, 1, 8, 0, tzinfo=BEIJING_TZ).timestamp()
    monkeypatch.setattr(base_bot.time, "time", lambda: active)
    bot._check_and_notify_lock_policy()
    bot._check_and_notify_lock_policy()

    assert [message["group_id"] for message in adapter.sent] == ["group-a", "group-b"]
    assert all("策略转换：当前单用户最多可锁定/预约2台，最大时长2h" in message["content"] for message in adapter.sent)
