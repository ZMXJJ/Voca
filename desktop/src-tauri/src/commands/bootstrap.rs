use std::{
    fmt::Write,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use rfd::FileDialog;
use tauri::{AppHandle, State};

use crate::{
    platform,
    sidecar::{
        ensure_sidecar_running, ensure_sidecar_started, get_json, post_json, restart_sidecar_clean,
        sidecar_runtime_available,
    },
    state::{AppError, AppState, BootstrapState, SetupDiagnostics, SidecarStatus, TaskRecord},
};

const DEFAULT_BOOTSTRAP_MODEL_KEY: &str = "voxcpm2";
const BOOTSTRAP_BUNDLE_TITLE: &str = "Prepare speech tools bundle";
const RECOMMENDED_MEMORY_BYTES: u64 = 12 * 1024 * 1024 * 1024;
const MINIMUM_FREE_STORAGE_BYTES: u64 = 6_000_000_000;
const MINIMUM_GPU_MEMORY_BYTES: u64 = 6 * 1024 * 1024 * 1024;
const CUDA_RUNTIME_COMPLETE_MARKER: &str = "cuda-runtime-complete.json";

fn onboarding_flag_path() -> Result<PathBuf, String> {
    Ok(platform::app_support_dir()?.join("onboarding.json"))
}

fn is_onboarding_complete() -> bool {
    onboarding_flag_path().map(|p| p.exists()).unwrap_or(false)
}

fn models_root_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("VOCA_MODEL_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    app_support_dir_path().ok().map(|dir| dir.join("models"))
}

const BOOTSTRAP_MODEL_KEYS: [&str; 3] = ["voxcpm2", "sensevoice_small", "zipenhancer_16k"];
const VOXCPM_REQUIRED_FILES: [&str; 3] = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const VOXCPM_AUDIO_VAE_FILES: [&str; 2] = ["audiovae.safetensors", "audiovae.pth"];
const VOXCPM_MODEL_WEIGHT_FILES: [&str; 3] =
    ["model.safetensors", "pytorch_model.bin", "model.bin"];
const AUX_ASSET_MARKER_FILES: [&str; 5] = [
    "config.json",
    "configuration.json",
    "model.pt",
    "model.bin",
    "model.safetensors",
];
/// ONNX SenseVoice lives under ``sensevoice_small_onnx/`` (catalog key remains ``sensevoice_small``).
const SENSEVOICE_ONNX_DIR: &str = "sensevoice_small_onnx";
const SENSEVOICE_ONNX_REQUIRED: [&str; 2] = ["am.mvn", "tokens.json"];
const SENSEVOICE_ONNX_WEIGHTS: [&str; 2] = ["model_quant.onnx", "model.onnx"];
/// Pre-ONNX installs used ``sensevoice_small/model.pt``.
const SENSEVOICE_LEGACY_DIR: &str = "sensevoice_small";

fn dir_has_any_file(dir: &Path, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| dir.join(candidate).exists())
}

fn dir_has_any_regular_file(dir: &Path) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            return true;
        }
        if path.is_dir() && dir_has_any_regular_file(&path) {
            return true;
        }
    }
    false
}

fn voxcpm_asset_ready(local_dir: &Path) -> bool {
    if !local_dir.is_dir() {
        return false;
    }
    if !VOXCPM_REQUIRED_FILES
        .iter()
        .all(|name| local_dir.join(name).exists())
    {
        return false;
    }
    if !dir_has_any_file(local_dir, &VOXCPM_AUDIO_VAE_FILES) {
        return false;
    }
    if !dir_has_any_file(local_dir, &VOXCPM_MODEL_WEIGHT_FILES) {
        return false;
    }
    true
}

fn voxcpm_ready_with_override() -> bool {
    if let Ok(raw) = std::env::var("VOXCPM_MODEL_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_dir() && voxcpm_asset_ready(&candidate) {
                return true;
            }
        }
    }
    match models_root_dir() {
        Some(root) => voxcpm_asset_ready(&root.join("voxcpm2")),
        None => false,
    }
}

fn aux_asset_ready(local_dir: &Path) -> bool {
    if !local_dir.is_dir() {
        return false;
    }
    if dir_has_any_file(local_dir, &AUX_ASSET_MARKER_FILES) {
        return true;
    }
    dir_has_any_regular_file(local_dir)
}

/// Match ``bootstrap_assets._is_sensevoice_onnx_ready`` + legacy ``model.pt`` dir for migration windows.
fn sensevoice_local_bootstrap_ready(models_root: &Path) -> bool {
    let onnx_dir = models_root.join(SENSEVOICE_ONNX_DIR);
    if onnx_dir.is_dir() {
        let has_required = SENSEVOICE_ONNX_REQUIRED
            .iter()
            .all(|name| onnx_dir.join(name).exists());
        let has_weights = dir_has_any_file(&onnx_dir, &SENSEVOICE_ONNX_WEIGHTS);
        if has_required && has_weights {
            return true;
        }
    }
    let legacy = models_root.join(SENSEVOICE_LEGACY_DIR);
    legacy.is_dir() && legacy.join("model.pt").exists()
}

