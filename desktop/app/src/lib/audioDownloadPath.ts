/**
 * Where "save audio as…" dialogs open by default.
 *
 * Lives outside SettingsWorkspace so the setting can be read from the
 * generation and history workspaces without importing a component module —
 * which would also cost SettingsWorkspace its Fast Refresh support
 * (react-refresh/only-export-components).
 */

const DEFAULT_AUDIO_DOWNLOAD_PATH = "~/Downloads/Voca";
const AUDIO_DOWNLOAD_PATH_KEY = "voca.audioDownloadPath";

export function getAudioDownloadPath(): string {
  return localStorage.getItem(AUDIO_DOWNLOAD_PATH_KEY) || DEFAULT_AUDIO_DOWNLOAD_PATH;
}

export function setAudioDownloadPath(path: string): void {
  localStorage.setItem(AUDIO_DOWNLOAD_PATH_KEY, path);
}
