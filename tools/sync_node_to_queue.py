#!/usr/bin/env python3
"""Copy a NODE bot's node/IP configuration to a QUEUE bot.

The command is a dry run unless --apply is supplied. It only updates
``cluster_configs``; credentials, bot settings, and state are not copied.

Examples:
    python3 tools/sync_node_to_queue.py --source lock-node --target lock-queue
    python3 tools/sync_node_to_queue.py --source 1 --target 3 --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PYTHON_ROOT = PROJECT_ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

# Import User first so SQLAlchemy can resolve Bot.user_id's foreign key.
from lockbot.backend.app.auth.models import User  # noqa: E402, F401
from lockbot.backend.app.bots.models import Bot  # noqa: E402


class SyncError(ValueError):
    """Raised when the requested bot configuration cannot be synchronized."""


def database_url(data_dir: str, explicit_url: str | None) -> str:
    if explicit_url:
        return explicit_url
    return f"sqlite:///{Path(data_dir).expanduser().resolve() / 'lockbot.db'}"


def get_bot(session: Session, reference: str, role: str) -> Bot:
    """Find an active bot by numeric ID or exact name."""
    query = session.query(Bot).filter(Bot.is_deleted.is_(False))
    if reference.isdecimal():
        bot = query.filter(Bot.id == int(reference)).one_or_none()
    else:
        bot = query.filter(Bot.name == reference).one_or_none()
    if bot is None:
        raise SyncError(f"{role} bot '{reference}' was not found")
    return bot


def load_cluster_configs(bot: Bot) -> dict | list:
    try:
        configs = json.loads(bot.cluster_configs)
    except (TypeError, json.JSONDecodeError) as exc:
        raise SyncError(f"Bot '{bot.name}' has invalid cluster_configs JSON") from exc
    if not isinstance(configs, (dict, list)):
        raise SyncError(f"Bot '{bot.name}' cluster_configs must be a JSON object or array")
    return configs


def sync_cluster_configs(
    session: Session, source_reference: str, target_reference: str, apply: bool
) -> tuple[Bot, Bot, bool]:
    """Validate and optionally copy NODE cluster_configs to a QUEUE bot."""
    source = get_bot(session, source_reference, "Source")
    target = get_bot(session, target_reference, "Target")
    if source.id == target.id:
        raise SyncError("Source and target must be different bots")
    if source.bot_type != "NODE":
        raise SyncError(f"Source bot '{source.name}' must be NODE, got {source.bot_type}")
    if target.bot_type != "QUEUE":
        raise SyncError(f"Target bot '{target.name}' must be QUEUE, got {target.bot_type}")

    configs = load_cluster_configs(source)
    serialized = json.dumps(configs, ensure_ascii=False)
    changed = target.cluster_configs != serialized
    if apply and changed:
        target.cluster_configs = serialized
        session.commit()
        session.refresh(target)
    return source, target, changed


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy NODE bot node/IP configuration to a QUEUE bot")
    parser.add_argument("--source", required=True, help="Source NODE bot name or numeric ID")
    parser.add_argument("--target", required=True, help="Target QUEUE bot name or numeric ID")
    parser.add_argument("--apply", action="store_true", help="Commit the configuration update")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("DATA_DIR", "/data"),
        help="Directory containing lockbot.db (default: DATA_DIR or /data)",
    )
    parser.add_argument("--database-url", help="SQLAlchemy database URL; overrides --data-dir")
    args = parser.parse_args()

    db_url = database_url(args.data_dir, args.database_url)
    connect_args = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
    engine = create_engine(db_url, connect_args=connect_args)
    # Keep the validated source configuration available after --apply commits.
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)()
    try:
        source, target, changed = sync_cluster_configs(session, args.source, args.target, args.apply)
    except SyncError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    finally:
        session.close()

    node_count = len(load_cluster_configs(source))
    if not changed:
        print(f"No change: '{target.name}' already has the {node_count}-node configuration from '{source.name}'.")
    elif args.apply:
        print(f"Updated '{target.name}' with {node_count} node(s) from '{source.name}'.")
        print("Restart the LockBot service to load the new QUEUE bot configuration.")
    else:
        print(f"Dry run: would copy {node_count} node(s) from '{source.name}' to '{target.name}'.")
        print("Run again with --apply to commit the update.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
