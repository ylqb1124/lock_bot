import copy
import os
import time

import pytest
from lockbot.core.io import (
    create_or_load_node_state,
    log_to_file,
    save_bot_state_to_file,
)
from lockbot.core.queue_bot import QueueBot
from lockbot.core.utils import (
    format_duration,
)


def mock_user_info(user_id, duration_secs):
    """Create a user info dict with the given user_id and duration."""
    return {"user_id": user_id, "start_time": int(time.time()), "duration": duration_secs, "is_notified": False}


@pytest.fixture(autouse=True)
def bot(tmp_path):
    """Create an isolated QueueBot instance for testing."""
    test_bot_id = "test_queue_bot"
    data_dir = str(tmp_path)

    config_dict = {
        "BOT_ID": test_bot_id,
        "DATA_DIR": data_dir,
        "CLUSTER_CONFIGS": ["test"],
        "DEFAULT_DURATION": 3600,
        "MAX_LOCK_DURATION": 10800,
        "BOT_TYPE": "QUEUE",
        "WEBHOOK_URL": "",
        "EARLY_NOTIFY": False,
        "TIME_ALERT": 300,
    }

    bot = QueueBot(config_dict=config_dict)

    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [],
        }
    }

    yield bot


def test_parse_command(bot):
    """Test parse command."""
    ok, err, node, dur = bot.parse_command("user1", "lock", "lock test 2h", True)
    assert ok, f"解析命令失败: {err}"
    assert node == ["test"], f"Parsed node name incorrect, expected 'test', got {node}"
    assert dur == 7200, "Parsed duration incorrect"


def test_query(bot):
    """Test query."""
    result = bot.query("user1")
    assert "message" in result, "Missing 'message' field in result"
    assert "机器状态报告" in result["message"]["body"][0]["content"], "Missing usage description in query info"
    assert "test" in result["message"]["body"][0]["content"], "Missing node name in query info"


def test_query_collects_usage(bot, monkeypatch):
    """QUEUE inherits NODE's memory-based query: it SSH-collects GPU usage."""
    import lockbot.core.queue_bot as queue_bot_mod

    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1"})
    called = {"count": 0}

    def fake_collect(node_ips, config):
        called["count"] += 1
        return {}

    monkeypatch.setattr(queue_bot_mod, "collect_node_usage", fake_collect)
    bot.query("user1")
    assert called["count"] == 1


def test_lock_unlock(bot):
    """Test lock unlock."""
    reply = bot.lock("user1", "lock test 1h")
    assert "✅【资源申请成功】" in reply["message"]["body"][0]["content"], "Failed to lock resource"

    reply2 = bot.unlock("user1", "unlock test")
    assert "✅【资源释放成功】" in reply2["message"]["body"][0]["content"], "Failed to release resource"


def test_unlock_all(bot):
    """Test unlock all."""
    bot.lock("user1", "lock test 1h")
    reply = bot.unlock("user1", "unlock")
    assert "✅【资源释放成功】" in reply["message"]["body"][0]["content"], "Failed to release all resources"


def test_unlock_all_after_book(bot):
    """Test unlock all after book (booking a busy node, then free to cancel)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])

    # Occupy the node first so user1's book enqueues instead of direct-locking.
    bot.lock("holder", "lock test 1h")

    reply_book = bot.book("user1", "book test 1h")
    assert "🗓️【排队成功】" in reply_book["message"]["body"][0]["content"], "Failed to queue"

    reply_unlock = bot.unlock("user1", "unlock")
    assert "✅【资源释放成功】" in reply_unlock["message"]["body"][0]["content"], "Failed to release all resources"

    node_status = bot.state.bot_state.get("test", {})
    assert all(user["user_id"] != "user1" for user in node_status.get("booking_list", [])), "User still in booking list"


def test_book_multiple_nodes(bot):
    """Test book multiple nodes (both busy → both enqueued)."""
    bot.config.set_val(
        "CLUSTER_CONFIGS",
        {
            "node1": "Node One",
            "node2": "Node Two",
            "node3": "Node Three",
        },
    )

    now = int(time.time())
    # node1/node2 already held by others so user1's book enqueues on both.
    bot.state.bot_state = {
        "node1": {
            "status": "exclusive",
            "current_users": [{"user_id": "holder1", "start_time": now, "duration": 3600, "is_notified": False}],
            "booking_list": [],
        },
        "node2": {
            "status": "exclusive",
            "current_users": [{"user_id": "holder2", "start_time": now, "duration": 3600, "is_notified": False}],
            "booking_list": [],
        },
        "node3": {
            "status": "idle",
            "current_users": [],
            "booking_list": [],
        },
    }

    command = "book node1，node2 1h"
    reply = bot.book("user1", command)

    for node_key in ["node1", "node2"]:
        booking_list = bot.state.bot_state[node_key]["booking_list"]
        assert any(user["user_id"] == "user1" for user in booking_list), f"user1 应该在 {node_key} 的排队列表中"

    assert "🗓️【排队成功】" in reply["message"]["body"][0]["content"], "Failed to queue or wrong prompt"


def test_free_cancels_booking(bot):
    """Test free cancels booking."""
    bot.lock("user1", "lock test 1h")
    reply_book = bot.book("user2", "book test 2h")
    assert "排队成功" in reply_book["message"]["body"][0]["content"], "Failed to queue"

    reply_free = bot.unlock("user2", "free test")

    assert "✅【资源释放成功】" in reply_free["message"]["body"][0]["content"], "Failed to cancel booking"

    node_state = bot.state.bot_state["test"]
    assert len(node_state["booking_list"]) == 0, "free 后 booking_list 未清空"

    assert len(node_state["current_users"]) == 1 and node_state["current_users"][0]["user_id"] == "user1", (
        "free 不应影响当前锁定的用户"
    )


def test_lock_then_book(bot):
    """Test lock then book."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    user = {"user_id": "user1", "start_time": int(time.time()) - 5000, "duration": 3600, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user)],
            "booking_list": [],
        }
    }

    reply = bot.lock("user2", "lock test 1h")
    assert "❌" in reply["message"]["body"][0]["content"], "Should reject duplicate lock"

    reply2 = bot.book("user2", "book test 1h")
    assert "🗓️【排队成功】" in reply2["message"]["body"][0]["content"], (
        f"应允许排队, 但是显示{reply2['message']['body'][0]['content']}"
    )

    reply3 = bot.book("user3", "book test 1h")
    assert "🗓️【排队成功】" in reply3["message"]["body"][0]["content"], (
        f"应允许排队, 但是显示{reply3['message']['body'][0]['content']}"
    )


