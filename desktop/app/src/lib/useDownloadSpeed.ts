import { useEffect, useRef, useState } from "react";

/**
 * Smoothed download speed (bytes/sec) shown in the bootstrap and settings UIs.
 *
 * Design notes
 * ------------
 * The renderer originally computed speed by diffing two consecutive
 * ``downloadedBytes`` samples taken from the 600 ms task poll. On Windows
 * that produced a "0 B/s ↔ tens of MB/s" flicker because HuggingFace's
 * multi-worker downloader and the segmented CUDA wheel fetcher both write
 * bytes in bursts (NTFS batching, Defender pauses, etc.), and a single-poll
 * delta lands either on a burst or a quiet window.
 *
 * Mac never showed the same issue because APFS pacing was uniform and the
 * Windows-only CUDA path adds extra concurrent IO. The fix is platform-
 * agnostic: prefer the server-side EMA carried on the wire (newer sidecars
 * fill in ``bytesPerSecond``), and fall back to a local sliding-window
 * estimator when the field is missing — older sidecars stay usable.
 *
 * Behaviour:
 *   1. ``serverBytesPerSecond`` non-null → echo it verbatim.
 *   2. Otherwise maintain a sliding window of {bytes, atMs} samples within
 *      the last ``WINDOW_MS`` and return ``(bytesNewest - bytesOldest) /
 *      timeDelta``. This naturally averages over the polling cadence.
 *   3. When no fresh bytes arrive for ``DECAY_AFTER_MS``, gradually decay
 *      the displayed value (× ``DECAY_FACTOR`` per tick) so the UI does
 *      not snap to 0 between chunks. After ``STALL_AFTER_MS`` the value
 *      goes to 0.
 *   4. Resetting (``active`` flips false, or the task finishes) clears
 *      both the sliding window and the displayed value.
 */

type Sample = { bytes: number; atMs: number };

const WINDOW_MS = 5_000;
const DECAY_AFTER_MS = 1_500;
const DECAY_TICK_MS = 500;
const DECAY_FACTOR = 0.75;
const STALL_AFTER_MS = 8_000;
const MIN_DELTA_MS = 200;

export type DownloadSpeedInput = {
  /** ``true`` while the download is actively progressing. */
  active: boolean;
  /** Cumulative byte count from the task progress payload. */
  downloadedBytes: number | null | undefined;
  /** Optional EMA-smoothed rate from the sidecar. Preferred over local. */
  serverBytesPerSecond?: number | null;
  /** Used to detect a new file segment within the same task. */
  currentFile?: string | null;
};

export function useDownloadSpeed(input: DownloadSpeedInput): number | null {
  const { active, downloadedBytes, serverBytesPerSecond, currentFile } = input;
  const samplesRef = useRef<Sample[]>([]);
  const lastFileRef = useRef<string | null | undefined>(currentFile);
  const lastDisplayedRef = useRef<number | null>(null);
  const lastFreshAtRef = useRef<number | null>(null);

  const [displayed, setDisplayed] = useState<number | null>(null);

  // Reset when the consumer signals the speed widget should disappear.
  useEffect(() => {
    if (!active) {
      samplesRef.current = [];
      lastFreshAtRef.current = null;
      lastDisplayedRef.current = null;
      lastFileRef.current = currentFile;
      setDisplayed(null);
    }
  }, [active, currentFile]);

  // Server-provided value is the source of truth when present. We still
  // touch ``lastFreshAtRef`` so the decay path below stays consistent if a
  // future poll downgrades to a null server value mid-stream.
  useEffect(() => {
    if (!active) return;
    if (typeof serverBytesPerSecond !== "number" || !Number.isFinite(serverBytesPerSecond)) {
      return;
    }
    const value = Math.max(0, serverBytesPerSecond);
    lastDisplayedRef.current = value;
    lastFreshAtRef.current = Date.now();
    setDisplayed(value);
  }, [active, serverBytesPerSecond]);

  // Local sliding-window fallback. Skipped entirely when the server value
  // is already driving ``displayed`` for the current poll, to avoid a
  // wasted re-render on every byte update.
  useEffect(() => {
    if (!active) return;
    if (typeof serverBytesPerSecond === "number" && Number.isFinite(serverBytesPerSecond)) {
      // Still maintain a window so a sudden server null gap can fall back
      // smoothly without showing 0 instantly.
      const bytes = downloadedBytes ?? 0;
      const now = Date.now();
      samplesRef.current.push({ bytes, atMs: now });
      const cutoff = now - WINDOW_MS;
      while (samplesRef.current.length > 1 && samplesRef.current[0].atMs < cutoff) {
        samplesRef.current.shift();
      }
      return;
    }

    const bytes = downloadedBytes ?? 0;
    const now = Date.now();
    const fileChanged = currentFile !== lastFileRef.current;
    lastFileRef.current = currentFile;

    // ``downloadedBytes`` is task-level cumulative for bootstrap tasks (so
    // it never decreases mid-task) but for single-file download tasks it
    // can reset to 0 when a new file starts. Treat either case as a fresh
    // window so the next sample doesn't produce a giant negative diff.
    const newest = samplesRef.current[samplesRef.current.length - 1];
    if (!newest || (fileChanged && bytes === 0) || bytes < newest.bytes) {
      samplesRef.current = [{ bytes, atMs: now }];
      return;
    }

    samplesRef.current.push({ bytes, atMs: now });
    const cutoff = now - WINDOW_MS;
    while (samplesRef.current.length > 1 && samplesRef.current[0].atMs < cutoff) {
      samplesRef.current.shift();
    }

    if (bytes > newest.bytes) {
      lastFreshAtRef.current = now;
    }

    const oldest = samplesRef.current[0];
    const deltaMs = now - oldest.atMs;
    if (deltaMs < MIN_DELTA_MS) {
      return;
    }
    const deltaBytes = bytes - oldest.bytes;
    if (deltaBytes <= 0) {
      return;
    }
    const bps = (deltaBytes / deltaMs) * 1000;
    lastDisplayedRef.current = bps;
    setDisplayed(bps);
  }, [active, downloadedBytes, serverBytesPerSecond, currentFile]);

  // Decay-to-zero ticker for the local fallback. Server-driven mode skips
  // this because the sidecar already returns ``null`` during listing /
  // finalizing — let the consumer decide how to render that.
  useEffect(() => {
    if (!active) return;
    if (typeof serverBytesPerSecond === "number" && Number.isFinite(serverBytesPerSecond)) {
      return;
    }
    const timer = window.setInterval(() => {
      const lastFresh = lastFreshAtRef.current;
      if (lastFresh === null) return;
      const idleMs = Date.now() - lastFresh;
      if (idleMs < DECAY_AFTER_MS) return;
      if (idleMs >= STALL_AFTER_MS) {
        lastDisplayedRef.current = 0;
        setDisplayed(0);
        return;
      }
      const previous = lastDisplayedRef.current ?? 0;
      const next = previous * DECAY_FACTOR;
      lastDisplayedRef.current = next;
      setDisplayed(next < 1 ? 0 : next);
    }, DECAY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, serverBytesPerSecond]);

  return displayed;
}
