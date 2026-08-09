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


def _policy(start="08:00", end="22:00", count=2, duration=7200, weekdays=None):
    policy = {
        "start_time": start,
        "end_time": end,
        "max_lock_count": count,
        "max_lock_duration": duration,
    }
    if weekdays is not None:
        policy["weekdays"] = weekdays
    return policy


def test_policy_validation_supports_adjacent_and_overnight_ranges():
    policies = validate_lock_policies([_policy(), _policy("22:00", "08:00", -1, -1)])
    assert policies[0]["start_time"] == "08:00"
    assert policies[1]["max_lock_count"] == -1


def test_policy_validation_rejects_overlap_and_empty_ranges():
    with pytest.raises(ValueError, match="must not overlap"):
        validate_lock_policies([_policy(), _policy("20:00", "23:00")])
    with pytest.raises(ValueError, match="empty interval"):
        validate_lock_policies([_policy("08:00", "08:00")])


def test_policy_validation_allows_different_weekdays_and_checks_overnight_coverage():
    policies = validate_lock_policies(
        [
            _policy(weekdays=["sun", "sat"]),
            _policy(weekdays=["mon"]),
        ]
    )
    assert policies[0]["weekdays"] == ["sat", "sun"]

    with pytest.raises(ValueError, match="must not overlap"):
        validate_lock_policies(
            [
                _policy("22:00", "08:00", weekdays=["sun"]),
                _policy("06:00", "09:00", weekdays=["mon"]),
            ]
        )

    with pytest.raises(ValueError, match="non-empty list"):
        validate_lock_policies([_policy(weekdays=[])])


def test_policy_resolution_uses_beijing_time_and_fallback():
    policies = validate_lock_policies([_policy(), _policy("22:00", "08:00", -1, -1)])
    # 00:00 UTC is 08:00 Beijing, so the daytime policy is active.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, tzinfo=timezone.utc))["max_lock_count"] == 2
    # 15:00 UTC is 23:00 Beijing, so the overnight policy is active.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, 15, tzinfo=timezone.utc))["max_lock_count"] == -1
    # 07:00 Beijing is still inside the overnight policy.
    assert resolve_lock_policy(policies, datetime(2024, 1, 1, 7, tzinfo=BEIJING_TZ))["max_lock_count"] == -1
    assert resolve_lock_policy([_policy()], datetime(2024, 1, 1, 23, tzinfo=BEIJING_TZ)) is None


def test_policy_resolution_uses_selected_weekdays_and_overnight_start_day():
    policy = _policy("22:00", "08:00", count=-1, duration=-1, weekdays=["sun"])
    policies = validate_lock_policies([policy])
    assert resolve_lock_policy(policies, datetime(2024, 1, 7, 23, tzinfo=BEIJING_TZ)) is not None
    assert resolve_lock_policy(policies, datetime(2024, 1, 8, 7, tzinfo=BEIJING_TZ)) is not None
    assert resolve_lock_policy(policies, datetime(2024, 1, 8, 22, tzinfo=BEIJING_TZ)) is None


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


def test_crossing_policy_duration_keeps_two_hour_grace_at_a_stricter_boundary():
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
    assert policy_crossing_duration_limit(policies, fallback, at_seven, at_seven + timedelta(hours=3)) == 2 * 3600


def test_crossing_policy_duration_uses_two_hour_grace_when_boundary_is_near():
    policies = validate_lock_policies(
        [
            _policy("08:00", "16:00", count=2, duration=4 * 3600),
            _policy("16:00", "22:00", count=2, duration=2 * 3600),
        ]
    )
    at_fifteen_thirty = datetime(2024, 1, 1, 15, 30, tzinfo=BEIJING_TZ)
    assert (
        policy_crossing_duration_limit(
            policies, (16, -1), at_fifteen_thirty, at_fifteen_thirty + timedelta(hours=4)
        )
        == 2 * 3600
    )


def test_crossing_policy_duration_stops_at_next_start_even_when_it_is_more_permissive():
    policies = validate_lock_policies(
        [
            _policy("15:30", "16:00", count=3, duration=3 * 3600),
            _policy("18:00", "22:00", count=4, duration=6 * 3600),
        ]
    )
    at_fifteen_thirty = datetime(2024, 1, 1, 15, 30, tzinfo=BEIJING_TZ)
    assert (
        policy_crossing_duration_limit(
            policies, (16, -1), at_fifteen_thirty, at_fifteen_thirty + timedelta(hours=3)
        )
        == 2 * 3600 + 30 * 60
    )
    assert (
        policy_crossing_duration_limit(
            policies, (16, -1), at_fifteen_thirty, at_fifteen_thirty + timedelta(hours=2.5)
        )
        is None
    )