def test_lock_reject_shows_only_requested_nodes(bot):
    """Queue lock rejection should not dump unrelated cluster usage."""
    bot.config.set_val("CLUSTER_CONFIGS", ["node1", "node2"])
    now = int(time.time())
    bot.state.bot_state = {
        "node1": {
            "status": "exclusive",
            "current_users": [{"user_id": "holder1", "start_time": now, "duration": 3600, "is_notified": False}],
            "booking_list": [
                {"user_id": "queued1", "start_time": now, "duration": 1800, "is_notified": False},
            ],
        },
        "node2": {
            "status": "exclusive",
            "current_users": [{"user_id": "holder2", "start_time": now, "duration": 3600, "is_notified": False}],
            "booking_list": [],
        },
    }

    reply = bot.lock("user2", "lock node1 1h")
    content = reply["message"]["body"][0]["content"]

    assert "节点正在被他人使用" in content
    assert "node1" in content
    assert "holder1" in content
    assert "queued1" in content
    assert "node2" not in content
    assert "holder2" not in content


def test_forbid_duplicate_book(bot):
    """Test forbid duplicate book."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    user = {"user_id": "user1", "start_time": int(time.time()) - 5000, "duration": 3600, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [copy.deepcopy(user)],
        }
    }

    reply = bot.book("user1", "book test 1h")
    assert "❌" in reply["message"]["body"][0]["content"], "Should reject duplicate booking"

    reply2 = bot.book("user2", "book test 1h")
    assert "🗓️【排队成功】" in reply2["message"]["body"][0]["content"], (
        f"不同用户应允许排队, 但是显示{reply2['message']['body'][0]['content']}"
    )


def test_locked_user_cannot_book_again(bot):
    """Test locked user cannot book again."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])

    locked_user = {"user_id": "user1", "start_time": int(time.time()) - 5000, "duration": 3600, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(locked_user)],
            "booking_list": [],
        }
    }

    reply = bot.book("user1", "book test 1h")
    assert "❌" in reply["message"]["body"][0]["content"], "User who locked node should not book again"

    reply2 = bot.book("user2", "book test 1h")
    assert "🗓️【排队成功】" in reply2["message"]["body"][0]["content"], "Other users should be able to book"


def test_forbid_relock_default_rejects_relock(bot):
    """FORBID_RELOCK defaults to True: the current holder cannot re-lock (续锁) the same node."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    assert bot.config.get_val("FORBID_RELOCK") is True, "FORBID_RELOCK should default to True"

    now = int(time.time())
    holder = {"user_id": "user1", "start_time": now - 100, "duration": 3600, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(holder)],
            "booking_list": [],
        }
    }

    reply = bot.lock("user1", "lock test 1h")
    assert "❌" in reply["message"]["body"][0]["content"], "Re-lock should be rejected when FORBID_RELOCK is on"
    assert "续锁" in reply["message"]["body"][0]["content"], "Should surface the relock_forbidden message"

    # State untouched: still one holder, no accumulation.
    node = bot.state.bot_state["test"]
    assert len(node["current_users"]) == 1 and node["current_users"][0]["user_id"] == "user1"


def test_allow_multi_lock_default_still_allows_multiple_targets(bot):
    """ALLOW_MULTI_LOCK defaults to True, so a single queue command may target multiple nodes."""
    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1", "test2": "10.0.0.2"})
    bot.state.bot_state["test2"] = {"status": "idle", "current_users": [], "booking_list": []}

    reply = bot.lock("user1", "lock test,test2 1h")
    content = reply["message"]["body"][0]["content"]
    assert "✅【资源申请成功】" in content or "🗓️【排队成功】" in content


def test_disallow_multi_lock_rejects_multiple_targets(bot):
    """ALLOW_MULTI_LOCK=False rejects locking multiple queue nodes in one command."""
    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1", "test2": "10.0.0.2"})
    bot.config.set_val("ALLOW_MULTI_LOCK", False)
    bot.state.bot_state["test2"] = {"status": "idle", "current_users": [], "booking_list": []}

    reply = bot.lock("user1", "lock test,test2 1h")
    content = reply["message"]["body"][0]["content"]
    assert "不能一次性lock多台机器" in content


def test_disallow_multi_lock_rejects_second_machine(bot):
    """ALLOW_MULTI_LOCK=False rejects locking another queue node after one is already held."""
    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1", "test2": "10.0.0.2"})
    bot.config.set_val("ALLOW_MULTI_LOCK", False)
    bot.state.bot_state["test2"] = {"status": "idle", "current_users": [], "booking_list": []}

    first = bot.lock("user1", "lock test 1h")
    assert (
        "✅【资源申请成功】" in first["message"]["body"][0]["content"]
        or "🗓️【排队成功】" in first["message"]["body"][0]["content"]
    )

    reply = bot.lock("user1", "lock test2 1h")
    content = reply["message"]["body"][0]["content"]
    assert "不能一次性lock多台机器" in content


def test_disallow_multi_lock_rejects_booking_multiple_nodes(bot):
    """ALLOW_MULTI_LOCK=False rejects booking multiple nodes in one command."""
    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1", "test2": "10.0.0.2"})
    bot.config.set_val("ALLOW_MULTI_LOCK", False)
    bot.state.bot_state = {
        node_key: {
            "status": "exclusive",
            "current_users": [mock_user_info(f"holder-{node_key}", 3600)],
            "booking_list": [],
        }
        for node_key in ("test", "test2")
    }

    reply = bot.book("user1", "book test,test2 1h")

    assert "不能一次性lock多台机器" in reply["message"]["body"][0]["content"]
    assert all(not node["booking_list"] for node in bot.state.bot_state.values())


def test_disallow_multi_lock_rejects_booking_a_second_node(bot):
    """ALLOW_MULTI_LOCK=False treats an existing booking as a node claim."""
    bot.config.set_val("CLUSTER_CONFIGS", {"test": "10.0.0.1", "test2": "10.0.0.2"})
    bot.config.set_val("ALLOW_MULTI_LOCK", False)
    bot.state.bot_state["test"] = {
        "status": "exclusive",
        "current_users": [mock_user_info("holder-test", 3600)],
        "booking_list": [],
    }
    bot.state.bot_state["test2"] = {
        "status": "exclusive",
        "current_users": [mock_user_info("holder-test2", 3600)],
        "booking_list": [],
    }

    first = bot.book("user1", "book test 1h")
    assert "🗓️【排队成功】" in first["message"]["body"][0]["content"]

    reply = bot.book("user1", "book test2 1h")

    assert "不能一次性lock多台机器" in reply["message"]["body"][0]["content"]
    assert not bot.state.bot_state["test2"]["booking_list"]


def test_forbid_relock_off_allows_relock(bot):
    """FORBID_RELOCK=False restores the legacy behaviour: the holder may extend (续锁)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.config.set_val("FORBID_RELOCK", False)

    now = int(time.time())
    holder = {"user_id": "user1", "start_time": now - 100, "duration": 1800, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(holder)],
            "booking_list": [],
        }
    }

    reply = bot.lock("user1", "lock test 1h")
    assert "✅【资源申请成功】" in reply["message"]["body"][0]["content"], (
        "Re-lock should succeed when FORBID_RELOCK is off"
    )


