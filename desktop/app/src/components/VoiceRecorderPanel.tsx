import { useCallback, useEffect, useRef, useState } from "react";
import { encodeAudioBufferToWav } from "../lib/wavEncoder";
import { openMicrophoneSettings } from "../lib/tauri";
import { IconPause, IconPlay } from "./Icons";

const BAR_COUNT = 24;
const DEFAULT_MAX_MS = 60_000;
const DEFAULT_MIN_MS = 1_000;

export type VoiceRecorderLabels = {
  recording: string;
  stop: string;
  reRecord: string;
  useRecording: string;
  cancel: string;
  saving: string;
  maxHint: string;
  permissionDenied: string;
  permissionHint: string;
  openSystemSettings: string;
  microphoneUnavailable: string;
  recordingTooShort: string;
  recordingFailed: string;
};

type ErrorKind = "generic" | "permission";

type VoiceRecorderPanelProps = {
  labels: VoiceRecorderLabels;
  maxDurationMs?: number;
  minDurationMs?: number;
  saving?: boolean;
  onUse: (wavBlob: Blob, durationMs: number) => void;
  onCancel: () => void;
};

type SubPhase = "starting" | "recording" | "encoding" | "preview" | "error";

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
  return "";
}

function getAudioContextCtor(): typeof AudioContext | null {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceRecorderPanel({
  labels,
  maxDurationMs = DEFAULT_MAX_MS,
  minDurationMs = DEFAULT_MIN_MS,
  saving = false,
  onUse,
  onCancel,
}: VoiceRecorderPanelProps) {
  const [subPhase, setSubPhase] = useState<SubPhase>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>("generic");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [barHeights, setBarHeights] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0.12),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const maxTimeoutRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);
  const recorderMimeRef = useRef<string>("audio/webm");
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(0);
  const lastWavRef = useRef<Blob | null>(null);
  const lastDurationMsRef = useRef(0);

  const stopAnimationAndTimers = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimeoutRef.current != null) {
      window.clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  };

  const disconnectAnalyserGraph = () => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // ignore: node may already be disconnected
      }
      sourceNodeRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        // ignore
      }
      analyserRef.current = null;
    }
  };

  const closeAudioContext = () => {
    disconnectAnalyserGraph();
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  const stopStream = () => {
    disconnectAnalyserGraph();
    closeAudioContext();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const releaseAll = () => {
    sessionIdRef.current += 1;
    stopAnimationAndTimers();
    stopStream();
    closeAudioContext();
    recorderRef.current = null;
  };

  const startAnalyserLoop = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const segmentSize = Math.max(1, Math.floor(bufferLength / BAR_COUNT));
    const tick = () => {
      if (!mountedRef.current || !analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(dataArray);
      const next: number[] = new Array(BAR_COUNT);
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const start = i * segmentSize;
        const end = Math.min(bufferLength, start + segmentSize);
        let sumSq = 0;
        for (let j = start; j < end; j += 1) {
          const v = (dataArray[j] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, end - start));
        const amplified = Math.min(1, rms * 2.6);
        next[i] = Math.max(0.12, amplified);
      }
      setBarHeights(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const finalizeRecording = async (measuredDurationMs: number) => {
    stopAnimationAndTimers();
    stopStream();

    setSubPhase("encoding");

    if (chunksRef.current.length === 0 || measuredDurationMs < minDurationMs) {
      if (mountedRef.current) {
        setSubPhase("error");
        setErrorMessage(labels.recordingTooShort);
      }
      return;
    }

    let decodeCtx: AudioContext | null = null;
    try {
      const mimeType = recorderMimeRef.current || "audio/webm";
      const rawBlob = new Blob(chunksRef.current, { type: mimeType });
      const arrayBuffer = await rawBlob.arrayBuffer();

      const Ctor = getAudioContextCtor();
      if (!Ctor) throw new Error("AudioContext unavailable");
      decodeCtx = new Ctor();
      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      const wavBlob = encodeAudioBufferToWav(audioBuffer);
      void decodeCtx.close().catch(() => {});
      decodeCtx = null;

      if (!mountedRef.current) return;

      const url = URL.createObjectURL(wavBlob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      lastWavRef.current = wavBlob;
      lastDurationMsRef.current = Math.round(audioBuffer.duration * 1000);
      setSubPhase("preview");
    } catch {
      if (decodeCtx) {
        void decodeCtx.close().catch(() => {});
      }
      if (mountedRef.current) {
        setSubPhase("error");
        setErrorMessage(labels.recordingFailed);
      }
    }
  };

  const startRecording = async () => {
    releaseAll();
    const sessionId = ++sessionIdRef.current;
    chunksRef.current = [];
    setErrorMessage(null);
    setErrorKind("generic");
    setElapsedMs(0);
    setBarHeights(new Array(BAR_COUNT).fill(0.12));
    setSubPhase("starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionIdRef.current !== sessionId || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const mimeType = pickMimeType();
      recorderMimeRef.current = mimeType || "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        if (!mountedRef.current) return;
        releaseAll();
        setSubPhase("error");
        setErrorMessage(labels.recordingFailed);
      };
      recorder.onstop = () => {
        const durationMs = Math.min(
          maxDurationMs,
          performance.now() - startTimeRef.current,
        );
        void finalizeRecording(durationMs);
      };

      const AudioContextCtor = getAudioContextCtor();
      if (AudioContextCtor) {
        const ctx = new AudioContextCtor();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        sourceNodeRef.current = source;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        analyserRef.current = analyser;
        startAnalyserLoop();
      }

      startTimeRef.current = performance.now();
      recorder.start();
      setSubPhase("recording");

      timerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        const elapsed = Math.min(
          maxDurationMs,
          performance.now() - startTimeRef.current,
        );
        setElapsedMs(elapsed);
      }, 100);

      maxTimeoutRef.current = window.setTimeout(() => {
        requestStop();
      }, maxDurationMs);
    } catch (error) {
      const domError = error as DOMException | undefined;
      let message = labels.recordingFailed;
      let kind: ErrorKind = "generic";
      if (
        domError?.name === "NotAllowedError" ||
        domError?.name === "SecurityError"
      ) {
        message = labels.permissionDenied;
        kind = "permission";
      } else if (
        domError?.name === "NotFoundError" ||
        domError?.name === "OverconstrainedError"
      ) {
        message = labels.microphoneUnavailable;
      }
      releaseAll();
      if (mountedRef.current) {
        setSubPhase("error");
        setErrorMessage(message);
        setErrorKind(kind);
      }
    }
  };

  const requestStop = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {
        releaseAll();
        if (mountedRef.current) {
          setSubPhase("error");
          setErrorMessage(labels.recordingFailed);
        }
      }
    }
  };

  const handleUseClick = () => {
    const wav = lastWavRef.current;
    if (!wav) return;
    onUse(wav, lastDurationMsRef.current);
  };

  const handleRerecordClick = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    lastWavRef.current = null;
    lastDurationMsRef.current = 0;
    void startRecording();
  };

  useEffect(() => {
    mountedRef.current = true;
    void startRecording();
    return () => {
      mountedRef.current = false;
      releaseAll();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (subPhase === "error") {
    const isPermissionError = errorKind === "permission";
    return (
      <div className="voice-recorder voice-recorder--error" role="alert">
        <div className="voice-recorder__error-copy">
          <div>{errorMessage}</div>
          {isPermissionError ? (
            <div className="voice-recorder__error-hint">
              {labels.permissionHint}
            </div>
          ) : null}
        </div>
        <div className="voice-recorder__controls">
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={onCancel}
          >
            {labels.cancel}
          </button>
          {isPermissionError ? (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => void openMicrophoneSettings()}
            >
              {labels.openSystemSettings}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => void startRecording()}
          >
            {labels.reRecord}
          </button>
        </div>
      </div>
    );
  }

  const isRecording = subPhase === "recording" || subPhase === "starting";
  const isEncoding = subPhase === "encoding";
  const isPreview = subPhase === "preview";

  const displayedBars = isRecording
    ? barHeights
    : new Array(BAR_COUNT).fill(0.32);
  const displayedTimeMs = isRecording ? elapsedMs : lastDurationMsRef.current;

  return (
    <div
      className={`voice-recorder${isRecording ? " voice-recorder--active" : ""}${isPreview ? " voice-recorder--preview" : ""}`}
    >
      {!isPreview ? (
        <>
          <div className="voice-recorder__header">
            <span
              className={`voice-recorder__dot${isRecording ? " voice-recorder__dot--pulse" : ""}`}
              aria-hidden="true"
            />
            <span className="voice-recorder__label">
              {isRecording
                ? labels.recording
                : isEncoding
                  ? labels.saving
                  : saving
                    ? labels.saving
                    : ""}
            </span>
            <span className="voice-recorder__time">{formatTime(displayedTimeMs)}</span>
          </div>

          <div className="voice-recorder__waveform" aria-hidden="true">
            {displayedBars.map((h, i) => (
              <span
                key={i}
                className={`voice-recorder__bar${!isRecording ? " voice-recorder__bar--static" : ""}`}
                style={{ height: `${Math.max(10, Math.min(100, h * 100))}%` }}
              />
            ))}
          </div>
        </>
      ) : null}

      {isPreview && previewUrl ? (
        <RecorderPreviewPlayer
          src={previewUrl}
          initialDurationMs={lastDurationMsRef.current}
        />
      ) : null}

      <div className="voice-recorder__controls">
        {isRecording ? (
          <>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={onCancel}
              disabled={subPhase === "starting"}
            >
              {labels.cancel}
            </button>
            <button
              type="button"
              className="voice-recorder__stop"
              onClick={requestStop}
              disabled={subPhase === "starting"}
            >
              <span className="voice-recorder__stop-square" aria-hidden="true" />
              {labels.stop}
            </button>
          </>
        ) : isEncoding ? (
          <span className="voice-recorder__encoding">{labels.saving}</span>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={onCancel}
              disabled={saving}
            >
              {labels.cancel}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={handleRerecordClick}
              disabled={saving}
            >
              {labels.reRecord}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={handleUseClick}
              disabled={saving}
            >
              {saving ? labels.saving : labels.useRecording}
            </button>
          </>
        )}
      </div>

      {isRecording ? (
        <div className="voice-recorder__hint">{labels.maxHint}</div>
      ) : null}
    </div>
  );
}

type RecorderPreviewPlayerProps = {
  src: string;
  initialDurationMs: number;
};

function RecorderPreviewPlayer({ src, initialDurationMs }: RecorderPreviewPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, initialDurationMs / 1000));

  useEffect(() => {
    setCurrentTime(0);
    setPlaying(false);
    setDuration(Math.max(0, initialDurationMs / 1000));
  }, [src, initialDurationMs]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const target = ratio * duration;
      audio.currentTime = target;
      setCurrentTime(target);
    },
    [duration],
  );

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const format = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  return (
    <div className="recorder-preview-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="recorder-preview-player__play-btn"
        onClick={togglePlay}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
      <span className="recorder-preview-player__time">{format(currentTime)}</span>
      <div
        className="recorder-preview-player__progress"
        onClick={seek}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        tabIndex={0}
      >
        <div
          className="recorder-preview-player__progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="recorder-preview-player__time recorder-preview-player__time--total">
        {format(duration)}
      </span>
    </div>
  );
}
