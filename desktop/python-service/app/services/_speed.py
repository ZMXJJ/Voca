"""EMA-smoothed download rate tracking shared by the model + CUDA wheel paths.

The desktop UI used to compute transfer rate purely on the renderer side by
diffing two consecutive ``downloadedBytes`` samples taken from the 600ms task
poll. On Windows that loop produced a notoriously jittery "0 B/s ↔ 80 MB/s"
read-out because the underlying HuggingFace / requests stream emits bytes in
bursts (driven by AV scanning, NTFS write batching, and 32-way segmented
downloads). Mac users rarely saw it because APFS and the absence of a CUDA
upgrade meant the producer pacing was almost uniform.

Centralising the smoothing here means every progress emitter (model snapshot
download, CUDA wheel download, future bootstrap assets) gets the same
``bytesPerSecond`` field on the wire. The client can trust it directly and
falls back to a local estimator only if the field is missing on older
sidecars.

The tracker is intentionally single-purpose: feed it monotonically growing
``downloaded_bytes`` totals (in bytes) and it returns the EMA-smoothed rate.
No thread safety guarantees — callers must hold their own lock if the
tracker is shared between threads.
"""

from __future__ import annotations

import math
import time


class EmaSpeedTracker:
    """Exponential moving average of bytes-per-second.

    Parameters
    ----------
    tau_seconds:
        Time constant of the exponential decay, in seconds. ``3.0`` keeps the
        readout responsive enough to follow mirror swaps and network
        regressions within a couple of seconds while smoothing over the
        ~600 ms client poll cadence and the burstier Windows write pattern.

    The formula is ``alpha = 1 - exp(-dt / tau)``, which is the discrete-time
    equivalent of a first-order low-pass filter. Compared to a naive fixed
    ``alpha`` it correctly handles uneven update intervals — important
    because ``advance_transfer`` runs every wheel chunk (~4 MiB) while
    ``set_phase`` may not fire for several seconds during ``listing``.
    """

    DEFAULT_TAU_SECONDS = 3.0

    def __init__(self, tau_seconds: float = DEFAULT_TAU_SECONDS) -> None:
        if tau_seconds <= 0:
            raise ValueError("tau_seconds must be positive")
        self._tau = tau_seconds
        self._last_bytes: int | None = None
        self._last_ts: float | None = None
        self._ema: float | None = None

    def update(self, total_bytes: int, *, now: float | None = None) -> float | None:
        """Feed a new cumulative byte count and return the smoothed rate.

        Returns ``None`` until the second sample arrives (one sample is not
        enough to derive a rate). After that, returns the EMA value in
        bytes/second, never negative.
        """

        ts = time.monotonic() if now is None else now
        if self._last_ts is None or self._last_bytes is None:
            self._last_bytes = total_bytes
            self._last_ts = ts
            return None

        dt = ts - self._last_ts
        if dt <= 0:
            # Clock did not advance (same chunk batch); leave the EMA as-is
            # so a busy producer can't artificially zero the rate out.
            return self._ema

        delta = max(0, total_bytes - self._last_bytes)
        inst_rate = delta / dt

        alpha = 1.0 - math.exp(-dt / self._tau)
        if self._ema is None:
            self._ema = inst_rate
        else:
            self._ema = alpha * inst_rate + (1.0 - alpha) * self._ema

        self._last_bytes = total_bytes
        self._last_ts = ts
        return self._ema

    def current(self) -> float | None:
        """Last smoothed value without consuming a new sample."""

        return self._ema

    def reset(self) -> None:
        """Forget all history. Call when the underlying transfer restarts
        (e.g. retried after a network error) so a stale fast/slow EMA does
        not leak into the new run."""

        self._last_bytes = None
        self._last_ts = None
        self._ema = None
