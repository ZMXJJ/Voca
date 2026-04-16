import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { IconPlay, IconPause, IconDownload } from "./Icons";

type AudioPlayerProps = {
  audioPath: string | null;
  autoPlay?: boolean;
  playNonce?: number;
  downloadName?: string;
  defaultDirectory?: string;
  onDownloadComplete?: () => void;
};

export function AudioPlayer({
  audioPath,
  autoPlay = false,
  playNonce = 0,
  downloadName,
  defaultDirectory,
  onDownloadComplete,
}: AudioPlayerProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const audioElementKey = `${audioSrc ?? "empty"}:${playNonce}`;
  const shouldAutoPlay = autoPlay && playNonce > 0;

  useEffect(() => {
    if (!audioPath) {
      setAudioSrc(null);
      setPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setAudioSrc(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setLoadError(null);
    invoke<string>("read_audio_base64", { path: audioPath })
      .then((dataUrl) => {
        if (!cancelled) {
          setAudioSrc(dataUrl);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAudioSrc(null);
          setLoadError(error instanceof Error ? error.message : "Failed to load audio");
        }
      });
    return () => { cancelled = true; };
  }, [audioPath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
    };
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      setCurrentTime(0);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [audioElementKey]);

  useEffect(() => {
    if (!shouldAutoPlay) return;
    const audio = audioRef.current;
    if (!audio) return;

    const attemptPlay = () => {
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      attemptPlay();
    } else {
      audio.addEventListener("canplay", attemptPlay, { once: true });
      return () => audio.removeEventListener("canplay", attemptPlay);
    }
  }, [audioElementKey, shouldAutoPlay]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioSrc) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().then(() => setPlaying(true));
    }
  }, [playing, audioSrc]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrentTime(audio.currentTime);
    },
    [duration],
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleDownload = useCallback(() => {
    if (!audioPath || saving) return;

    const fallbackName = audioPath.split("/").pop() || "voca-output.wav";
    setSaving(true);
    invoke<boolean>("save_audio_as", {
      path: audioPath,
      suggestedName: downloadName || fallbackName,
      defaultDirectory: defaultDirectory || null,
    })
      .then((saved) => {
        if (saved && onDownloadComplete) onDownloadComplete();
      })
      .catch(() => {})
      .finally(() => {
        setSaving(false);
      });
  }, [audioPath, downloadName, defaultDirectory, onDownloadComplete, saving]);

  return (
    <div className="audio-player" title={loadError ?? undefined}>
      <span className="audio-player__ai-badge">{t("player.aiGenerated")}</span>
      {audioSrc && <audio key={audioElementKey} ref={audioRef} src={audioSrc} preload="auto" />}
      <button
        className="audio-player__play-btn"
        disabled={!audioSrc}
        onClick={togglePlay}
        type="button"
        title={loadError ?? "Play audio"}
      >
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <span className="audio-player__time">{formatTime(currentTime)}</span>
      <div className="audio-player__progress" onClick={handleProgressClick}>
        <div
          className="audio-player__progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="audio-player__time">{formatTime(duration)}</span>
      <button
        className="audio-player__download"
        disabled={!audioPath || saving}
        onClick={handleDownload}
        type="button"
        title={loadError ?? (saving ? "Saving..." : "Download audio")}
      >
        <IconDownload size={18} />
      </button>
    </div>
  );
}
