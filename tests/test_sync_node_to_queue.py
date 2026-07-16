"""Tests for the production node configuration sync tool."""

import importlib.util
import json
from pathlib import Path

from lockbot.backend.app.auth.models import User
from lockbot.backend.app.bots.models import Bot
from lockbot.backend.app.database import Base
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "tools" / "sync_node_to_queue.py"
SPEC = importlib.util.spec_from_file_location("sync_node_to_queue", SCRIPT_PATH)
sync_tool = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_tool)


def _session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'lockbot.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    user = User(username="owner", email="owner@example.com", password_hash="hash", role="super_admin")
    session.add(user)
    session.flush()
    return session, user


def _bot(user_id, name, bot_type, configs):
    return Bot(
        user_id=user_id,
        name=name,
        bot_type=bot_type,
        webhook_url="",
        cluster_configs=json.dumps(configs),
    )


def test_sync_node_configs_is_dry_run_until_apply(tmp_path):
    session, user = _session(tmp_path)
    source_configs = {"node-a": "10.0.0.1", "node-b": "10.0.0.2"}
    source = _bot(user.id, "lock-node", "NODE", source_configs)
    target = _bot(user.id, "lock-queue", "QUEUE", {"old": "10.0.0.9"})
    session.add_all([source, target])
    session.commit()

    _, target, changed = sync_tool.sync_cluster_configs(session, "lock-node", "lock-queue", apply=False)
    assert changed is True
    assert json.loads(target.cluster_configs) == {"old": "10.0.0.9"}

    _, target, changed = sync_tool.sync_cluster_configs(session, "lock-node", "lock-queue", apply=True)
    assert changed is True
    assert json.loads(target.cluster_configs) == source_configs


def test_sync_requires_node_source_and_queue_target(tmp_path):
    session, user = _session(tmp_path)
    session.add_all(
        [
            _bot(user.id, "not-node", "DEVICE", {}),
            _bot(user.id, "not-queue", "NODE", {}),
        ]
    )
    session.commit()

    try:
        sync_tool.sync_cluster_configs(session, "not-node", "not-queue", apply=True)
    except sync_tool.SyncError as exc:
        assert "must be NODE" in str(exc)
    else:
        raise AssertionError("Expected source type validation to fail")