def test_forbid_relock_default_rejects_holder_book(bot):
    """FORBID_RELOCK default True: the current holder cannot book its own next slot."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])

    now = int(time.time())
    holder = {"user_id": "user1", "start_time": now - 100, "duration": 3600, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(holder)],
            "booking_list": [],
        }
    }

    reply = bot.book("user1", "book test 1h")
    assert "❌" in reply["message"]["body"][0]["content"], "Holder book should be rejected when FORBID_RELOCK is on"
    assert len(bot.state.bot_state["test"]["booking_list"]) == 0, "Rejected book must not enqueue the holder"


def test_forbid_relock_off_allows_holder_book(bot):
    """FORBID_RELOCK=False: the holder may book its own next slot (enqueued)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.config.set_val("FORBID_RELOCK", False)

    now = int(time.time())
    holder = {"user_id": "user1", "start_time": now - 100, "duration": 3600, "is_notified": False}
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(holder)],
            "booking_list": [],
        }
    }

    reply = bot.book("user1", "book test 1h")
    assert "🗓️【排队成功】" in reply["message"]["body"][0]["content"], "Holder book should be allowed when off"
    booking_ids = [u["user_id"] for u in bot.state.bot_state["test"]["booking_list"]]
    assert booking_ids == ["user1"], "Holder should be enqueued for the next slot"


def test_head_of_queue_lock_is_promotion_not_relock(bot):
    """A head-of-queue booking user locking the idle node is promotion, allowed even with FORBID_RELOCK on."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    assert bot.config.get_val("FORBID_RELOCK") is True

    now = int(time.time())
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [
                {"user_id": "user2", "start_time": now, "duration": 3600, "is_notified": False},
            ],
        }
    }

    # user2 is NOT a current holder — locking here is promotion, must not be blocked.
    reply = bot.lock("user2", "lock test 1h")
    assert "✅【资源申请成功】" in reply["message"]["body"][0]["content"], "Head-of-queue lock (promotion) must succeed"

    node = bot.state.bot_state["test"]
    assert node["status"] == "exclusive" and node["current_users"][0]["user_id"] == "user2"
    assert len(node["booking_list"]) == 0, "Promoted user should leave the booking list"


def test_book_mixed_idle_and_busy_nodes(bot):
    """book across a free node and a busy node: free one locks directly, busy one enqueues."""
    bot.config.set_val("CLUSTER_CONFIGS", {"free": "Free", "busy": "Busy"})

    now = int(time.time())
    bot.state.bot_state = {
        "free": {"status": "idle", "current_users": [], "booking_list": []},
        "busy": {
            "status": "exclusive",
            "current_users": [{"user_id": "holder", "start_time": now, "duration": 3600, "is_notified": False}],
            "booking_list": [],
        },
    }

    reply = bot.book("user1", "book free，busy 1h")
    content = reply["message"]["body"][0]["content"]
    assert "✅【资源申请成功】" in content and "🗓️【排队成功】" in content, f"Mixed book reply incorrect: {content}"

    free_node = bot.state.bot_state["free"]
    assert free_node["status"] == "exclusive" and free_node["current_users"][0]["user_id"] == "user1", (
        "Free node should be directly locked"
    )
    busy_node = bot.state.bot_state["busy"]
    assert any(u["user_id"] == "user1" for u in busy_node["booking_list"]), "Busy node should enqueue the user"


def test_current_usage_display(bot):
    """Test current usage display."""
    bot.state.bot_state = {"test": {"status": "idle", "current_users": [], "booking_list": []}}

    output = bot._current_usage()
    assert "空闲" in output, f"空闲节点显示异常：{output}"
    assert "排队" not in output, f"空闲节点不应显示排队：{output}"

    bot.lock("user1", "lock test 1h")
    output = bot._current_usage()
    assert "user1" in output and "小时" in output, f"锁定用户未显示或时间显示异常：{output}"
    assert "排队" not in output, f"无人排队时不应显示排队：{output}"

    bot.book("user2", "book test 1h")
    output = bot._current_usage()
    assert "⌛️ 排队" in output, f"有排队用户时应显示排队区块：{output}"
    assert "user2" in output, f"排队用户未显示：{output}"

    bot.unlock("user1", "unlock test")
    output = bot._current_usage()
    assert "空闲" in output, f"解锁后应显示空闲：{output}"
    assert "user2" in output and "⌛️ 排队" in output, f"排队用户未显示或排队区块缺失：{output}"

    bot.book("user3", "book test 2h")
    bot.book("user4", "book test 3h")
    output = bot._current_usage()
    assert all(uid in output for uid in ["user2", "user3", "user4"]), f"多用户排队显示异常：{output}"

    pos2, pos3 = output.find("user2"), output.find("user3")
    assert 0 <= pos2 < pos3, f"排队顺序显示错误：{output}"

    print("✅ 所有节点状态显示测试通过")


def test_book_when_no_lock(bot):
    """book on an idle node with no queue == direct lock."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [],
        }
    }

    # user1 book on a free node → locked directly, not enqueued
    reply = bot.book("user1", "book test 1h")
    assert "✅【资源申请成功】" in reply["message"]["body"][0]["content"], (
        "Booking an idle node should lock it directly"
    )

    node = bot.state.bot_state["test"]
    assert node["status"] == "exclusive", "Node should be exclusive after direct lock"
    assert len(node["current_users"]) == 1 and node["current_users"][0]["user_id"] == "user1", (
        "user1 should be the current holder"
    )
    assert len(node["booking_list"]) == 0, "booking_list should stay empty on direct lock"