def test_sunday_lock_cannot_cross_into_monday_workday_policy():
    policies = validate_lock_policies(
        [
            _policy("00:00", "23:59", count=-1, duration=-1, weekdays=["sat", "sun"]),
            _policy("08:00", "22:00", count=2, duration=7200, weekdays=["mon", "tue", "wed", "thu", "fri"]),
        ]
    )
    sunday_evening = datetime(2024, 1, 7, 23, 0, tzinfo=BEIJING_TZ)
    assert (
        policy_crossing_duration_limit(policies, (16, -1), sunday_evening, sunday_evening + timedelta(hours=10))
        == 9 * 3600
    )


def test_crossing_policy_duration_skips_fallback_gap_before_next_policy():
    policies = validate_lock_policies(
        [
            _policy("10:00", "11:20", count=4, duration=36000),
            _policy("15:00", "22:00", count=2, duration=7200),
        ]
    )
    fallback = (16, 7200)
    at_ten_twenty = datetime(2024, 1, 1, 10, 20, tzinfo=BEIJING_TZ)

    # The fallback limit applies when a lock starts in the 11:20-15:00 gap,
    # but it must not cap a lock that began in the preceding scheduled period.
    assert (
        policy_crossing_duration_limit(policies, fallback, at_ten_twenty, at_ten_twenty + timedelta(hours=9))
        == 4 * 3600 + 40 * 60
    )


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
    assert "计算：取当前上限与跨策略上限的较小值" in rejected["message"]["body"][0]["content"]

    monkeypatch.setattr(
        node_bot.time,
        "time",
        lambda: datetime(2024, 1, 1, 7, 0, tzinfo=BEIJING_TZ).timestamp(),
    )
    accepted_at_boundary = bot.lock("u1", "lock node1 2h")
    assert "资源申请成功" in accepted_at_boundary["message"]["body"][0]["content"]

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
    assert "计算：取当前上限与跨策略上限的较小值" in rejected["message"]["body"][0]["content"]


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


def test_policy_preview_and_transition_notify_each_group_once(tmp_path, monkeypatch):
    from lockbot.core import base_bot

    class RecordingAdapter:
        def __init__(self):
            self.replies = []
            self.sent = []

        def build_reply(self, content, user_ids, group_id=None, markdown=False, at_all=False):
            reply = {"content": content, "user_ids": user_ids, "group_id": group_id, "at_all": at_all}
            self.replies.append(reply)
            return reply

        def send(self, reply):
            self.sent.append(reply)
            return [(200, '{"errcode": 0}')]

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
            "GROUP_ID": "2002, 1001",
        }
    )
    adapter = RecordingAdapter()
    bot.adapter = adapter

    fallback = datetime(2024, 1, 1, 6, 59, tzinfo=BEIJING_TZ).timestamp()
    monkeypatch.setattr(base_bot.time, "time", lambda: fallback)
    bot._check_and_notify_lock_policy()  # Establish the initial baseline silently.
    assert adapter.sent == []

    preview = datetime(2024, 1, 1, 7, 0, tzinfo=BEIJING_TZ).timestamp()
    monkeypatch.setattr(base_bot.time, "time", lambda: preview)
    bot._check_and_notify_lock_policy()
    assert [message["group_id"] for message in adapter.sent] == [1001, 2002]
    assert all("策略提醒：1小时后" in message["content"] for message in adapter.sent)

    active = datetime(2024, 1, 1, 8, 0, tzinfo=BEIJING_TZ).timestamp()
    monkeypatch.setattr(base_bot.time, "time", lambda: active)
    bot._check_and_notify_lock_policy()
    bot._check_and_notify_lock_policy()

    assert [message["group_id"] for message in adapter.sent] == [1001, 2002, 1001, 2002]
    assert all(message["at_all"] for message in adapter.sent)
    assert all(
        "策略转换：当前单用户最多可锁定/预约2台，最大时长2h" in message["content"]
        for message in adapter.sent[2:]
    )
