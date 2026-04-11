import { useTranslation } from "react-i18next";
import { SINGLE_PREVIEW_SCENES, type PreviewMode } from "../preview";

type PreviewDockProps = {
  mode: PreviewMode;
  onChange: (mode: PreviewMode) => void;
};

export function PreviewDock({ mode, onChange }: PreviewDockProps) {
  const { t } = useTranslation();

  const options: PreviewMode[] = ["live", "all", ...SINGLE_PREVIEW_SCENES];

  return (
    <div className="preview-dock" aria-label={t("preview.dockTitle")}>
      <span className="preview-dock__title">{t("preview.dockTitle")}</span>
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
    </div>
  );
}