def test_lock_when_free_or_first_in_queue(bot):
    """Test lock when free or first in queue."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [],
        }
    }

    reply = bot.lock("user1", "lock test 1h")
    assert "✅【资源申请成功】" in reply["message"]["body"][0]["content"], "Should lock directly when idle"

    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [
                {"user_id": "user2", "start_time": int(time.time()), "duration": 3600, "is_notified": False}
            ],
        }
    }

    reply2 = bot.lock("user2", "lock test 1h")
    assert "✅【资源申请成功】" in reply2["message"]["body"][0]["content"], "First in queue should be able to lock"


def test_extend_lock_should_notify_waiting_users(bot):
    """Test extend lock should notify waiting users (requires FORBID_RELOCK off)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.config.set_val("FORBID_RELOCK", False)
    now = int(time.time())
    user_lock = {"user_id": "user1", "start_time": now - 1800, "duration": 3600, "is_notified": False}
    booking_users = [
        {"user_id": "user2", "start_time": now - 100, "duration": 1800, "is_notified": False},
        {"user_id": "user3", "start_time": now - 50, "duration": 1800, "is_notified": False},
    ]
    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user_lock)],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.lock("user1", "lock test 2h")

    assert (
        "✅【资源申请成功】" in reply["message"]["body"][0]["content"]
        and "请注意等待时间已增加" in reply["message"]["body"][0]["content"]
    ), "应提示延长成功"

    notified_users = set(reply["message"]["body"][1]["atuserids"])
    expected_users = {"user1", "user2", "user3"}
    assert notified_users == expected_users, f"应通知排队用户 {expected_users}，实际 {notified_users}"


def test_first_booking_user_lock_with_larger_duration_notifies_others(bot):
    """Test first booking user lock with larger duration notifies others."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    booking_users = [
        {"user_id": "user1", "start_time": now - 10, "duration": 300, "is_notified": True},
        {"user_id": "user2", "start_time": now - 5, "duration": 300, "is_notified": False},
        {"user_id": "user3", "start_time": now - 2, "duration": 300, "is_notified": False},
    ]
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.lock("user1", "lock test 15m")  # 15m = 900s

    assert "✅" in reply["message"]["body"][0]["content"], "lock 应成功"
    notified_users = set(reply["message"]["body"][1]["atuserids"])
    expected_users = {"user1", "user2", "user3"}
    assert notified_users == expected_users, f"应通知排队用户 {expected_users}，实际 {notified_users}"


def test_first_booking_user_lock_within_booking_duration_no_notify(bot):
    """Test first booking user lock within booking duration no notify."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    booking_users = [
        {"user_id": "user1", "start_time": now - 10, "duration": 600, "is_notified": True},
        {"user_id": "user2", "start_time": now - 5, "duration": 600, "is_notified": False},
        {"user_id": "user3", "start_time": now - 2, "duration": 600, "is_notified": False},
    ]
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.lock("user1", "lock test 5m")  # 5m = 300s

    assert "✅" in reply["message"]["body"][0]["content"], "lock 应成功"
    notified = set(reply["message"]["body"][1]["atuserids"])
    assert not ({"user2", "user3"} & notified), f"不应通知其它排队用户，实际通知：{notified}"


