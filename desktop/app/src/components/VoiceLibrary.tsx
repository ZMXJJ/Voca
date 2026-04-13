import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceEntry } from "@voca/contracts";
import { listVoices } from "../lib/tauri";
import { IconUpload } from "./Icons";

type VoiceLibraryProps = {
  selectedVoiceId: string | null;
  onSelectVoice: (voiceId: string) => void;
};

function chunkPairs<T>(arr: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < arr.length; i += 2) {
    rows.push(arr.slice(i, i + 2));
  }
  return rows;
}

const AVATAR_COLORS = ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#4f46e5", "#7c3aed"];

export function VoiceLibrary({ selectedVoiceId, onSelectVoice }: VoiceLibraryProps) {
  const { t } = useTranslation();
  const [voices, setVoices] = useState<VoiceEntry[]>([]);

  useEffect(() => {
    void listVoices().then(setVoices);
  }, []);

  const rows = chunkPairs(voices);

  return (
    <div className="card">
      <div className="card__header">
        <h3 className="card__title">{t("studio.voiceLibrary.title")}</h3>
        <button className="btn btn--primary-small" disabled>
          <IconUpload size={10} /> {t("studio.voiceLibrary.upload")}
        </button>
      </div>
      <div className="card__body">
        <div className="voice-grid">
          {rows.map((row, ri) => (
            <div key={ri} className="voice-grid__row">
              {row.map((voice, vi) => (
                <div
                  key={voice.id}
                  className={`voice-item${selectedVoiceId === voice.id ? " voice-item--selected" : ""}`}
                  onClick={() => onSelectVoice(voice.id)}
                >
                  <div
                    className="voice-item__avatar"
                    style={{ background: AVATAR_COLORS[(ri * 2 + vi) % AVATAR_COLORS.length] }}
                  />
                  <div>
                    <div className="voice-item__name">{voice.name}</div>
                    <div className="voice-item__meta">
                      {voice.language}
                      {voice.durationSeconds != null ? ` · ${voice.durationSeconds.toFixed(1)}s` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
