"""Queue lock bot with booking list and auto-take functionality."""

import re
import time

from lockbot.core.i18n import t
from lockbot.core.io import log_to_file
from lockbot.core.node_bot import NodeBot
from lockbot.core.query_render import build_node_query
from lockbot.core.usage_render import (
    DEFAULT_IDLE_TEMPLATE,
    DEFAULT_LINE_TEMPLATE,
    min_remaining,
    render_line,
    sort_and_group,
)
from lockbot.core.utils import (
    create_user_info,
    find_user_info,
    format_access_mode,
    format_duration,
    is_first_user,
    remaining_duration,
    remove_user_info,
)
from lockbot.core.xpu_collector import collect_node_usage


class QueueBot(NodeBot):
    """
    QueueBot class
    """

    # QueueBot collects per-node GPU memory on /query, same as NodeBot: it drives
    # the memory-based status badge, the XPU columns, and the container column.
    _collect_xpu_on_query = True

    def supported_commands(self):
        return ["lock", "unlock", "free", "kickout", "kicklock", "help", "h", "book", "take", "query"]

    def query(self, user_id, node_key=None):
        """Query usage; always uses memory_based=False so the booking column is shown."""
        xpu_usage = None
        if self._collect_xpu_on_query:
            with self._lock:
                node_ips = self._node_ips(node_filter=node_key)
            xpu_usage = collect_node_usage(node_ips, self.config) if node_ips else None
        with self._lock:
            content = build_node_query(
                self.state.bot_state,
                user_id,
                self.config,
                node_filter=node_key,
                xpu_usage=xpu_usage,
                memory_based=False,
            )
            return self.adapter.build_reply(content, [user_id], markdown=True)

    def _success_usage(self, node_keys):
        return self._current_usage(node_keys)

    def lock(self, user_id, command):
        """
        Lock nodes
        """
        parse_ok, error_reply, node_keys, duration = self.parse_command(user_id, "lock", command, True)
        command_has_duration = bool(re.search(r"\s([0-9]+\.?[0-9]*)([dhm])\s*$", command))
        if not parse_ok:
            return error_reply

        max_dur = self.config.get_val("MAX_LOCK_DURATION")
        forbid_relock = self.config.get_val("FORBID_RELOCK")
        allow_multi_lock = self.config.get_val("ALLOW_MULTI_LOCK")
        if not allow_multi_lock and len(node_keys) > 1:
            return self.show_error(user_id, t("error.multi_lock_forbidden_once", config=self.config))
        with self._lock:
            nodes = [self.state.bot_state[node_key] for node_key in node_keys]
            if not allow_multi_lock and self._user_holds_other_node(user_id, node_keys):
                return self.show_error(user_id, t("error.multi_lock_forbidden_once", config=self.config))

            # FORBID_RELOCK: the current holder may not re-lock (续锁) the same node.
            # A head-of-queue booking user locking an idle node is *promotion*, not
            # re-lock, and is still allowed (handled by Condition 1 below).
            if forbid_relock and any(find_user_info(node["current_users"], user_id) for node in nodes):
                return self.show_error(user_id, t("error.relock_forbidden", config=self.config))

            if not all(
                (
                    # Condition 1: node is not in use
                    node["status"] == "idle"
                    # and (no booking list or current user is first in queue)
                    and ((not node.get("booking_list")) or is_first_user(node["booking_list"], user_id))
                )
                # Condition 2: current user is already using this node
                or find_user_info(node["current_users"], user_id)
                for node in nodes
            ):
                # If any node fails the above conditions, return error
                return self.show_error(
                    user_id,
                    self._msg_with_usage("error.node_in_use_or_not_your_turn", node_key=node_keys, sep="\n\n"),
                )

            timestamp = int(time.time())
            users_to_notify = set()
            users_to_notify.add(user_id)

            if max_dur > 0:
                for node in nodes:
                    booking_info = find_user_info(node["booking_list"], user_id)
                    if not command_has_duration and booking_info:
                        check_duration = booking_info["duration"]
                    else:
                        check_duration = duration
                    user_info = find_user_info(node["current_users"], user_id)
                    if user_info:
                        check_duration += user_info["duration"]
                        start_time = user_info["start_time"]
                    else:
                        start_time = timestamp
                    if remaining_duration(start_time, check_duration) > max_dur:
                        return self.show_error(
                            user_id,
                            t(
                                "error.lock_max_duration_exceeded",
                                config=self.config,
                                max_duration=format_duration(max_dur, config=self.config),
                            ),
                        )

            for node in nodes:
                node["status"] = "exclusive"
                booking_info = find_user_info(node["booking_list"], user_id)
                remove_user_info(node["booking_list"], user_id)

                if not command_has_duration and booking_info:
                    total_duration = booking_info["duration"]
                else:
                    total_duration = duration

                if booking_info and total_duration > booking_info["duration"]:
                    for booking_user in node["booking_list"]:
                        users_to_notify.add(booking_user["user_id"])

                user_info = find_user_info(node["current_users"], user_id)
                if not user_info:
                    user_info = create_user_info(user_id, total_duration, timestamp, config=self.config)
                    self._start_occupancy(user_info)
                else:
                    total_duration += user_info["duration"]
                    for booking_user in node["booking_list"]:
                        users_to_notify.add(booking_user["user_id"])

                user_info["duration"] = total_duration
                user_info["is_notified"] = False
                node["current_users"] = [user_info]

            content = t("success.resource_locked", config=self.config) + self._success_usage(node_keys)
            if len(users_to_notify) > 1:
                content += t("notify.wait_time_increased", config=self.config)
            reply = self.adapter.build_reply(content, list(users_to_notify))
            log_to_file(user_id, "lock", node_keys, duration, config=self.config)
            self._save_and_notify()
            return reply

    def slock(self, user_id, command):
        return self.show_error(user_id, t("error.slock_not_supported", config=self.config))

    def book(self, user_id, command):
        """
        book nodes
        """
        parse_ok, error_reply, node_keys, duration = self.parse_command(user_id, "book", command, True)
        if not parse_ok:
            return error_reply

        max_dur = self.config.get_val("MAX_LOCK_DURATION")
        forbid_relock = self.config.get_val("FORBID_RELOCK")
        with self._lock:
            nodes = [self.state.bot_state[node_key] for node_key in node_keys]

            # Already queued on any node → always reject (no duplicate booking).
            if any(find_user_info(node["booking_list"], user_id) for node in nodes):
                return self.show_error(user_id, self._msg_with_usage("error.already_locked", sep="\n"))

            # Already the current holder of any node → this is a self-renewal (book-relock).
            # Reject only when FORBID_RELOCK is on; otherwise allow booking one's next slot.
            if forbid_relock and any(find_user_info(node["current_users"], user_id) for node in nodes):
                return self.show_error(user_id, t("error.relock_forbidden", config=self.config))

            timestamp = int(time.time())

            if max_dur > 0 and duration > max_dur:
                return self.show_error(
                    user_id,
                    t(
                        "error.lock_max_duration_exceeded",
                        config=self.config,
                        max_duration=format_duration(max_dur, config=self.config),
                    ),
                )

            locked_any = False
            booked_any = False
            for node in nodes:
                # book an idle node with no queue == lock it directly (no waiting).
                if node["status"] == "idle" and not node["booking_list"]:
                    user_info = create_user_info(user_id, duration, timestamp, config=self.config)
                    self._start_occupancy(user_info)
                    node["status"] = "exclusive"
                    node["current_users"] = [user_info]
                    locked_any = True
                else:
                    user_info = create_user_info(user_id, duration, timestamp, config=self.config)
                    node["booking_list"].append(user_info)
                    booked_any = True

            if locked_any and not booked_any:
                content = t("success.resource_locked", config=self.config) + self._success_usage(node_keys)
            elif booked_any and not locked_any:
                content = t("success.booking_added", config=self.config) + self._success_usage(node_keys)
            else:
                content = t("success.resource_locked", config=self.config)
                content += t("success.booking_added", config=self.config)
                content += self._success_usage(node_keys)
            reply = self.adapter.build_reply(content, [user_id])
            log_to_file(user_id, "lock", node_keys, duration, config=self.config)
            self._save_and_notify()
            return reply

    def take(self, user_id, command):
        """
        take nodes
        """
        parse_ok, error_reply, node_keys, duration = self.parse_command(user_id, "take", command, True)
        if not parse_ok:
            return error_reply

        content = t("success.take_success_by", config=self.config, user_id=user_id)
        content += self._msg_with_usage("label.before_take", node_key=node_keys)
        max_dur = self.config.get_val("MAX_LOCK_DURATION")
        with self._lock:
            nodes = [self.state.bot_state[node_key] for node_key in node_keys]
            if any(find_user_info(node["current_users"], user_id) for node in nodes):
                return self.show_error(user_id, self._msg_with_usage("error.locked_user_cannot_take", sep="\n"))

            timestamp = int(time.time())
            users_to_notify = set()
            users_to_notify.add(user_id)
            nodes = [self.state.bot_state[node_key] for node_key in node_keys]

            if max_dur > 0 and remaining_duration(timestamp, duration) > max_dur:
                return self.show_error(
                    user_id,
                    t(
                        "error.lock_max_duration_exceeded",
                        config=self.config,
                        max_duration=format_duration(max_dur, config=self.config),
                    ),
                )

            for node_key, node in zip(node_keys, nodes, strict=True):
                node["status"] = "exclusive"
                remove_user_info(node["booking_list"], user_id)

                total_duration = duration

                user_info = find_user_info(node["current_users"], user_id)
                if not user_info:
                    user_info = create_user_info(user_id, total_duration, timestamp, config=self.config)
                    self._start_occupancy(user_info)
                else:
                    total_duration += user_info["duration"]

                others = [u for u in node["current_users"] if u["user_id"] != user_id]
                for other_user in reversed(others):
                    rem_dur = remaining_duration(other_user["start_time"], other_user["duration"])
                    if rem_dur > 0:
                        self._record_occupancy_end(node_key, other_user, node["status"], ended_at=timestamp)
                        other_user.pop("occupancy_session_id", None)
                        other_user["start_time"] = timestamp
                        other_user["duration"] = rem_dur
                        other_user["is_notified"] = False
                        node["booking_list"].insert(0, other_user)
                        users_to_notify.add(other_user["user_id"])
                for user in node["booking_list"]:
                    user["is_notified"] = False
                    users_to_notify.add(user["user_id"])

                user_info["duration"] = total_duration
                user_info["is_notified"] = False
                node["current_users"] = [user_info]

            content += self._msg_with_usage("label.after_take", node_key=node_keys)
            reply = self.adapter.build_reply(content, list(users_to_notify))
            log_to_file(user_id, "lock", node_keys, duration, config=self.config)
            self._save_and_notify()
            return reply

    def kicklock(self, user_id, command):
        """
        kicklock nodes
        """
        parse_ok, error_reply, node_keys, _ = self.parse_command(user_id, "kicklock", command)
        if not parse_ok:
            return error_reply

        with self._lock:
            ended_at = int(time.time())
            nodes = [self.state.bot_state[node_key] for node_key in node_keys]
            users = set([user_id])
            content = t("success.kicklock_cleared", config=self.config, user_id=user_id)
            content += self._msg_with_usage("label.before_release", node_key=node_keys)
            for node_key, node in zip(node_keys, nodes, strict=True):
                for user_info in node["current_users"]:
                    users.add(user_info["user_id"])
                    self._record_occupancy_end(node_key, user_info, node["status"], ended_at=ended_at)
                node["status"] = "idle"
                node["current_users"] = []
            content += self._msg_with_usage("label.after_release", node_key=node_keys)
            reply = self.adapter.build_reply(content, list(users))
            log_to_file(user_id, "kicklock", node_keys, config=self.config)
            self._save_and_notify()
            return reply

    def _help_header(self):
        parts = []
        parts.append(t("help.title", config=self.config))
        parts.append(t("help.section1_title", config=self.config))
        parts.append(
            t(
                "help.queue_rule1_forbid_relock"
                if self.config.get_val("FORBID_RELOCK")
                else "help.queue_rule1_allow_relock",
                config=self.config,
                default_duration=format_duration(self.config.get_val("DEFAULT_DURATION"), config=self.config),
            )
        )
        if self.config.get_val("EARLY_NOTIFY"):
            parts.append(
                t(
                    "help.rule2_early_notification",
                    config=self.config,
                    time_alert=format_duration(self.config.get_val("TIME_ALERT"), config=self.config),
                )
            )
        else:
            parts.append(t("help.rule2_post_expiry_notification", config=self.config))
        return "".join(parts)

    def _help_max_duration_warning(self, max_duration):
        return t(
            "help.max_duration_warning_queue",
            config=self.config,
            max_duration=format_duration(max_duration, config=self.config),
        )

    def _help_commands(self):
        cluster_configs = self.config.get_val("CLUSTER_CONFIGS")
        assert len(cluster_configs) >= 1
        itr = iter(cluster_configs)
        example_node0 = next(itr)
        example_node1 = next(itr) if len(cluster_configs) > 1 else None

        parts = []
        # 1. Request resource (title/rules printed by _help_header) — lock examples.
        parts.append(t("help.rule3_lock_exclusive", config=self.config))
        parts.append(f"    lock {example_node0}\n")
        parts.append(f"    lock {example_node0} 3d\n")
        if example_node1 is not None:
            parts.append(f"    lock {example_node0},{example_node1} 2h\n")
        # 2. Book (queue; directly locks an idle node, default 2h)
        parts.append(
            t(
                "help.section_booking_title",
                config=self.config,
                default_duration=format_duration(self.config.get_val("DEFAULT_DURATION"), config=self.config),
            )
        )
        parts.append(f"    book {example_node0}\n")
        parts.append(f"    book {example_node0} 2h\n")
        # 3. Take (preempt current holder)
        parts.append(
            t(
                "help.section_take_title",
                config=self.config,
                default_duration=format_duration(self.config.get_val("DEFAULT_DURATION"), config=self.config),
            )
        )
        parts.append(f"    take {example_node0} 2h\n")
        # 4. Release own resource / cancel own booking (unlock and free are interchangeable)
        parts.append(t("help.section_release_title", config=self.config))
        parts.append(f"    unlock {example_node0}\n")
        if example_node1 is not None:
            parts.append(f"    free {example_node0},{example_node1}\n")
        parts.append(t("help.free_all", config=self.config))
        # 5. Force-release others' resource
        parts.append(t("help.section_kickout_title", config=self.config))
        parts.append(f"    kickout {example_node0}\n")
        if example_node1 is not None:
            parts.append(f"    kickout {example_node0},{example_node1}\n")
        # 6. Force-release lock only (keep booking list)
        parts.append(t("help.section_kicklock_title", config=self.config))
        parts.append(f"    kicklock {example_node0}\n")
        # 7. Help
        parts.append(t("help.section_help_title_queue", config=self.config))
        # 8. Query
        parts.append(t("help.section_query_title_queue", config=self.config))
        parts.append(t("help.query_at_bot", config=self.config))
        parts.append(f"    {example_node0}\n\n")
        return "".join(parts)

    def _check_and_notify(self) -> float | None:
        """
        Check resource expiration and booking timeouts, release expired resources,
        and send notifications. Persist state only when changes occur.

        Returns: seconds until next interesting event, or None if no active locks/bookings.
        """
        trigger_time_alert = False
        trigger_notify_alert = False
        state_changed = False
        user_ids = set()
        EARLY_NOTIFY = self.config.get_val("EARLY_NOTIFY")
        TIME_ALERT = self.config.get_val("TIME_ALERT")

        alert_info = self._build_alert_header()

        # Header for the "auto-locked on promotion" notification
        notify_info_header = t("notify.resource_available_header", config=self.config)

        promoted_notify = ""  # Auto-locked (promoted) booking content

        def promote_first_booking_user(node_key, node, timestamp):
            """Promote the first booked user to current holder (auto-lock, no wait window)."""
            nonlocal trigger_notify_alert, state_changed, user_ids, promoted_notify

            if not node["booking_list"]:
                return

            first_user = node["booking_list"].pop(0)
            first_user["start_time"] = timestamp
            first_user["is_notified"] = False
            self._start_occupancy(first_user)
            node["current_users"] = [first_user]
            node["status"] = "exclusive"
            trigger_notify_alert = True
            state_changed = True
            user_ids.add(first_user["user_id"])

            dur = format_duration(first_user["duration"], config=self.config)
            promoted_notify += f"  - {node_key} {first_user['user_id']} {dur}\n"

        with self._lock:
            # 1. Release resources
            for node_key, node in self.state.bot_state.items():
                # === 1. Check if current_users have expired ===
                if node["status"] != "idle":
                    removed_users_id = []
                    for user_info in node["current_users"]:
                        remaining_time = remaining_duration(user_info["start_time"], user_info["duration"])
                        if remaining_time <= 0:
                            self._record_occupancy_end(node_key, user_info, node["status"])
                            removed_users_id.append(user_info["user_id"])
                            state_changed = True

                            # Send expiry notification only if early warning was never sent.
                            # When EARLY_NOTIFY=True and warning fired on time, is_notified=True → silent release.
                            # When EARLY_NOTIFY=False, is_notified is always False → always notify here.
                            # Fallback: EARLY_NOTIFY=True但 scheduler delayed past expiry → notify here instead.
                            if not user_info["is_notified"]:
                                trigger_time_alert = True
                                user_ids.add(user_info["user_id"])

                                uid = user_info["user_id"] + format_access_mode(node["status"], config=self.config)
                                duration = format_duration(remaining_time, config=self.config)
                                alert_info += f"{node_key} {uid}  {duration}\n"

                        if EARLY_NOTIFY and not user_info["is_notified"] and 0 < remaining_time <= TIME_ALERT:
                            trigger_time_alert = True
                            user_ids.add(user_info["user_id"])
                            user_info["is_notified"] = True
                            state_changed = True

                            uid = user_info["user_id"] + format_access_mode(node["status"], config=self.config)
                            duration = format_duration(remaining_time, config=self.config)
                            alert_info += f"{node_key} {uid}  {duration}\n"

                    for user_id in removed_users_id:
                        remove_user_info(node["current_users"], user_id)

                    if len(node["current_users"]) == 0:
                        node["status"] = "idle"
                # === 2. If node is idle with a queue, auto-lock (promote) the first booked user ===
                if node["status"] == "idle" and node["booking_list"]:
                    now = int(time.time())
                    promote_first_booking_user(node_key, node, now)

            if state_changed:
                self._persist_state()

            # Compute next wakeup after mutations
            min_next = float("inf")
            for node in self.state.bot_state.values():
                # Active users
                if node["status"] != "idle":
                    for user_info in node["current_users"]:
                        remaining = remaining_duration(user_info["start_time"], user_info["duration"])
                        if remaining <= 0:
                            continue
                        if EARLY_NOTIFY and not user_info["is_notified"]:
                            next_event = remaining - TIME_ALERT
                        else:
                            next_event = remaining
                        min_next = min(min_next, next_event)
                # Idle node with a pending queue → promote very soon (should be rare;
                # promotion normally happens in the same tick a node becomes idle).
                elif node.get("booking_list"):
                    min_next = min(min_next, 1.0)

        # Aggregate promoted bookings into notify_info
        notify_info = notify_info_header
        if promoted_notify:
            notify_info += promoted_notify

        # Send messages
        if trigger_time_alert or trigger_notify_alert:
            content = ""
            if trigger_time_alert:
                content += alert_info + "\n"
            if trigger_notify_alert:
                content += notify_info + "\n"
            msg = self.adapter.build_reply(content, list(user_ids))
            try:
                self.adapter.send(msg)
            except Exception:
                self.logger.exception("Failed to send alert for bot %s", self.config.get_val("BOT_NAME"))

        return max(1.0, min_next) if min_next != float("inf") else None

    def _current_usage(self, node_filter=None, user_id=None):
        """Render QUEUE usage honoring USAGE_* config; booking_list rendered per-node."""
        line_tpl = self.config.get_val("USAGE_LINE_TEMPLATE")
        idle_tpl = self.config.get_val("USAGE_IDLE_TEMPLATE")
        sort_mode = self.config.get_val("USAGE_SORT")
        group_mode = self.config.get_val("USAGE_GROUP")
        bot_name = self.config.get_val("BOT_NAME")
        fb_line = DEFAULT_LINE_TEMPLATE
        fb_idle = DEFAULT_IDLE_TEMPLATE

        def _booking_text(node_status):
            booking_list = node_status.get("booking_list", [])
            if not booking_list:
                return ""
            text = t("label.queue_list", config=self.config)
            current_locked_time = 0
            for user_info in node_status.get("current_users", []):
                remain = remaining_duration(user_info["start_time"], user_info["duration"])
                if remain > current_locked_time:
                    current_locked_time = remain
            accumulated_wait = current_locked_time
            for idx, booking_user in enumerate(booking_list):
                text += t(
                    "label.queue_item",
                    config=self.config,
                    index=idx + 1,
                    user_id=booking_user["user_id"],
                    duration=format_duration(booking_user["duration"], config=self.config),
                    wait_time=format_duration(accumulated_wait, config=self.config),
                )
                accumulated_wait += booking_user["duration"]
            return text

        entries = []
        order = 0
        for node_key, node_status in self.state.bot_state.items():
            if node_filter is not None and node_key != node_filter and not (
                isinstance(node_filter, list) and node_key in node_filter
            ):
                continue
            rem = min_remaining(node_status)
            rows = []
            if node_status["status"] == "idle":
                rows.append(
                    (
                        True,
                        {
                            "node": "",
                            "dev": "",
                            "model": "",
                            "user": "",
                            "mode": "",
                            "dur": "",
                            "status": t("status.idle", config=self.config),
                        },
                    )
                )
            else:
                for user_info in node_status["current_users"]:
                    duration = format_duration(
                        remaining_duration(user_info["start_time"], user_info["duration"]),
                        config=self.config,
                    )
                    rows.append(
                        (
                            False,
                            {
                                "node": "",
                                "dev": "",
                                "model": "",
                                "user": user_info["user_id"],
                                "mode": "",
                                "dur": duration,
                                "status": "",
                            },
                        )
                    )
            entries.append(
                {
                    "order_index": order,
                    "is_idle": rem is None,
                    "is_mine": user_id is not None
                    and any(user_info["user_id"] == user_id for user_info in node_status.get("current_users", [])),
                    "min_remaining": rem,
                    "node_key": node_key,
                    "rows": rows,
                    "booking": _booking_text(node_status),
                }
            )
            order += 1

        ordered = sort_and_group(entries, sort_mode, group_mode)

        def render_entries(entries_to_render):
            text = ""
            for entry in entries_to_render:
                node_key = entry["node_key"]
                first = True
                for is_idle, fields in entry["rows"]:
                    fields = dict(fields)
                    fields["node"] = node_key if first else " " * len(node_key)
                    tpl, fb = (idle_tpl, fb_idle) if is_idle else (line_tpl, fb_line)
                    text += render_line(tpl, fields, fb, bot_name=bot_name).rstrip() + "\n"
                    first = False
                if entry["booking"]:
                    text += entry["booking"]
            return text

        my_entries = [entry for entry in ordered if entry["is_mine"]]
        rest_entries = [entry for entry in ordered if not entry["is_mine"]]

        usage_info = ""
        if my_entries:
            usage_info += t("query.my_resources_header", config=self.config)
            usage_info += render_entries(my_entries)
        usage_info += render_entries(rest_entries)
        return usage_info
