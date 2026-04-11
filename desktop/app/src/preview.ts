export const SINGLE_PREVIEW_SCENES = [
  "welcome",
  "download",
  "initialize",
  "complete",
  "workspace",
] as const;

export type SinglePreviewScene = (typeof SINGLE_PREVIEW_SCENES)[number];
export type PreviewMode = "live" | "all" | SinglePreviewScene;

export function getPreviewModeFromSearch(search: string): PreviewMode {
  const preview = new URLSearchParams(search).get("preview");

  if (preview === "all") {
    return "all";
  }

  if (SINGLE_PREVIEW_SCENES.includes(preview as SinglePreviewScene)) {
    return preview as SinglePreviewScene;
  }

  return "live";
}
