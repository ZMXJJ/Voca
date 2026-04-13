import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconPlay, IconPause, IconDownload } from "./Icons";

type AudioPlayerProps = {
  audioPath: string | null;
};

export function AudioPlayer({ audioPath }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!audioPath) {
      setAudioSrc(null);
      setPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    try {
      setAudioSrc(convertFileSrc(audioPath));
    } catch {
      setAudioSrc(null);
    }
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
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [audioSrc]);

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

  return (
    <div className="audio-player">
      {audioSrc && <audio ref={audioRef} src={audioSrc} preload="metadata" />}
      <button
        className="audio-player__play-btn"
        disabled={!audioSrc}
        onClick={togglePlay}
        type="button"
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
        disabled={!audioPath}
        type="button"
      >
        <IconDownload size={18} />
      </button>
    </div>
  );
}