def test_lock_without_duration_uses_booking_duration_and_behaves_accordingly(bot):
    """Test lock without duration uses booking duration and behaves accordingly."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    booking_users = [
        {"user_id": "user1", "start_time": now - 10, "duration": 300, "is_notified": True},
        {"user_id": "user2", "start_time": now - 5, "duration": 300, "is_notified": False},
    ]
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.lock("user1", "lock test")

    assert "✅" in reply["message"]["body"][0]["content"], "lock 应成功"

    assert "5 分钟" in reply["message"]["body"][0]["content"], "Duration should be 5m"
    notified = set(reply["message"]["body"][1]["atuserids"])
    assert "user2" not in notified, f"不应通知 user2，实际通知：{notified}, {reply['message']['body'][0]['content']}"


def test_take_when_no_lock_succeeds_and_notify_all(bot):
    """Test take when no lock succeeds and notify all."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    booking_users = [
        {"user_id": "user2", "start_time": now - 100, "duration": 1800, "is_notified": False},
        {"user_id": "user3", "start_time": now - 50, "duration": 1800, "is_notified": False},
    ]

    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.take("user1", "take test")

    assert "🏁【资源抢占成功】" in reply["message"]["body"][0]["content"], "Take should succeed"

    notified = set(reply["message"]["body"][1]["atuserids"])
    expected = {"user1", "user2", "user3"}
    assert notified == expected, f"应通知抢占者和所有排队用户，实际通知: {notified}"

    current_users = bot.state.bot_state["test"]["current_users"]
    assert any(u["user_id"] == "user1" for u in current_users), "Take user should become current user"


def test_take_removes_self_from_booking_list_and_notify(bot):
    """Test take removes self from booking list and notify."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    booking_users = [
        {"user_id": "user1", "start_time": now - 200, "duration": 1800, "is_notified": False},
        {"user_id": "user2", "start_time": now - 100, "duration": 1800, "is_notified": False},
    ]

    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.take("user1", "take test")

    current_users = bot.state.bot_state["test"]["current_users"]
    assert any(u["user_id"] == "user1" for u in current_users), "Take user should become current user"

    booking_list = bot.state.bot_state["test"]["booking_list"]
    assert all(u["user_id"] != "user1" for u in booking_list), "Take user should be removed from booking list"

    notified = set(reply["message"]["body"][1]["atuserids"])
    expected = {u["user_id"] for u in booking_list}.union({"user1"})
    assert notified == expected, f"应通知剩余排队用户，实际通知: {notified}"


def test_take_when_lock_exists_preempt_and_notify(bot):
    """Test take when lock exists preempt and notify."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    now = int(time.time())

    current_user = {"user_id": "user0", "start_time": now - 900, "duration": 3600, "is_notified": False}
    booking_users = [
        {"user_id": "user2", "start_time": now - 100, "duration": 1800, "is_notified": False},
        {"user_id": "user3", "start_time": now - 50, "duration": 1800, "is_notified": False},
    ]

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(current_user)],
            "booking_list": copy.deepcopy(booking_users),
        }
    }

    reply = bot.take("user1", "take test")

    booking_list = bot.state.bot_state["test"]["booking_list"]
    first_booking = booking_list[0]
    remaining = current_user["duration"] - (now - current_user["start_time"])
    assert first_booking["user_id"] == current_user["user_id"], f"原锁定人应排队最前 {booking_list}"
    assert abs(first_booking["duration"] - remaining) < 5, (
        f"剩余时间应更新，期待约{remaining}，实际{first_booking['duration']}"
    )

    current_users = bot.state.bot_state["test"]["current_users"]
    assert len(current_users) == 1 and current_users[0]["user_id"] == "user1", "Take user should become current user"

    notified = set(reply["message"]["body"][1]["atuserids"])
    expected = {current_user["user_id"]} | {u["user_id"] for u in booking_list} | {"user1"}
    assert notified == expected, f"应通知锁定人和所有排队用户，实际通知: {notified}"


def test_locked_user_cannot_take(bot):
    """Test locked user cannot take."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])

    locked_user = {"user_id": "user1", "start_time": int(time.time()) - 5000, "duration": 3600, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(locked_user)],
            "booking_list": [],
        }
    }

    reply = bot.take("user1", "take test")
    assert "❌" in reply["message"]["body"][0]["content"], "User who already locked should not be allowed to take again"

    reply2 = bot.take("user2", "take test")
    assert "🏁【资源抢占成功】" in reply2["message"]["body"][0]["content"], "Other users should be able to take"


def test_kickout(bot):
    """Test kickout."""
    bot.lock("user1", "lock test 1h")
    reply = bot.kickout("admin", "kickout test")
    assert "✅【资源强制释放成功】by admin" in reply["message"]["body"][0]["content"], (
        "Failed to force release resource"
    )

    reply = bot.lock("admin", "lock test")
    assert "admin" in reply["message"]["body"][1]["atuserids"]
    assert "user1" not in reply["message"]["body"][1]["atuserids"]


def test_kickout_clears_booking_and_notifies_all(bot):
    """Test kickout clears booking and notifies all."""

    bot.lock("user1", "lock test 1h")
    bot.book("user2", "book test 1h")
    bot.book("user3", "book test 2h")

    state_before = bot.state.bot_state["test"]
    assert state_before["status"] != "idle"
    assert len(state_before["current_users"]) == 1
    assert len(state_before["booking_list"]) == 2

    reply = bot.kickout("admin", "kickout test")

    assert "✅【资源强制释放成功】by admin" in reply["message"]["body"][0]["content"], "kickout 未成功执行"

    atusers = set(reply["message"]["body"][1]["atuserids"])
    expected_users = {"admin", "user1", "user2", "user3"}
    assert atusers == expected_users, f"通知用户不正确: {atusers} != {expected_users}"

    state_after = bot.state.bot_state["test"]
    assert state_after["status"] == "idle", "kickout 后节点仍处于占用状态"
    assert len(state_after["current_users"]) == 0, "kickout 后 current_users 未清空"
    assert len(state_after["booking_list"]) == 0, "kickout 后 booking_list 未清空"


def test_kicklock(bot):
    """Test kicklock."""
    bot.lock("user1", "lock test 1h")
    bot.book("user2", "book test 1h")
    bot.book("user3", "book test 2h")

    state_before = bot.state.bot_state["test"]
    assert state_before["status"] != "idle", "Initial in_use should be True"
    assert len(state_before["current_users"]) == 1, "Initial current_users should be 1"
    assert len(state_before["booking_list"]) == 2, "Initial booking_list should be 2"

    reply = bot.kicklock("admin", "kicklock test")

    assert "✅【锁定已清空】by admin" in reply["message"]["body"][0]["content"], "kicklock 未成功执行"

    atusers = set(reply["message"]["body"][1]["atuserids"])
    expected_users = {"admin", "user1"}
    assert atusers == expected_users, f"通知用户不正确: {atusers} != {expected_users}"

    state_after = bot.state.bot_state["test"]
    assert state_after["status"] == "idle", "kicklock 后节点应为空闲状态"
    assert len(state_after["current_users"]) == 0, "kicklock 后 current_users 应被清空"
    assert len(state_after["booking_list"]) == 2, "kicklock 不应清空 booking_list"

    booking_users = [u["user_id"] for u in state_after["booking_list"]]
    assert booking_users == ["user2", "user3"], f"排队顺序被修改: {booking_users}"


def test_show_error(bot):
    """Test show error."""
    msg = bot.show_error("user1", "错误信息")
    assert "❌错误信息" in msg["message"]["body"][0]["content"], "Error message displayed incorrectly"


def test_print_help(bot):
    """Test print help."""
    msg = bot.print_help("user1")
    content = msg["message"]["body"][0]["content"]
    assert "📖【使用方法】" in content, "Help message displayed incorrectly"
    assert "当前使用者不可续锁或预约同一节点" in content
    assert "队首会在节点空闲时自动锁定" in content
    assert "slock" not in content
    assert "lock、book 或 take 的时长不能超过3.0 小时" in content


def test_print_help_respects_queue_notification_and_relock_config(bot):
    bot.config.set_val("EARLY_NOTIFY", True)
    bot.config.set_val("TIME_ALERT", 15 * 60)
    bot.config.set_val("FORBID_RELOCK", False)

    content = bot.print_help("user1")["message"]["body"][0]["content"]

    assert "当时间剩余15 分钟,会提醒一次" in content
    assert "资源时间用时耗尽后,会进行提醒" not in content
    assert "重复lock会增加时长" in content


def test_timer_routine_trigger(bot, monkeypatch):
    """Test timer routine trigger."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    user = {"user_id": "user1", "start_time": int(time.time()) - 5000, "duration": 3600, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user)],
            "booking_list": [],
        }
    }

    sent_payload = {}

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert "user1" in sent_payload["json"]["message"]["body"][1]["atuserids"], "Missing user ID in notification"
    assert "释放" in sent_payload["json"]["message"]["body"][0]["content"], "Missing release prompt in notification"


