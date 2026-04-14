use base64::Engine;
use rfd::FileDialog;
use std::path::{Path, PathBuf};

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
pub async fn pick_audio_file() -> Result<Option<String>, String> {
    let selected = FileDialog::new()
        .add_filter("Audio", &["wav", "mp3", "m4a", "aac", "flac", "ogg"])
        .pick_file();

    Ok(selected.map(|path| path.display().to_string()))
}
