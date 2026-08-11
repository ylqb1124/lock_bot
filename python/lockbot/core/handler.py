"""Command parsing and routing handler."""

import re

from flask import abort

from lockbot.core.config import Config
from lockbot.core.i18n import t
from lockbot.core.message_adapter import MessageAdapter
from lockbot.core.platforms.infoflow import InfoflowAdapter


def _split_query_nodes(text):
    """Split a comma-separated query target, ignoring duplicate node names."""
    nodes = []
    for node in re.split(r"[,，、]", text):
        node = node.strip()
        if node and node not in nodes:
            nodes.append(node)
    return nodes


def execute_command(msg_data, bot):
    adapter = getattr(bot, "adapter", None)
    if not isinstance(adapter, MessageAdapter):
        adapter = InfoflowAdapter()
    user_id, _, rcv_info = adapter.extract_command(msg_data)
    config = getattr(bot, "config", None)
    cluster_configs = config.get_val("CLUSTER_CONFIGS", {}) if config else Config.get("CLUSTER_CONFIGS", {})

    supported_commands = set(bot.supported_commands())
    cluster_configs = cluster_configs or {}
    valid_node_keys = set(cluster_configs)

    m = re.match(r"^(\w+)", rcv_info, re.I)
    cmd = m.group(1).lower() if m else ""

    # Empty input defaults to query
    if cmd == "":
        cmd = "query"

    query_nodes = None
    invalid_query_nodes = []
    if cmd == "query":
        query_target = rcv_info[m.end() :].strip() if m else ""
        if query_target:
            requested_nodes = _split_query_nodes(query_target)
            query_nodes = [node for node in requested_nodes if node in valid_node_keys]
            invalid_query_nodes = [node for node in requested_nodes if node not in valid_node_keys]
    # Treat a known node_key or a comma-separated node list as a query.
    elif rcv_info in valid_node_keys or any(separator in rcv_info for separator in (",", "，", "、")):
        requested_nodes = _split_query_nodes(rcv_info)
        query_nodes = [node for node in requested_nodes if node in valid_node_keys]
        invalid_query_nodes = [node for node in requested_nodes if node not in valid_node_keys]
        cmd = "query"

    if cmd not in supported_commands:
        return bot.print_help(
            user_id, t("error.unrecognized_command", config=getattr(bot, "config", None), command=rcv_info)
        )

    if cmd == "lock":
        return bot.lock(user_id, rcv_info)
    elif cmd == "slock":
        return bot.slock(user_id, rcv_info)
    elif cmd in ("unlock", "free"):
        return bot.unlock(user_id, rcv_info)
    elif cmd == "kickout":
        return bot.kickout(user_id, rcv_info)
    elif cmd == "kicklock":
        return bot.kicklock(user_id, rcv_info)
    elif cmd == "book":
        return bot.book(user_id, rcv_info)
    elif cmd == "take":
        return bot.take(user_id, rcv_info)
    elif cmd == "query":
        if query_nodes is not None:
            if not query_nodes:
                return bot.show_error(
                    user_id,
                    t(
                        "error.invalid_node_key",
                        config=getattr(bot, "config", None),
                        node_key=", ".join(invalid_query_nodes),
                        valid_keys=str(list(cluster_configs)),
                    ),
                )
            node_filter = query_nodes[0] if len(query_nodes) == 1 else query_nodes
            if invalid_query_nodes:
                return bot.query(user_id, node_filter, invalid_query_nodes=invalid_query_nodes)
            return bot.query(user_id, node_filter)
        return bot.query(user_id)
    elif cmd in ("help", "h"):
        return bot.print_help(user_id)
    else:
        return bot.print_help(user_id, t("error.unknown_error", config=getattr(bot, "config", None), command=rcv_info))
        return bot.print_help(user_id, t("error.unknown_error", config=getattr(bot, "config", None), command=rcv_info))


_DEPRECATION_MSG = (
    "The legacy Flask handler is deprecated and will be removed in a future version. "
    "Use the FastAPI platform webhook handler (lockbot.backend.app.bots.webhook_handler) instead."
)


# Global adapter for the legacy Flask entry point (uses Config singleton)
_global_adapter = InfoflowAdapter()


def decrypt_message(msg_base64):
    """Decrypt a base64-encoded message, returning parsed JSON or aborting on failure.

    .. deprecated:: Use platform mode webhook handler instead.
    """
    result = _global_adapter.decrypt_payload(msg_base64)
    if result is None:
        abort(404)
    return result


def handle_request(echostr, signature, rn, timestamp, msg_base64, bot):
    """Handle an incoming request: verify signature, decrypt, execute command, and reply.

    .. deprecated:: Use platform mode webhook handler instead.

    Args:
        echostr: Echo string for signature verification handshake; None otherwise.
        signature: Request signature for verification.
        rn: Random nonce from the server.
        timestamp: Request timestamp.
        msg_base64: Encrypted message payload.
        bot: Bot instance for command execution.

    Returns:
        tuple: (response_body, http_status_code)
    """
    if echostr:
        if _global_adapter.verify_request(signature, rn=rn, timestamp=timestamp):
            return echostr
        else:
            return "check signature fail", 401

    if not _global_adapter.verify_request(signature, rn=rn, timestamp=timestamp):
        return "check signature fail", 401

    msg_data = decrypt_message(msg_base64)
    print(msg_data)
    reply = execute_command(msg_data, bot)

    toid = msg_data["message"]["header"].get("toid", None)
    if toid:
        reply["message"]["header"]["toid"] = [int(toid)]

    _global_adapter.send(reply)
    return "command succeed"


def page_not_found(_):
    """Return a 404 response.

    .. deprecated:: Use platform mode instead.
    """
    return "404 - Page not found", 404
