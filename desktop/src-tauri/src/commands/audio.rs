use base64::Engine;
use rfd::FileDialog;
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

use crate::platform;

fn imported_audio_dir() -> Result<PathBuf, String> {
    let dir = platform::app_support_dir()?
        .join("imports")
        .join("reference-audio");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn import_audio_file(source_path: &Path) -> Result<PathBuf, String> {
    if !source_path.exists() {
        return Err(format!("File not found: {}", source_path.display()));
    }

    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Invalid file name: {}", source_path.display()))?;
    let destination_dir = imported_audio_dir()?.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
    let destination_path = destination_dir.join(file_name);
    fs::copy(source_path, &destination_path).map_err(|error| error.to_string())?;
    Ok(destination_path)
}

#[tauri::command]
pub async fn read_audio_base64(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    let bytes = std::fs::read(file_path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:audio/wav;base64,{b64}"))
}

#[tauri::command]
pub async fn audio_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn save_audio_as(
    path: String,
    suggested_name: Option<String>,
    default_directory: Option<String>,
) -> Result<bool, String> {
    let source_path = Path::new(&path);
    if !source_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    let default_name = suggested_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            source_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("voca-output.wav")
                .to_string()
        });

    let mut dialog = FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("WAV Audio", &["wav"]);

    if let Some(dir) = default_directory {
        let dir_path = PathBuf::from(shellexpand::tilde(&dir).into_owned());
        let _ = fs::create_dir_all(&dir_path);
        if dir_path.is_dir() {
            dialog = dialog.set_directory(&dir_path);
        }
    }

    let destination = dialog.save_file();

    let Some(destination_path) = destination else {
        return Ok(false);
    };

    std::fs::copy(source_path, &destination_path).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn pick_directory(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = FileDialog::new();
    if let Some(dir) = default_path {
        let expanded = PathBuf::from(shellexpand::tilde(&dir).into_owned());
        if expanded.is_dir() {
            dialog = dialog.set_directory(&expanded);
        }
    }
    Ok(dialog.pick_folder().map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn pick_audio_file() -> Result<Option<String>, String> {
    let selected = FileDialog::new()
        .add_filter("Audio", &["wav", "mp3", "m4a", "aac", "flac", "ogg"])
        .pick_file();

    match selected {
        Some(path) => Ok(Some(import_audio_file(&path)?.display().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn save_recorded_audio(
    audio_base64: String,
    extension: String,
) -> Result<String, String> {
    let trimmed_extension = extension.trim().trim_start_matches('.').to_lowercase();
    if trimmed_extension.is_empty() {
        return Err("Audio extension is required".to_string());
    }
    if !trimmed_extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("Unsupported audio extension: {extension}"));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|error| format!("Invalid base64 payload: {error}"))?;
    if bytes.is_empty() {
        return Err("Recorded audio payload is empty".to_string());
    }

    let destination_dir = imported_audio_dir()?.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
    let destination_path = destination_dir.join(format!("recorded.{trimmed_extension}"));
    fs::write(&destination_path, &bytes).map_err(|error| error.to_string())?;
    Ok(destination_path.display().to_string())
}
