"""Keeps native child processes from outliving the app.

The C++ TTS path keeps a resident ``llama-tts-server`` child alive between
generations (see :mod:`app.services.voxcpm_server`). It is a *grandchild* of the
Tauri shell, so nothing the OS does on quit reaches it: if the sidecar dies
without running its shutdown hooks — ``SIGKILL``, a crash, Force Quit — the
server is reparented to ``launchd``/``init`` and keeps holding several GB of
GPU memory until the machine reboots. Users found week-old ones still running.

Two independent safety nets, so no single failure leaks a process:

* **Registry** — every spawned native child is recorded in a small JSON file
  under the app-support dir. On the next sidecar boot :func:`sweep_orphans`
  kills whatever is still alive from a previous run. This is the backstop that
  cleans up after a crash we could not intercept.
* **Parent watchdog** — a daemon thread that notices the Tauri shell going away
  and tears the children down immediately, rather than leaving them until the
  next launch. Armed only when the shell told us its PID via
  ``VOCA_PARENT_PID``, so a standalone ``uvicorn`` dev run is unaffected.

Both are best-effort by design: nothing here may raise into a request path or
block shutdown.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from app.services.storage_paths import app_support_dir

logger = logging.getLogger(__name__)

_REGISTRY_NAME = "native-children.json"
_WATCHDOG_POLL_SECONDS = 2.0
_lock = threading.RLock()


def _registry_path() -> Path:
    return app_support_dir() / "run" / _REGISTRY_NAME


def _read_registry() -> list[dict]:
    try:
        raw = _registry_path().read_text(encoding="utf-8")
    except (OSError, ValueError):
        return []
    try:
        entries = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def _write_registry(entries: list[dict]) -> None:
    path = _registry_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - housekeeping must never break TTS
        logger.debug("Could not persist native-child registry: %s", exc)


# ── registry ─────────────────────────────────────────────────────────────────


def register_child(pid: int, name: str) -> None:
    """Record a spawned native child so a later boot can reap it if we crash."""

    with _lock:
        entries = [entry for entry in _read_registry() if entry.get("pid") != pid]
        entries.append({"pid": int(pid), "name": name})
        _write_registry(entries)


def unregister_child(pid: int) -> None:
    """Forget a child we have just reaped ourselves."""

    with _lock:
        entries = _read_registry()
        remaining = [entry for entry in entries if entry.get("pid") != pid]
        if len(remaining) != len(entries):
            _write_registry(remaining)


def sweep_orphans() -> int:
    """Kill native children left behind by a previous sidecar. Returns the count.

    PIDs get recycled, so each one is confirmed to still *be* the process we
    recorded (by executable name) before anything is signalled.
    """

    with _lock:
        entries = _read_registry()
        if not entries:
            return 0
        killed = 0
        for entry in entries:
            pid = entry.get("pid")
            name = entry.get("name") or ""
            if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
                continue
            if not _process_matches(pid, name):
                continue
            logger.warning("Reaping orphaned %s (pid %s) from a previous run", name, pid)
            if kill_process(pid):
                killed += 1
        _write_registry([])
        return killed


def _process_matches(pid: int, name: str) -> bool:
    """True when `pid` is alive and looks like the executable we recorded."""

    if not name:
        return False
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
        else:
            result = subprocess.run(
                ["ps", "-p", str(pid), "-o", "comm="],
                capture_output=True,
                text=True,
                timeout=10,
            )
    except Exception:  # pragma: no cover - probing must never raise
        return False
    if result.returncode != 0:
        return False
    return Path(name).stem.lower() in (result.stdout or "").lower()


def kill_process(pid: int, grace_seconds: float = 3.0) -> bool:
    """Terminate `pid`, escalating to a hard kill. Returns True if it is gone."""

    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                timeout=15,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
        except Exception:  # pragma: no cover
            return False
        return not _pid_alive(pid)

    for signal_name in ("-TERM", "-KILL"):
        try:
            subprocess.run(["kill", signal_name, str(pid)], capture_output=True, timeout=10)
        except Exception:  # pragma: no cover
            return False
        deadline = time.monotonic() + grace_seconds
        while time.monotonic() < deadline:
            if not _pid_alive(pid):
                return True
            time.sleep(0.05)
    return not _pid_alive(pid)


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
        except Exception:  # pragma: no cover
            return False
        return str(pid) in (result.stdout or "")
    _reap_if_own_child(pid)
    try:
        os.kill(pid, 0)  # signal 0 only probes; never use this branch on Windows
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _reap_if_own_child(pid: int) -> None:
    """Clear `pid`'s zombie entry when it is one of our own children.

    A signalled child stays visible to ``kill(pid, 0)`` until its parent reaps
    it, so without this the liveness poll below would spin out the full grace
    period on a process that is already dead.
    """

    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):  # not our child, or already reaped
        pass


# ── parent watchdog ──────────────────────────────────────────────────────────


def _parent_liveness_probe() -> Callable[[], bool] | None:
    """Return a callable reporting whether the Tauri shell is still alive.

    ``None`` when there is nothing to watch (no ``VOCA_PARENT_PID``, e.g. a
    standalone ``uvicorn`` dev run, or the parent is already gone).
    """

    raw = os.environ.get("VOCA_PARENT_PID", "").strip()
    if not raw:
        return None
    try:
        parent_pid = int(raw)
    except ValueError:
        return None
    if parent_pid <= 1:
        return None

    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE = 0x00100000
        WAIT_OBJECT_0 = 0x0
        kernel32 = ctypes.windll.kernel32
        # Hold the handle open for the process lifetime: it pins this exact
        # process, so a recycled PID can never look like a live parent.
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if not handle:
            return None

        def alive() -> bool:
            return kernel32.WaitForSingleObject(handle, 0) != WAIT_OBJECT_0

        return alive

    # POSIX: when the parent dies we are reparented to launchd/init (pid 1).
    if os.getppid() != parent_pid:
        return None

    def alive() -> bool:
        return os.getppid() == parent_pid

    return alive


def start_parent_watchdog(on_parent_exit: Callable[[], None]) -> bool:
    """Watch the Tauri shell; run `on_parent_exit` and quit when it disappears.

    Returns True when a watchdog was armed.
    """

    probe = _parent_liveness_probe()
    if probe is None:
        return False

    def run() -> None:
        while True:
            time.sleep(_WATCHDOG_POLL_SECONDS)
            try:
                if probe():
                    continue
            except Exception:  # pragma: no cover - probe must never kill the app
                return
            logger.warning("Voca shell exited without stopping us; shutting down")
            try:
                on_parent_exit()
            except Exception:  # pragma: no cover
                logger.exception("Cleanup after parent exit failed")
            # Hard exit: uvicorn's graceful path can block on an in-flight
            # generation, and there is no longer a UI waiting for the result.
            os._exit(0)

    threading.Thread(target=run, name="voca-parent-watchdog", daemon=True).start()
    return True
