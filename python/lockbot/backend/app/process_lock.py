"""Single-process guard for the in-process bot scheduler."""

from __future__ import annotations

import fcntl
import os
from pathlib import Path


class ProcessLock:
    """Hold an advisory lock for the lifetime of one platform process."""

    def __init__(self, data_dir: str):
        self._path = Path(data_dir) / ".lockbot-platform.lock"
        self._fd: int | None = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise RuntimeError(
                f"Another LockBot platform process already owns {self._path}. Run exactly one worker for this DATA_DIR."
            ) from None
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        fcntl.flock(self._fd, fcntl.LOCK_UN)
        os.close(self._fd)
        self._fd = None
