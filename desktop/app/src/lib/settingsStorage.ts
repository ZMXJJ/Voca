/**
 * Persisted user settings that are read outside React state.
 *
 * Kept in `lib/` rather than in a component module so the values can be shared
 * without breaking React Fast Refresh's "components only" export rule.
 */

export const DEFAULT_AUDIO_DOWNLOAD_PATH = "~/Downloads/Voca";

const AUDIO_DOWNLOAD_PATH_KEY = "voca.audioDownloadPath";

export function getAudioDownloadPath(): string {
  return localStorage.getItem(AUDIO_DOWNLOAD_PATH_KEY) || DEFAULT_AUDIO_DOWNLOAD_PATH;
}

export function saveAudioDownloadPath(path: string): void {
  localStorage.setItem(AUDIO_DOWNLOAD_PATH_KEY, path);
}