def test_timer_routine_no_trigger(bot, monkeypatch):
    """Test timer routine no trigger."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    now = int(time.time())
    duration = 3600
    user = {"user_id": "user3", "start_time": now - 1000, "duration": duration, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user)],
            "booking_list": [],
        }
    }

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert sent_payload == {}, "Should not send notification when condition not met"


def test_io_create_and_save(bot):
    """Test io create and save."""
    status, _ = create_or_load_node_state(config=bot.config)
    assert "test" in status, "Missing test node in created state"
    save_bot_state_to_file(status, config=bot.config)
    data_dir = bot.config.get_val("DATA_DIR")
    assert os.path.exists(os.path.join(data_dir, bot.config.get_val("BOT_ID"), "bot_state.json")), (
        "State file not created"
    )


def test_max_lock_duration_exceeded(bot):
    """Test max lock duration exceeded (re-lock accumulation, needs FORBID_RELOCK off)."""
    bot.config.set_val("MAX_LOCK_DURATION", 3600)
    bot.config.set_val("FORBID_RELOCK", False)

    reply1 = bot.lock("user1", "lock test 30m")
    assert "✅【资源申请成功】" in reply1["message"]["body"][0]["content"], "First lock failed"

    reply2 = bot.lock("user1", "lock test 45m")
    assert "❌" in reply2["message"]["body"][0]["content"], "Exceeding max lock duration not rejected"


def test_lock_duration_exceeded_no_state_pollution(bot):
    """After max duration rejection, node state must remain idle so subsequent lock succeeds."""
    bot.config.set_val("MAX_LOCK_DURATION", 3600)

    reply1 = bot.lock("user1", "lock test 2h")
    assert "❌" in reply1["message"]["body"][0]["content"]

    reply2 = bot.lock("user1", "lock test 30m")
    assert "✅【资源申请成功】" in reply2["message"]["body"][0]["content"]


def test_check_and_notify(bot, monkeypatch):
    """Expired holder is released; an idle node with a queue auto-promotes its head."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)

    now = int(time.time())
    user_expired = {
        "user_id": "user1",
        "start_time": now - 5000,
        "duration": 3600,
        "is_notified": False,
    }

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user_expired)],
            "booking_list": [],
        }
    }

    bot._check_and_notify()

    msg = sent_payload["json"]["message"]
    assert "user1" in msg["body"][1]["atuserids"], "Missing user ID in release notification"
    assert "释放" in msg["body"][0]["content"], "Missing release prompt"

    # Idle node with a queue → auto-promote the head of the queue (no wait window).
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [{"user_id": "user2", "start_time": 0, "duration": 3600, "is_notified": False}],
        }
    }

    sent_payload.clear()
    bot._check_and_notify()

    msg = sent_payload["json"]["message"]
    assert "user2" in msg["body"][1]["atuserids"], "Promoted head-of-queue user not notified"
    assert "自动" in msg["body"][0]["content"], "Auto-lock notification content not generated"

    node = bot.state.bot_state["test"]
    assert node["status"] == "exclusive", "Promoted node should be exclusive"
    assert len(node["current_users"]) == 1 and node["current_users"][0]["user_id"] == "user2", (
        "user2 should be promoted to current holder"
    )
    assert len(node["booking_list"]) == 0, "Promoted user should leave the booking list"

    # Multiple queued users → only the head is promoted; the rest stay in queue.
    bot.state.bot_state = {
        "test": {
            "status": "idle",
            "current_users": [],
            "booking_list": [
                {"user_id": "user2", "start_time": now, "duration": 3600, "is_notified": False},
                {"user_id": "user3", "start_time": now, "duration": 3600, "is_notified": False},
            ],
        }
    }

    sent_payload.clear()
    bot._check_and_notify()

    node = bot.state.bot_state["test"]
    assert node["current_users"][0]["user_id"] == "user2", "Head of queue (user2) should be promoted"
    remaining_ids = [u["user_id"] for u in node["booking_list"]]
    assert remaining_ids == ["user3"], f"Only user2 should be promoted, rest stay queued: {remaining_ids}"

    print("✅ 所有 _check_and_notify 测试通过")


