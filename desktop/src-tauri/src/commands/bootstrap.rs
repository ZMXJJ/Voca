use std::{
    fmt::Write,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSNumber, NSURL, NSURLVolumeAvailableCapacityForImportantUsageKey,
};
use rfd::FileDialog;
use tauri::{AppHandle, State};

use crate::{
    sidecar::{ensure_sidecar_running, get_json, post_json, sidecar_runtime_available},
    state::{AppError, AppState, BootstrapState, SetupDiagnostics, SidecarStatus, TaskRecord},
};

const DEFAULT_BOOTSTRAP_MODEL_KEY: &str = "voxcpm2";
const BOOTSTRAP_BUNDLE_TITLE: &str = "Prepare speech tools bundle";
const RECOMMENDED_MEMORY_BYTES: u64 = 12 * 1024 * 1024 * 1024;
const MINIMUM_FREE_STORAGE_BYTES: u64 = 5_000_000_000;

fn onboarding_flag_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
    } else {
        PathBuf::from(home).join(".local").join("share")
    };
    let dir = base.join("Voca");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("onboarding.json"))
}

fn is_onboarding_complete() -> bool {
    onboarding_flag_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

fn app_support_dir_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
    } else {
        PathBuf::from(home).join(".local").join("share")
    };
    let dir = base.join("Voca");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn detect_cpu_name() -> Option<String> {
    if cfg!(target_os = "macos") {
        if let Some(name) = read_command_output("sysctl", &["-n", "machdep.cpu.brand_string"]) {
            return Some(name);
        }

        if let Some(profile) = read_command_output("system_profiler", &["SPHardwareDataType"]) {
            for raw_line in profile.lines() {
                let line = raw_line.trim();
                if let Some(value) = line.strip_prefix("Chip:") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
                if let Some(value) = line.strip_prefix("Processor Name:") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }

    Some(std::env::consts::ARCH.to_string())
}

fn detect_total_memory_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        return read_command_output("sysctl", &["-n", "hw.memsize"])?.parse().ok();
    }
    None
}

fn detect_available_storage_bytes_from_df() -> Option<u64> {
    let target = app_support_dir_path().ok()?;
    let target_string = target.to_string_lossy().to_string();
    let output = read_command_output("df", &["-k", &target_string])?;
    let line = output.lines().nth(1)?.trim();
    let available_kb = line
        .split_whitespace()
        .nth(3)
        .and_then(|value| value.parse::<u64>().ok())?;
    Some(available_kb.saturating_mul(1024))
}

#[cfg(target_os = "macos")]
fn detect_available_storage_bytes_macos() -> Option<u64> {
    let target = app_support_dir_path().ok()?;
    let url = NSURL::from_file_path(target)?;
    let mut value = None;
    unsafe {
        url.getResourceValue_forKey_error(
            &mut value,
            &NSURLVolumeAvailableCapacityForImportantUsageKey,
        )
    }
    .ok()?;
    let number = value?.downcast::<NSNumber>().ok()?;
    let capacity = number.as_u64();
    if capacity > 0 { Some(capacity) } else { None }
}

fn detect_available_storage_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    if let Some(capacity) = detect_available_storage_bytes_macos() {
        return Some(capacity);
    }

    detect_available_storage_bytes_from_df()
}

fn environment_status_from_sidecar(sidecar: &SidecarStatus) -> String {
    if sidecar.healthy {
        return "ready".into();
    }

    match sidecar.reason.as_deref() {
        Some("python_service_venv_missing") => "missing".into(),
        Some("python_sidecar_not_ready") => "starting".into(),
        Some(_) => "error".into(),
        None if sidecar.running => "starting".into(),
        None => "error".into(),
    }
}

fn default_log_export_name() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("voca-logs-{timestamp}.txt")
}

fn render_log_export(log_dir: &Path) -> Result<String, String> {
    let mut paths = if log_dir.exists() {
        fs::read_dir(log_dir)
            .map_err(|error| error.to_string())?
            .filter_map(|entry| entry.ok().map(|item| item.path()))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    paths.sort();

    let mut output = String::new();
    writeln!(&mut output, "Voca Logs Export").map_err(|error| error.to_string())?;
    writeln!(&mut output, "Source Directory: {}", log_dir.display())
        .map_err(|error| error.to_string())?;
    writeln!(&mut output).map_err(|error| error.to_string())?;

    if paths.is_empty() {
        writeln!(&mut output, "No log files found.").map_err(|error| error.to_string())?;
        return Ok(output);
    }

    for path in paths {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        writeln!(&mut output, "===== {} =====", path.display())
            .map_err(|error| error.to_string())?;
        output.push_str(&String::from_utf8_lossy(&bytes));
        if !output.ends_with('\n') {
            output.push('\n');
        }
        writeln!(&mut output).map_err(|error| error.to_string())?;
    }

    Ok(output)
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    let status = command
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open path: {}", path.display()))
    }
}

