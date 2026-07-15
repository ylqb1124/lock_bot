"""End-to-end command text coverage for QueueBot through the shared handler."""

from unittest.mock import MagicMock

import pytest
from lockbot.core.handler import execute_command
from lockbot.core.message_adapter import MessageAdapter
from lockbot.core.queue_bot import QueueBot

NODES = ("alpha", "beta", "gamma")


@pytest.fixture
def bot(tmp_path):
    bot = QueueBot(
        config_dict={
            "BOT_ID": "queue_command_flow",
            "DATA_DIR": str(tmp_path),
            "CLUSTER_CONFIGS": list(NODES),
            "BOT_TYPE": "QUEUE",
            "DEFAULT_DURATION": 2 * 60 * 60,
            "MAX_LOCK_DURATION": 2 * 24 * 60 * 60,
            "FORBID_RELOCK": False,
            "WEBHOOK_URL": "",
            "EARLY_NOTIFY": False,
        }
    )
    bot.state.bot_state = {node: {"status": "idle", "current_users": [], "booking_list": []} for node in NODES}
    bot._collect_xpu_on_query = False

    adapter = MagicMock(spec=MessageAdapter)
    adapter.build_reply.side_effect = lambda content, user_ids, **kwargs: {
        "content": content,
        "user_ids": user_ids,
        "markdown": kwargs.get("markdown", False),
    }
    bot.adapter = adapter
    return bot


def command(bot, user_id, text):
    bot.adapter.extract_command.return_value = (user_id, "test-group", text)
    return execute_command({"ignored": True}, bot)


def assert_success(reply):
    assert any(marker in reply["content"] for marker in ("✅", "🗓️", "🏁"))


def test_lock_duration_forms_relock_and_multiple_nodes(bot):
    default = command(bot, "alice", "lock alpha")
    assert_success(default)
    alpha_user = bot.state.bot_state["alpha"]["current_users"][0]
    assert alpha_user["duration"] == 2 * 60 * 60

    explicit = command(bot, "alice", "lock alpha 30m")
    assert_success(explicit)
    assert bot.state.bot_state["alpha"]["current_users"][0]["duration"] == 2 * 60 * 60 + 30 * 60

    assert_success(command(bot, "bob", "lock beta 1d"))
    assert bot.state.bot_state["beta"]["current_users"][0]["duration"] == 24 * 60 * 60

    assert_success(command(bot, "carol", "lock gamma 1.5h"))
    assert bot.state.bot_state["gamma"]["current_users"][0]["duration"] == 90 * 60

    command(bot, "alice", "unlock alpha")
    command(bot, "bob", "free beta")
    command(bot, "carol", "free gamma")
    assert_success(command(bot, "alice", "lock alpha,beta 45m"))
    assert {node for node in ("alpha", "beta") if bot.state.bot_state[node]["current_users"]} == {"alpha", "beta"}


def test_booking_idle_occupied_and_multiple_positions(bot):
    assert_success(command(bot, "alice", "book alpha 1h"))
    assert bot.state.bot_state["alpha"]["current_users"][0]["user_id"] == "alice"
    assert bot.state.bot_state["alpha"]["booking_list"] == []

    assert_success(command(bot, "bob", "lock beta 1h"))
    assert_success(command(bot, "carol", "book beta 30m"))
    assert_success(command(bot, "dana", "book beta 45m"))
    assert [entry["user_id"] for entry in bot.state.bot_state["beta"]["booking_list"]] == ["carol", "dana"]


def test_take_idle_and_preempt_occupied_node(bot):
    assert_success(command(bot, "bob", "lock alpha 1h"))
    assert_success(command(bot, "alice", "book alpha 1h"))
    assert_success(command(bot, "admin", "kicklock alpha"))
    assert_success(command(bot, "alice", "take alpha"))
    assert bot.state.bot_state["alpha"]["current_users"][0]["user_id"] == "alice"
    assert bot.state.bot_state["alpha"]["booking_list"] == []

    assert_success(command(bot, "bob", "lock beta 1h"))
    assert_success(command(bot, "carol", "book beta 30m"))
    reply = command(bot, "carol", "take beta")
    assert_success(reply)
    assert bot.state.bot_state["beta"]["current_users"][0]["user_id"] == "carol"
    assert [entry["user_id"] for entry in bot.state.bot_state["beta"]["booking_list"]] == ["bob"]
    assert "beta" in reply["content"]
    assert "alpha" not in reply["content"]
    assert "gamma" not in reply["content"]


def test_unlock_and_free_release_requested_resources_and_bookings(bot):
    assert_success(command(bot, "alice", "lock alpha,beta 1h"))
    assert_success(command(bot, "alice", "unlock alpha"))
    assert bot.state.bot_state["alpha"]["status"] == "idle"
    assert bot.state.bot_state["beta"]["current_users"][0]["user_id"] == "alice"

    assert_success(command(bot, "alice", "free beta"))
    assert bot.state.bot_state["beta"]["status"] == "idle"

    assert_success(command(bot, "alice", "lock alpha,beta 1h"))
    assert_success(command(bot, "alice", "unlock"))
    assert all(bot.state.bot_state[node]["status"] == "idle" for node in ("alpha", "beta"))

    assert_success(command(bot, "alice", "book gamma 1h"))
    assert_success(command(bot, "alice", "free gamma"))
    assert bot.state.bot_state["gamma"]["booking_list"] == []


def test_kickout_kicklock_help_and_query_forms(bot):
    assert_success(command(bot, "alice", "lock alpha 1h"))
    assert_success(command(bot, "bob", "book alpha 30m"))
    reply = command(bot, "admin", "kicklock alpha")
    assert_success(reply)
    assert "alpha" in reply["content"]
    assert "beta" not in reply["content"]
    assert "gamma" not in reply["content"]
    assert bot.state.bot_state["alpha"]["status"] == "idle"
    assert [entry["user_id"] for entry in bot.state.bot_state["alpha"]["booking_list"]] == ["bob"]

    assert_success(command(bot, "admin", "kickout alpha"))
    assert bot.state.bot_state["alpha"]["booking_list"] == []

    assert "lock" in command(bot, "alice", "help")["content"]
    assert "lock" in command(bot, "alice", "h")["content"]

    assert command(bot, "alice", "")["markdown"] is True
    node_query = command(bot, "alice", "alpha")
    assert node_query["markdown"] is True
    assert "alpha" in node_query["content"]