fn local_bootstrap_asset_ready(model_key: &str) -> bool {
    match model_key {
        "voxcpm2" => voxcpm_ready_with_override(),
        "sensevoice_small" => match models_root_dir() {
            Some(root) => sensevoice_local_bootstrap_ready(&root),
            None => false,
        },
        _ => match models_root_dir() {
            Some(root) => aux_asset_ready(&root.join(model_key)),
            None => false,
        },
    }
}

fn local_bootstrap_assets_ready() -> bool {
    BOOTSTRAP_MODEL_KEYS
        .iter()
        .all(|key| local_bootstrap_asset_ready(key))
}

fn runtime_complete_marker_path() -> Option<PathBuf> {
    app_support_dir_path()
        .ok()
        .map(|dir| dir.join("runtime").join(CUDA_RUNTIME_COMPLETE_MARKER))
}

fn runtime_site_packages_path() -> Option<PathBuf> {
    app_support_dir_path()
        .ok()
        .map(|dir| dir.join("runtime").join("site-packages"))
}

fn local_runtime_ready() -> bool {
    #[cfg(target_os = "windows")]
    {
        let marker_exists = runtime_complete_marker_path()
            .map(|path| path.exists())
            .unwrap_or(false);
        let site_packages_ready = runtime_site_packages_path()
            .map(|path| path.join("torch").exists() && path.join("torchaudio").exists())
            .unwrap_or(false);
        marker_exists && site_packages_ready
    }

    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

fn app_support_dir_path() -> Result<PathBuf, String> {
    platform::app_support_dir()
}

fn environment_status_from_sidecar(sidecar: &SidecarStatus) -> String {
    if sidecar.healthy {
        return "ready".into();
    }

    match sidecar.reason.as_deref() {
        Some("python_service_venv_missing") => "missing".into(),
        Some("python_sidecar_starting") => "starting".into(),
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
    platform::reveal_in_file_manager(path)
}

async fn is_bootstrap_bundle_ready(_state: &AppState) -> bool {
    #[cfg(target_os = "windows")]
    {
        local_bootstrap_assets_ready() && local_runtime_ready()
    }

    #[cfg(not(target_os = "windows"))]
    {
        local_bootstrap_assets_ready()
    }
}

async fn list_recent_tasks(state: &AppState) -> Vec<TaskRecord> {
    get_json(state, "/api/v1/tasks?limit=50")
        .await
        .unwrap_or_default()
}

fn active_bootstrap_task(tasks: &[TaskRecord]) -> Option<&TaskRecord> {
    tasks.iter().find(|task| {
        task.r#type == "bootstrap"
            && task.title.as_deref() == Some(BOOTSTRAP_BUNDLE_TITLE)
            && matches!(task.status.as_str(), "queued" | "running")
    })
}

fn latest_failed_bootstrap_task(tasks: &[TaskRecord]) -> Option<&TaskRecord> {
    tasks.iter().find(|task| {
        task.r#type == "bootstrap"
            && task.title.as_deref() == Some(BOOTSTRAP_BUNDLE_TITLE)
            && task.status == "failed"
    })
}

#[tauri::command]
pub async fn get_quick_bootstrap_state() -> Result<BootstrapState, String> {
    let onboarding_complete = is_onboarding_complete();
    let runtime_ready = local_runtime_ready();
    let assets_ready = local_bootstrap_assets_ready() && runtime_ready;
    let needs_repair = onboarding_complete && !assets_ready;

    let is_first_launch = !onboarding_complete;
    let (phase, status, model_ready) = if needs_repair {
        ("model_download", "idle", false)
    } else if is_first_launch {
        ("welcome", "idle", false)
    } else {
        ("ready", "idle", true)
    };

    Ok(BootstrapState {
        is_first_launch,
        phase: phase.into(),
        status: status.into(),
        runtime_ready,
        model_ready,
        sidecar_ready: false,
        current_download_job_id: None,
        last_error: None,
        needs_repair,
    })
}

#[tauri::command]
pub async fn get_bootstrap_state(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    let onboarding_complete = is_onboarding_complete();
    let is_first_launch = !onboarding_complete;
    let local_runtime_ready = local_runtime_ready();
    let local_bundle_ready = local_bootstrap_assets_ready() && local_runtime_ready;
    let sidecar = ensure_sidecar_started(&app_handle, state.inner())
        .await
        .unwrap_or(SidecarStatus {
            running: false,
            healthy: false,
            reason: Some("python_sidecar_boot_failed".into()),
        });
    let bundle_ready = if sidecar.healthy {
        is_bootstrap_bundle_ready(state.inner()).await
    } else {
        local_bundle_ready
    };
    let needs_repair = onboarding_complete && !bundle_ready;
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
        } else if needs_repair {
            ("model_download", "idle", None)
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
        runtime_ready: local_runtime_ready || sidecar.running,
        model_ready: bundle_ready,
        sidecar_ready: sidecar.healthy,
        current_download_job_id,
        last_error,
        needs_repair,
    })
}