def test_check_and_notify_combined(bot, monkeypatch):
    """Expiry release + auto-promotion of the queued user happen in one tick."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)

    now = int(time.time())
    expired_user = {
        "user_id": "user1",
        "start_time": now - 5000,
        "duration": 3600,
        "is_notified": False,
    }
    booking_user = {"user_id": "user2", "start_time": 0, "duration": 3600, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(expired_user)],
            "booking_list": [copy.deepcopy(booking_user)],
        }
    }

    bot._check_and_notify()

    msg = sent_payload["json"]["message"]
    content = msg["body"][0]["content"]
    atuserids = msg["body"][1]["atuserids"]

    assert "释放" in content, f"释放提示缺失: {content}"
    assert "自动" in content, f"自动锁定提示缺失: {content}"
    assert "user1" in atuserids, f"释放用户未通知: {atuserids}"
    assert "user2" in atuserids, f"晋升用户未通知: {atuserids}"

    node = bot.state.bot_state["test"]
    assert node["status"] == "exclusive", "Node should be re-locked by the promoted user"
    assert len(node["current_users"]) == 1 and node["current_users"][0]["user_id"] == "user2", (
        "user2 should be promoted to current holder"
    )
    assert len(node["booking_list"]) == 0, "booking_list should be empty after promotion"

    print("✅ 复合场景测试通过")


def test_check_and_notify_promotes_only_when_idle(bot, monkeypatch):
    """A busy node with a queue does NOT promote; an idle node with a queue does."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)

    now = int(time.time())
    # Busy node, not expired, with a queued user → nothing should happen.
    holder = {"user_id": "user1", "start_time": now, "duration": 3600, "is_notified": False}
    booking_user = {"user_id": "user2", "start_time": now, "duration": 3600, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(holder)],
            "booking_list": [copy.deepcopy(booking_user)],
        }
    }

    bot._check_and_notify()
    assert sent_payload == {}, "Should not promote or notify while the node is still held"

    node = bot.state.bot_state["test"]
    assert node["current_users"][0]["user_id"] == "user1", "Holder must stay while not expired"
    assert [u["user_id"] for u in node["booking_list"]] == ["user2"], "Queue must be untouched while node is busy"

    print("✅ 忙碌节点不晋升测试通过")


def test_check_and_notify_promotes_multi_node(bot, monkeypatch):
    """Each idle node with a queue promotes its own head independently."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)

    now = int(time.time())
    bot.state.bot_state = {
        "node01": {
            "status": "idle",
            "current_users": [],
            "booking_list": [
                {"user_id": "user_a", "start_time": now, "duration": 3600, "is_notified": False},
                {"user_id": "user_b", "start_time": now, "duration": 3600, "is_notified": False},
            ],
        }
    }

    sent_payload.clear()
    bot._check_and_notify()

    msg = sent_payload.get("json", {}).get("message", {})
    at_users = msg.get("body", [{}, {}])[1].get("atuserids", [])

    node = bot.state.bot_state["node01"]
    assert node["status"] == "exclusive", "Node should be locked by the promoted user"
    assert node["current_users"][0]["user_id"] == "user_a", "Head of queue (user_a) should be promoted"
    assert [u["user_id"] for u in node["booking_list"]] == ["user_b"], "Rest of the queue must be preserved"
    assert "user_a" in at_users, "Promoted user must be notified"

    print("✅ 多节点自动晋升测试通过")


def test_timer_routine_trigger_early_notify(bot, monkeypatch):
    """Test timer routine trigger early notification mode."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")
    bot.config.set_val("EARLY_NOTIFY", True)
    bot.config.set_val("TIME_ALERT", 300)

    now = int(time.time())
    duration = 3600
    user = {"user_id": "user2", "start_time": now - duration + 100, "duration": duration, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user)],
            "booking_list": [],
        }
    }

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert "user2" in sent_payload["json"]["message"]["body"][1]["atuserids"], "Missing user ID in early notification"
    assert "释放" in sent_payload["json"]["message"]["body"][0]["content"], (
        "Missing release prompt in early notification"
    )
    alert_dur = format_duration(bot.config.get_val("TIME_ALERT"))
    assert alert_dur in sent_payload["json"]["message"]["body"][0]["content"], (
        "Missing alert time in early notification"
    )


