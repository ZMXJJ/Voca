import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SINGLE_PREVIEW_SCENES, type PreviewMode } from "../preview";
import {
  SIM_PROFILE_KEYS,
  SIM_SPEED_KEYS,
  type SimProfileKey,
  type SimSpeedKey,
} from "../lib/previewSimulation";

type PreviewSimControls = {
  profileKey: SimProfileKey;
  onProfileChange: (key: SimProfileKey) => void;
  speedKey: SimSpeedKey;
  onSpeedChange: (key: SimSpeedKey) => void;
  paused: boolean;
  onTogglePaused: () => void;
  onRestart: () => void;
  onInjectFailure: () => void;
  failureArmed: boolean;
};

type PreviewDockProps = {
  mode: PreviewMode;
  onChange: (mode: PreviewMode) => void;
  sim: PreviewSimControls;
};

const COLLAPSED_KEY = "voca.previewDock.collapsed";

export function PreviewDock({ mode, onChange, sim }: PreviewDockProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return sessionStorage.getItem(COLLAPSED_KEY) !== "0";
    } catch {
      return true;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // sessionStorage unavailable — collapse state just won't persist.
      }
      return next;
    });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="preview-dock preview-dock--collapsed"
        onClick={toggleCollapsed}
        aria-label={t("preview.expandDock")}
      >
        {t("preview.dockTitle")}
      </button>
    );
  }

  const options: PreviewMode[] = ["live", "all", ...SINGLE_PREVIEW_SCENES];
  const showSimControls = mode !== "live" && mode !== "all";

  return (
    <div className="preview-dock" aria-label={t("preview.dockTitle")}>
      <div className="preview-dock__header">
        <span className="preview-dock__title">{t("preview.dockTitle")}</span>
        <button
          type="button"
          className="preview-dock__collapse"
          onClick={toggleCollapsed}
          aria-label={t("preview.collapseDock")}
        >
          ×
        </button>
      </div>
      <div className="preview-dock__options">
        {options.map((option) => (
          <button
            key={option}
            className={`preview-dock__option ${
              mode === option ? "preview-dock__option--active" : ""
            }`}
            onClick={() => onChange(option)}
          >
            {t(`preview.${option}`)}
          </button>
        ))}
      </div>

      {showSimControls && (
        <div className="preview-dock__sim">
          <label className="preview-dock__sim-field">
            <span>{t("preview.sim.profile")}</span>
            <select
              value={sim.profileKey}
              onChange={(event) => sim.onProfileChange(event.target.value as SimProfileKey)}
            >
              {SIM_PROFILE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {t(`preview.sim.profiles.${key}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="preview-dock__sim-field">
            <span>{t("preview.sim.speed")}</span>
            <select
              value={sim.speedKey}
              onChange={(event) => sim.onSpeedChange(event.target.value as SimSpeedKey)}
            >
              {SIM_SPEED_KEYS.map((key) => (
                <option key={key} value={key}>
                  {t(`preview.sim.speeds.${key}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="preview-dock__sim-actions">
            <button type="button" className="preview-dock__option" onClick={sim.onTogglePaused}>
              {sim.paused ? t("preview.sim.resume") : t("preview.sim.pause")}
            </button>
            <button type="button" className="preview-dock__option" onClick={sim.onRestart}>
              {t("preview.sim.restart")}
            </button>
            <button
              type="button"
              className={`preview-dock__option${sim.failureArmed ? " preview-dock__option--active" : ""}`}
              onClick={sim.onInjectFailure}
            >
              {t("preview.sim.injectFailure")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
