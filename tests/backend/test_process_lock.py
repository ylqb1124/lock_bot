"""Tests for the single-process scheduler guard."""

import pytest
from lockbot.backend.app.process_lock import ProcessLock


def test_process_lock_rejects_a_second_owner_and_releases(tmp_path):
    first = ProcessLock(str(tmp_path))
    second = ProcessLock(str(tmp_path))

    first.acquire()
    with pytest.raises(RuntimeError, match="already owns"):
        second.acquire()

    first.release()
    second.acquire()
    second.release()