def test_timer_routine_no_trigger_early_notification(bot, monkeypatch):
    """Test timer routine no trigger early notification."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")
    bot.config.set_val("EARLY_NOTIFY", True)
    bot.config.set_val("TIME_ALERT", 300)

    now = int(time.time())
    duration = 3600
    user = {"user_id": "user4", "start_time": now - 500, "duration": duration, "is_notified": False}

    bot.state.bot_state = {
        "test": {
            "status": "exclusive",
            "current_users": [copy.deepcopy(user)],
            "booking_list": [],
        }
    }

    sent_payload = {}

    def fake_send(msg):
        sent_payload["json"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert sent_payload == {}, "Should not send notification before early alert time"


def test_early_notify_no_double_notification_on_expiry(bot, monkeypatch):
    """EARLY_NOTIFY=True: once early warning is sent (is_notified=True), expiry must NOT send a second notification."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")
    bot.config.set_val("EARLY_NOTIFY", True)
    bot.config.set_val("TIME_ALERT", 300)

    now = int(time.time())
    duration = 3600
    user = {
        "user_id": "userX",
        "start_time": now - duration - 10,  # already expired
        "duration": duration,
        "is_notified": True,  # early warning was already sent on a previous tick
    }

    bot.state.bot_state = {"test": {"status": "exclusive", "current_users": [copy.deepcopy(user)], "booking_list": []}}

    send_count = {"n": 0}

    def fake_send(msg):
        send_count["n"] += 1
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert send_count["n"] == 0, "should NOT send a second notification at expiry when early warning was already sent"


def test_early_notify_fallback_on_scheduler_delay(bot, monkeypatch):
    """EARLY_NOTIFY=True: if scheduler delayed past early window without notifying, send one notification at expiry."""
    bot.config.set_val("WEBHOOK_URL", "http://fake")
    bot.config.set_val("EARLY_NOTIFY", True)
    bot.config.set_val("TIME_ALERT", 300)

    now = int(time.time())
    duration = 3600
    user = {
        "user_id": "userY",
        "start_time": now - duration - 10,  # expired, early window already passed
        "duration": duration,
        "is_notified": False,  # early warning was never sent due to scheduler delay
    }

    bot.state.bot_state = {"test": {"status": "exclusive", "current_users": [copy.deepcopy(user)], "booking_list": []}}

    sent_payload = {}

    def fake_send(msg):
        sent_payload["msg"] = msg
        return type("Resp", (), {"status_code": 200})()

    monkeypatch.setattr(bot.adapter, "send", fake_send)
    bot._check_and_notify()

    assert "msg" in sent_payload, "should send fallback notification at expiry when early warning was never sent"
    assert "userY" in sent_payload["msg"]["message"]["body"][1]["atuserids"]


def test_io_log_to_file(bot):
    """Test io log to file."""
    log_to_file("user1", "lock", "test", 3600, config=bot.config)
    data_dir = bot.config.get_val("DATA_DIR")
    log_file = os.path.join(data_dir, bot.config.get_val("BOT_ID"), "bot.log")
    assert os.path.exists(log_file), "Log file not created"
    with open(log_file, encoding="utf-8") as f:
        lines = f.readlines()
    assert any("user1" in line and "lock" in line and "test" in line for line in lines), "Log file content incorrect"


# ── _notify_state_changed callback ───────────────────────────────────────────


def test_lock_calls_notify_state_changed(bot):
    """Successful lock() must invoke _on_state_changed so the scheduler wakes up."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    calls = []
    bot._on_state_changed = lambda: calls.append(1)

    bot.lock("user1", "lock test 1h")
    assert len(calls) == 1, "lock() should have called _on_state_changed once"


def test_take_calls_notify_state_changed(bot):
    """Successful take() must invoke _on_state_changed (new active lock added)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    # user1 locks, user2 books, then user1 unlocks so user2 can take
    bot.lock("user1", "lock test 1h")
    bot.book("user2", "book test 1h")
    bot.unlock("user1", "unlock test")

    calls = []
    bot._on_state_changed = lambda: calls.append(1)

    bot.take("user2", "take test 1h")
    assert len(calls) == 1, "take() should have called _on_state_changed once"


def test_failed_lock_does_not_call_notify(bot):
    """An error lock must NOT call _on_state_changed."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.lock("user1", "lock test 1h")  # test held

    calls = []
    bot._on_state_changed = lambda: calls.append(1)

    bot.lock("user2", "lock test 1h")  # conflicts → error
    assert len(calls) == 0, "failed lock() must not call _on_state_changed"


def test_book_calls_notify_state_changed(bot):
    """book() must invoke _on_state_changed so the scheduler wakes up."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.lock("user1", "lock test 1h")  # test is held

    calls = []
    bot._on_state_changed = lambda: calls.append(1)

    bot.book("user2", "book test 1h")
    assert len(calls) == 1, "book() should have called _on_state_changed once"


def test_kicklock_calls_notify_state_changed(bot):
    """kicklock() must invoke _on_state_changed so the first queued user is notified."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    bot.lock("user1", "lock test 1h")
    bot.book("user2", "book test 1h")

    calls = []
    bot._on_state_changed = lambda: calls.append(1)

    bot.kicklock("admin", "kicklock test")
    assert len(calls) == 1, "kicklock() should have called _on_state_changed once"


def test_notify_not_set_does_not_raise(bot):
    """lock() must not raise when _on_state_changed is None (default)."""
    bot.config.set_val("CLUSTER_CONFIGS", ["test"])
    assert bot._on_state_changed is None
    bot.lock("user1", "lock test 1h")  # must not raise


def test_queue_usage_compact_and_booking_preserved():
    """QUEUE usage: compact+sorted, and booking_list still rendered after node."""
    import time

    from lockbot.core.queue_bot import QueueBot

    cfg = {"BOT_NAME": "t", "CLUSTER_CONFIGS": ["n1", "n2"]}
    b = QueueBot(config_dict=cfg)
    now = int(time.time())
    b.state.bot_state = {
        "n1": {
            "status": "exclusive",
            "current_users": [{"user_id": "alice", "start_time": now, "duration": 600}],
            "booking_list": [{"user_id": "carol", "start_time": now, "duration": 1200}],
        },
        "n2": {"status": "idle", "current_users": [], "booking_list": []},
    }
    out = b._current_usage()
    assert "使用情况" not in out
    assert "alice" in out
    # booking list rendered
    assert "carol" in out
    # idle node n2 comes first
    lines = [ln for ln in out.split("\n") if ln.strip()]
    assert lines[0].startswith("n2")