async fn is_bootstrap_bundle_ready(state: &AppState) -> bool {
    let response: serde_json::Value = match get_json(state, "/api/v1/health").await {
        Ok(value) => value,
        Err(_) => return false,
    };

    response
        .get("bootstrapAssetsReady")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

async fn list_recent_tasks(state: &AppState) -> Vec<TaskRecord> {
    get_json(state, "/api/v1/tasks?limit=50").await.unwrap_or_default()
}

fn active_bootstrap_task(tasks: &[TaskRecord]) -> Option<&TaskRecord> {
    tasks.iter().find(|task| {
        task.r#type == "bootstrap"
            && task.title.as_deref() == Some(BOOTSTRAP_BUNDLE_TITLE)
            && matches!(task.status.as_str(), "queued" | "running")
    })
}

fn latest_failed_bootstrap_task(tasks: &[TaskRecord]) -> Option<&TaskRecord> {
    tasks.iter()
        .find(|task| {
            task.r#type == "bootstrap"
                && task.title.as_deref() == Some(BOOTSTRAP_BUNDLE_TITLE)
                && task.status == "failed"
        })
}

#[tauri::command]
pub async fn get_quick_bootstrap_state() -> Result<BootstrapState, String> {
    let is_first_launch = !is_onboarding_complete();
    let (phase, status, model_ready) = if is_first_launch {
        ("welcome", "idle", false)
    } else {
        ("ready", "idle", true)
    };

    Ok(BootstrapState {
        is_first_launch,
        phase: phase.into(),
        status: status.into(),
        runtime_ready: false,
        model_ready,
        sidecar_ready: false,
        current_download_job_id: None,
        last_error: None,
    })
}

#[tauri::command]
pub async fn get_bootstrap_state(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    let is_first_launch = !is_onboarding_complete();
    let sidecar = ensure_sidecar_running(&app_handle, state.inner())
        .await
        .unwrap_or(SidecarStatus {
            running: false,
            healthy: false,
            reason: Some("python_sidecar_boot_failed".into()),
        });
    let bundle_ready = if sidecar.healthy {
        is_bootstrap_bundle_ready(state.inner()).await
    } else {
        false
    };
    let tasks = if sidecar.healthy {
        list_recent_tasks(state.inner()).await
    } else {
        Vec::new()
    };
    let running_bootstrap_task = active_bootstrap_task(&tasks);
    let failed_bootstrap_task = latest_failed_bootstrap_task(&tasks);
    let last_error: Option<AppError> = failed_bootstrap_task.and_then(|task| task.error.clone());
    let (phase, status, current_download_job_id) = if !sidecar.healthy {
        if sidecar.running {
            ("runtime_download", "running", None)
        } else {
            ("welcome", "idle", None)
        }
    } else if bundle_ready {
        ("ready", "ready", None)
    } else if let Some(task) = running_bootstrap_task {
        ("model_download", "running", Some(task.id.clone()))
    } else if let Some(task) = failed_bootstrap_task {
        ("failed", "failed", Some(task.id.clone()))
    } else if is_first_launch {
        ("welcome", "idle", None)
    } else {
        ("model_download", "idle", None)
    };

    Ok(BootstrapState {
        is_first_launch,
        phase: phase.into(),
        status: status.into(),
        runtime_ready: sidecar.running,
        model_ready: bundle_ready,
        sidecar_ready: sidecar.healthy,
        current_download_job_id,
        last_error,
    })
}

#[tauri::command]
pub async fn start_bootstrap_download(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    provider_preference: Option<String>,
) -> Result<TaskRecord, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let payload = serde_json::json!({
        "modelKey": DEFAULT_BOOTSTRAP_MODEL_KEY,
        "providerPreference": provider_preference.unwrap_or_else(|| "auto".into()),
    });
    post_json(state.inner(), "/api/v1/bootstrap/start", &payload).await
}

#[tauri::command]
pub async fn get_sidecar_status(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SidecarStatus, String> {
    ensure_sidecar_running(&app_handle, state.inner()).await
}

#[tauri::command]
pub async fn get_setup_diagnostics(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SetupDiagnostics, String> {
    let cpu_name = detect_cpu_name();
    let total_memory_bytes = detect_total_memory_bytes();
    let available_storage_bytes = detect_available_storage_bytes();
    let runtime_available = sidecar_runtime_available(&app_handle);
    let sidecar = if runtime_available {
        ensure_sidecar_running(&app_handle, state.inner())
            .await
            .unwrap_or(SidecarStatus {
                running: false,
                healthy: false,
                reason: Some("python_sidecar_boot_failed".into()),
            })
    } else {
        SidecarStatus {
            running: false,
            healthy: false,
            reason: Some("python_service_venv_missing".into()),
        }
    };

    Ok(SetupDiagnostics {
        cpu_name,
        total_memory_bytes,
        available_storage_bytes,
        recommended_memory_bytes: RECOMMENDED_MEMORY_BYTES,
        minimum_free_storage_bytes: MINIMUM_FREE_STORAGE_BYTES,
        environment_ready: sidecar.healthy,
        environment_status: environment_status_from_sidecar(&sidecar),
        environment_reason: sidecar.reason,
    })
}

#[tauri::command]
pub async fn get_service_info(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), "/api/v1/health").await
}

#[tauri::command]
pub async fn clear_cache(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let empty = serde_json::json!({});
    post_json(state.inner(), "/api/v1/cache/clear", &empty).await
}

#[tauri::command]
pub async fn export_logs(log_dir: String) -> Result<bool, String> {
    let source_dir = PathBuf::from(log_dir);
    let destination = FileDialog::new()
        .set_file_name(&default_log_export_name())
        .add_filter("Text", &["txt", "log"])
        .save_file();

    let Some(destination_path) = destination else {
        return Ok(false);
    };

    let rendered = render_log_export(&source_dir)?;
    fs::write(destination_path, rendered).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn complete_onboarding() -> Result<bool, String> {
    let path = onboarding_flag_path()?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let content = format!(r#"{{"completedAt":{timestamp}}}"#);
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn open_storage_directory(path: String) -> Result<bool, String> {
    let target_path = PathBuf::from(path);
    if !target_path.exists() {
        return Err(format!("Path not found: {}", target_path.display()));
    }

    reveal_in_file_manager(&target_path)?;
    Ok(true)
}