#[tauri::command]
pub async fn start_bootstrap_download(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    provider_preference: Option<String>,
) -> Result<TaskRecord, String> {
    let sidecar = restart_sidecar_clean(&app_handle, state.inner()).await?;
    if !sidecar.running {
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
pub async fn cleanup_legacy_asr_model(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let response: serde_json::Value = post_json(
        state.inner(),
        "/api/v1/bootstrap/cleanup-legacy-asr",
        &serde_json::json!({}),
    )
    .await?;
    Ok(response
        .get("removed")
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

#[tauri::command]
pub async fn start_cuda_upgrade(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TaskRecord, String> {
    // The CUDA runtime overlay is a Windows-only artifact. Refuse on every
    // other host before we even bounce the sidecar so older clients merged
    // from main don't trigger an unnecessary restart and end up parsing a
    // generic 400 from the Python service. The Python side enforces the same
    // invariant via `CudaUpgradeUnsupported`.
    if !cfg!(target_os = "windows") {
        return Err("cuda_upgrade_unsupported_platform".into());
    }

    let sidecar = restart_sidecar_clean(&app_handle, state.inner()).await?;
    if !sidecar.running {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let payload = serde_json::json!({});
    post_json(state.inner(), "/api/v1/bootstrap/upgrade-cuda", &payload).await
}

#[tauri::command]
pub async fn get_runtime_info(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), "/api/v1/bootstrap/runtime-info").await
}

#[tauri::command]
pub async fn get_sidecar_status(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SidecarStatus, String> {
    ensure_sidecar_running(&app_handle, state.inner()).await
}

#[tauri::command]
pub async fn get_bootstrap_sidecar_status(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SidecarStatus, String> {
    ensure_sidecar_started(&app_handle, state.inner()).await
}

fn detect_gpu_vendor() -> Option<String> {
    if platform::detect_nvidia_gpu().is_some() {
        return Some("nvidia".into());
    }
    None
}

fn read_active_torch_backend() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if local_runtime_ready() {
            return Some("cuda".into());
        }
    }

    let runtime_json = platform::app_support_dir()
        .ok()?
        .join("runtime")
        .join("runtime.json");
    if let Ok(content) = fs::read_to_string(runtime_json) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(active) = parsed.get("active").and_then(|value| value.as_str()) {
                return Some(active.to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        return Some("mps".into());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Some("cpu".into())
    }
}

fn host_platform_id() -> String {
    // `std::env::consts::OS` returns "windows", "macos", "linux", etc., which
    // matches the AppPlatform string union the frontend contract uses.
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn get_setup_diagnostics(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SetupDiagnostics, String> {
    let cpu_name = platform::detect_cpu_name();
    let total_memory_bytes = platform::detect_total_memory_bytes();
    let available_storage_bytes = platform::detect_available_storage_bytes();
    let gpu_vendor = detect_gpu_vendor();
    let gpu_name = platform::detect_nvidia_gpu();
    let gpu_memory_bytes = platform::detect_nvidia_gpu_memory_bytes();
    let runtime_available = sidecar_runtime_available(&app_handle);
    let sidecar = if runtime_available {
        ensure_sidecar_started(&app_handle, state.inner())
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

    // Only Windows currently gates bootstrap on an NVIDIA GPU + VRAM minimum;
    // emitting these fields on macOS/Linux would force the frontend (or older
    // clients merged from main) to either special-case a missing GPU or block
    // the user on hardware that doesn't actually need CUDA.
    let (minimum_gpu_memory_bytes, has_nvidia_gpu) = if cfg!(target_os = "windows") {
        (
            Some(MINIMUM_GPU_MEMORY_BYTES),
            Some(gpu_vendor.as_deref() == Some("nvidia")),
        )
    } else {
        (None, None)
    };

    Ok(SetupDiagnostics {
        platform: host_platform_id(),
        cpu_name,
        total_memory_bytes,
        available_storage_bytes,
        recommended_memory_bytes: RECOMMENDED_MEMORY_BYTES,
        minimum_free_storage_bytes: MINIMUM_FREE_STORAGE_BYTES,
        gpu_memory_bytes,
        minimum_gpu_memory_bytes,
        environment_ready: sidecar.healthy,
        environment_status: environment_status_from_sidecar(&sidecar),
        environment_reason: sidecar.reason,
        gpu_vendor,
        gpu_name,
        has_nvidia_gpu,
        active_torch_backend: read_active_torch_backend(),
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
pub async fn get_storage_info(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // ``/api/v1/storage-info`` is the only sidecar route that walks the
    // model + cache directories. The desktop UI deliberately gates this
    // call behind the user opening the storage details modal so the
    // foreground stays responsive on Windows where stat-storms can take
    // seconds.
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), "/api/v1/storage-info").await
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

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<bool, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP(S) URLs are allowed".into());
    }

    platform::open_external_url(&url)?;
    Ok(true)
}

#[tauri::command]
pub async fn open_microphone_settings() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(status.success());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let status = Command::new("explorer")
            .arg("ms-settings:privacy-microphone")
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        let _ = status;
        return Ok(true);
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Err("Opening microphone settings is not supported on this platform".into())
    }
}
