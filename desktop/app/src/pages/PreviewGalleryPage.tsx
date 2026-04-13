import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SINGLE_PREVIEW_SCENES, type SinglePreviewScene } from "../preview";

type PreviewGalleryPageProps = {
  scenes: Record<SinglePreviewScene, ReactNode>;
};

export function PreviewGalleryPage({ scenes }: PreviewGalleryPageProps) {
  const { t } = useTranslation();

  return (
    <main className="preview-gallery">
      <section className="preview-gallery__hero">
        <p style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--primary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {t("preview.sceneTag")}
        </p>
        <h1>{t("preview.galleryTitle")}</h1>
        <p>{t("preview.galleryDescription")}</p>
      </section>

      <div className="preview-gallery__scenes">
        {SINGLE_PREVIEW_SCENES.map((scene) => (
          <section key={scene} className="preview-scene">
            <header className="preview-scene__header">
              <div>
                <p style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--primary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  {t("preview.sceneTag")}
                </p>
                <h2>{t(`preview.${scene}`)}</h2>
                <p>{t(`preview.sceneDescription.${scene}`)}</p>
              </div>
            </header>
            <div className="preview-scene__canvas">{scenes[scene]}</div>
          </section>
        ))}
      </div>
    </main>
  );
}
