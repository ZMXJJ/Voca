use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use reqwest::Client;
use tauri::{AppHandle, Manager};

use crate::platform;
use crate::state::{AppState, SidecarStatus};

const SIDECAR_HOST: &str = "127.0.0.1";
const HEALTH_RETRIES: usize = 60;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const VOCA_RUNTIME_SITE_PACKAGES_ENV: &str = "VOCA_RUNTIME_SITE_PACKAGES";
const CUDA_RUNTIME_COMPLETE_MARKER: &str = "cuda-runtime-complete.json";
const VOCA_DEV_BUNDLE_ROOT_ENV: &str = "VOCA_DEV_BUNDLE_ROOT";

struct SidecarPaths {
    service_root: PathBuf,
    python_executable: PathBuf,
    python_path_entries: Vec<PathBuf>,
    bundle_resource_dir: Option<PathBuf>,
    voxcpm_src: PathBuf,
}

fn desktop_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("desktop root should exist")
        .to_path_buf()
}

fn repo_root() -> PathBuf {
    desktop_root()
        .parent()
        .expect("repo root should exist")
        .to_path_buf()
}

fn voca_app_support_dir() -> Result<PathBuf, String> {
    platform::app_support_dir()
}

fn sidecar_log_path() -> Result<PathBuf, String> {
    let log_dir = voca_app_support_dir()?.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let log_path = log_dir.join("service.log");
    prepare_log_file(&log_path)?;
    Ok(log_path)
}

fn detect_site_packages(venv_root: &Path) -> Option<PathBuf> {
    platform::detect_site_packages(venv_root)
}

fn find_python_executable(venv_root: &Path) -> Option<PathBuf> {
    platform::find_python_executable(venv_root)
}

fn prepare_log_file(log_path: &Path) -> Result<(), String> {
    let metadata = match fs::metadata(log_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };

    if metadata.len() < LOG_ROTATE_BYTES {
        return Ok(());
    }

    let rotated_path = log_path.with_extension("log.1");
    if rotated_path.exists() {
        fs::remove_file(&rotated_path).map_err(|error| error.to_string())?;
    }
    fs::rename(log_path, rotated_path).map_err(|error| error.to_string())
}

fn resolve_env_dir(var_names: &[&str], default_path: PathBuf) -> PathBuf {
    var_names
        .iter()
        .find_map(|name| env::var_os(name))
        .map(PathBuf::from)
        .unwrap_or(default_path)
}

fn runtime_site_packages_dir(app_support_dir: &Path) -> PathBuf {
    app_support_dir.join("runtime").join("site-packages")
}

fn runtime_complete_marker_path(app_support_dir: &Path) -> PathBuf {
    app_support_dir
        .join("runtime")
        .join(CUDA_RUNTIME_COMPLETE_MARKER)
}

fn runtime_overlay_ready(app_support_dir: &Path) -> bool {
    let site_packages = runtime_site_packages_dir(app_support_dir);
    runtime_complete_marker_path(app_support_dir).exists()
        && site_packages.join("torch").exists()
        && site_packages.join("torchaudio").exists()
}

fn resolve_dev_sidecar_paths() -> SidecarPaths {
    let service_root = desktop_root().join("python-service");
    let voxcpm_src = repo_root().join("VoxCPM").join("src");

    let venv_root = service_root.join(".venv");
    let python_executable = find_python_executable(&venv_root).unwrap_or_else(|| {
        // Fallback so callers still see a predictable path when the venv isn't ready yet.
        venv_root
            .join(platform::venv_bin_subdir())
            .join(platform::python_executable_candidates()[0])
    });

    SidecarPaths {
        python_executable,
        python_path_entries: Vec::new(),
        bundle_resource_dir: None,
        voxcpm_src,
        service_root,
    }
}

fn bundled_resource_roots(resource_dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        resource_dir.to_path_buf(),
        resource_dir.join(".bundle-resources"),
        resource_dir.join(".bundle-resources-win"),
        resource_dir.join("_up_").join(".bundle-resources"),
        resource_dir.join("_up_").join(".bundle-resources-win"),
    ];
    roots.dedup();
    roots
}

fn sidecar_paths_from_bundle_root(bundle_root: &Path) -> Option<SidecarPaths> {
    let service_root = bundle_root.join("python-service");
    let runtime_root = bundle_root.join("python-runtime");
    let voxcpm_src = bundle_root.join("VoxCPM").join("src");

    if !service_root.join("app").exists() || !voxcpm_src.exists() {
        return None;
    }

    let python_executable = find_python_executable(&runtime_root)?;
    let site_packages = detect_site_packages(&service_root.join(".venv"))?;

    Some(SidecarPaths {
        python_executable,
        python_path_entries: vec![service_root.clone(), site_packages, voxcpm_src.clone()],
        bundle_resource_dir: Some(bundle_root.to_path_buf()),
        voxcpm_src,
        service_root,
    })
}

fn resolve_explicit_bundle_sidecar_paths() -> Option<SidecarPaths> {
    let bundle_root = env::var_os(VOCA_DEV_BUNDLE_ROOT_ENV)?;
    sidecar_paths_from_bundle_root(Path::new(&bundle_root))
}

fn resolve_bundled_sidecar_paths(app_handle: &AppHandle) -> Option<SidecarPaths> {
    let resource_dir = app_handle.path().resource_dir().ok()?;
    for bundle_root in bundled_resource_roots(&resource_dir) {
        if let Some(paths) = sidecar_paths_from_bundle_root(&bundle_root) {
            return Some(paths);
        }
    }
    None
}

fn resolve_sidecar_paths(app_handle: &AppHandle) -> SidecarPaths {
    resolve_explicit_bundle_sidecar_paths()
        .or_else(|| resolve_bundled_sidecar_paths(app_handle))
        .unwrap_or_else(resolve_dev_sidecar_paths)
}

pub fn sidecar_runtime_available(app_handle: &AppHandle) -> bool {
    resolve_sidecar_paths(app_handle).python_executable.exists()
}

fn build_python_path(extra_paths: &[PathBuf]) -> Result<OsString, String> {
    let mut all_paths = extra_paths.to_vec();
    if let Some(existing) = env::var_os("PYTHONPATH") {
        all_paths.extend(env::split_paths(&existing));
    }

    env::join_paths(all_paths).map_err(|error| error.to_string())
}

fn sidecar_url(port: u16) -> String {
    format!("http://{SIDECAR_HOST}:{port}")
}

async fn fetch_health(client: &Client, port: u16) -> Result<bool, String> {
    let response = client
        .get(format!("{}/api/v1/health", sidecar_url(port)))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    Ok(response.status().is_success())
}

async fn fetch_probe(client: &Client, port: u16) -> Result<bool, String> {
    let response = client
        .get(format!("{}/api/v1/probe", sidecar_url(port)))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Ok(false);
    }

    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;

    Ok(payload.get("service").and_then(|value| value.as_str()) == Some("voca-python-service"))
}

async fn fetch_openapi_spec(client: &Client, port: u16) -> Result<serde_json::Value, String> {
    let response = client
        .get(format!("{}/openapi.json", sidecar_url(port)))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Ok(serde_json::json!({}));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

async fn is_sidecar_compatible(client: &Client, port: u16) -> Result<bool, String> {
    let openapi = fetch_openapi_spec(client, port).await?;
    let paths = openapi
        .get("paths")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();

    Ok(paths.contains_key("/api/v1/voices")
        && paths.contains_key("/api/v1/voices/{voice_id}")
        && paths.contains_key("/api/v1/tasks"))
}

fn tracked_sidecar_running(state: &AppState) -> Result<bool, String> {
    let mut guard = state
        .sidecar
        .lock()
        .map_err(|_| "failed to lock sidecar state".to_string())?;

    let mut exited = false;
    let running = match guard.child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => {
                exited = true;
                false
            }
            Err(error) => return Err(error.to_string()),
        },
        None => false,
    };

    if exited {
        guard.child = None;
    }

    Ok(running)
}

fn kill_port_listener(port: u16) -> Result<(), String> {
    platform::kill_port_listener(port)
}

/// Probe the Python runtime's torch install and automatically restore the
/// previous backend from ``runtime/rollback/`` if the current one is broken.
///
/// Implementation note: we defer the work to the sidecar's own Python so we
/// don't have to re-implement the swap semantics in Rust. The call is best-
/// effort — if anything goes wrong we just log and continue; the FastAPI health
/// probe in ``ensure_sidecar_running`` will surface any remaining failures.
#[cfg(not(target_os = "windows"))]
fn ensure_torch_healthy(paths: &SidecarPaths) {
    if !paths.python_executable.exists() {
        return;
    }

    let mut command = Command::new(&paths.python_executable);
    command.arg("-c");
    command.arg(concat!(
        "import json, sys\n",
        "try:\n",
        "    from app.services.cuda_upgrade import ensure_torch_healthy\n",
        "except Exception as exc:\n",
        "    print(json.dumps({'action': 'import_failed', 'message': str(exc)}))\n",
        "    sys.exit(0)\n",
        "report = ensure_torch_healthy()\n",
        "print(json.dumps(report))\n",
    ));

    // Feed the same PYTHONPATH entries we pass to the sidecar so the `app`
    // package can be imported even when it lives inside the bundled resources.
    if !paths.python_path_entries.is_empty() {
        let joined = std::env::join_paths(&paths.python_path_entries);
        if let Ok(value) = joined {
            command.env("PYTHONPATH", value);
        }
    }
    command.current_dir(&paths.service_root);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    match command.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stdout.trim().is_empty() {
                eprintln!("[voca][self-heal] {}", stdout.trim());
            }
            if !stderr.trim().is_empty() {
                eprintln!("[voca][self-heal][stderr] {}", stderr.trim());
            }
        }
        Err(error) => {
            eprintln!("[voca][self-heal] failed to run self-heal probe: {error}");
        }
    }
}

pub fn shutdown_sidecar(state: &AppState) -> Result<(), String> {
    let mut guard = state
        .sidecar
        .lock()
        .map_err(|_| "failed to lock sidecar state".to_string())?;

    if let Some(mut child) = guard.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(())
}

async fn decode_json_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("request failed with status {status}"));
        }
        return Err(format!("request failed with status {status}: {detail}"));
    }

    response
        .json::<T>()
        .await
        .map_err(|error| error.to_string())
}

async fn ensure_success(response: reqwest::Response) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    let detail = body.trim();
    if detail.is_empty() {
        return Err(format!("request failed with status {status}"));
    }
    Err(format!("request failed with status {status}: {detail}"))
}

fn healthy_sidecar_status() -> SidecarStatus {
    SidecarStatus {
        running: true,
        healthy: true,
        reason: None,
    }
}

fn starting_sidecar_status() -> SidecarStatus {
    SidecarStatus {
        running: true,
        healthy: false,
        reason: Some("python_sidecar_starting".into()),
    }
}

fn spawn_sidecar_if_needed(app_handle: &AppHandle, state: &AppState) -> Result<(), String> {
    let sidecar_paths = resolve_sidecar_paths(app_handle);
    if !sidecar_paths.python_executable.exists() {
        return Err("python_service_venv_missing".into());
    }

    #[cfg(not(target_os = "windows"))]
    {
        ensure_torch_healthy(&sidecar_paths);
    }

    let mut guard = state
        .sidecar
        .lock()
        .map_err(|_| "failed to lock sidecar state".to_string())?;

    let should_spawn = match guard.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => true,
    };

    if !should_spawn {
        return Ok(());
    }

    let mut command = Command::new(&sidecar_paths.python_executable);
    let log_path = sidecar_log_path()?;
    let app_support_dir = voca_app_support_dir()?;
    let model_dir = resolve_env_dir(&["VOCA_MODEL_DIR"], app_support_dir.join("models"));
    let hf_home = resolve_env_dir(&["HF_HOME"], app_support_dir.join("huggingface"));
    let hf_hub_cache = resolve_env_dir(&["HF_HUB_CACHE"], hf_home.join("hub"));
    let modelscope_cache =
        resolve_env_dir(&["MODELSCOPE_CACHE"], app_support_dir.join("modelscope"));
    let torch_home = resolve_env_dir(&["TORCH_HOME"], app_support_dir.join("torch"));
    let sidecar_cwd = app_support_dir.join("sidecar-cwd");
    fs::create_dir_all(&model_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&hf_home).map_err(|error| error.to_string())?;
    fs::create_dir_all(&hf_hub_cache).map_err(|error| error.to_string())?;
    fs::create_dir_all(&modelscope_cache).map_err(|error| error.to_string())?;
    fs::create_dir_all(&torch_home).map_err(|error| error.to_string())?;
    fs::create_dir_all(&sidecar_cwd).map_err(|error| error.to_string())?;
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let stderr_log = stdout_log.try_clone().map_err(|error| error.to_string())?;
    command
        .args([
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            SIDECAR_HOST,
            "--port",
            &guard.port.to_string(),
            "--log-level",
            "warning",
        ])
        // Use a dedicated, writable scratch directory under app_support as the
        // child process CWD instead of the service source directory. On Windows
        // a process holds a directory handle on its CWD for the entire lifetime,
        // which previously prevented users from deleting/moving the install or
        // repository directory while the app was running. The Python service
        // does not rely on CWD-based imports — `service_root` is now placed on
        // PYTHONPATH explicitly below.
        .current_dir(&sidecar_cwd)
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .env("VOCA_PYTHON_SERVICE_ROOT", &sidecar_paths.service_root)
        .env("VOCA_VOXCPM_SRC", &sidecar_paths.voxcpm_src)
        .env("VOCA_APP_SUPPORT_DIR", &app_support_dir)
        .env("VOCA_MODEL_DIR", &model_dir)
        .env("HF_HOME", &hf_home)
        .env("HF_HUB_CACHE", &hf_hub_cache)
        .env("MODELSCOPE_CACHE", &modelscope_cache)
        .env("TORCH_HOME", &torch_home)
        .env("VOCA_REQUIRE_CUDA", "1")
        // Disable .pyc generation so Python never writes __pycache__ folders
        // into the bundled service / VoxCPM source trees. This both avoids
        // cluttering the install directory and removes the short-lived write
        // locks Windows holds while compiling .pyc files.
        .env("PYTHONDONTWRITEBYTECODE", "1");

    let mut python_path_entries = sidecar_paths.python_path_entries.clone();
    // Always make the service root importable via PYTHONPATH instead of relying
    // on the working directory. In bundle mode `service_root` is already part of
    // `python_path_entries`; in dev mode it is empty and we must inject it now
    // that we no longer cd into the service directory.
    if !python_path_entries
        .iter()
        .any(|entry| entry == &sidecar_paths.service_root)
    {
        python_path_entries.push(sidecar_paths.service_root.clone());
    }
    if !python_path_entries
        .iter()
        .any(|entry| entry == &sidecar_paths.voxcpm_src)
    {
        python_path_entries.push(sidecar_paths.voxcpm_src.clone());
    }
    #[cfg(target_os = "windows")]
    {
        let runtime_site_packages = runtime_site_packages_dir(&app_support_dir);
        fs::create_dir_all(&runtime_site_packages).map_err(|error| error.to_string())?;
        command.env(VOCA_RUNTIME_SITE_PACKAGES_ENV, &runtime_site_packages);
        if runtime_overlay_ready(&app_support_dir) {
            python_path_entries.insert(0, runtime_site_packages);
        }
    }
    if !python_path_entries.is_empty() {
        command.env("PYTHONPATH", build_python_path(&python_path_entries)?);
    }

    if let Some(resource_dir) = &sidecar_paths.bundle_resource_dir {
        command.env("VOCA_BUNDLE_RESOURCE_DIR", resource_dir);
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command.spawn().map_err(|error| error.to_string())?;
    guard.child = Some(child);
    Ok(())
}

pub async fn ensure_sidecar_started(
    app_handle: &AppHandle,
    state: &AppState,
) -> Result<SidecarStatus, String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let client = Client::new();
    if fetch_probe(&client, port).await.unwrap_or(false) {
        return Ok(healthy_sidecar_status());
    }

    let tracked_running = tracked_sidecar_running(state)?;
    if fetch_health(&client, port).await.unwrap_or(false) {
        let compatible = is_sidecar_compatible(&client, port).await.unwrap_or(false);
        if compatible {
            return Ok(healthy_sidecar_status());
        }

        if tracked_running {
            shutdown_sidecar(state)?;
        }
        kill_port_listener(port)?;
    }

    match spawn_sidecar_if_needed(app_handle, state) {
        Ok(()) => {}
        Err(error) if error == "python_service_venv_missing" => {
            return Ok(SidecarStatus {
                running: false,
                healthy: false,
                reason: Some(error),
            });
        }
        Err(error) => return Err(error),
    }

    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if fetch_probe(&client, port).await.unwrap_or(false) {
            return Ok(healthy_sidecar_status());
        }
    }

    Ok(starting_sidecar_status())
}

pub async fn restart_sidecar_clean(
    app_handle: &AppHandle,
    state: &AppState,
) -> Result<SidecarStatus, String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let _ = shutdown_sidecar(state);
    let _ = kill_port_listener(port);

    match spawn_sidecar_if_needed(app_handle, state) {
        Ok(()) => {}
        Err(error) if error == "python_service_venv_missing" => {
            return Ok(SidecarStatus {
                running: false,
                healthy: false,
                reason: Some(error),
            });
        }
        Err(error) => return Err(error),
    }

    let client = Client::new();
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if fetch_probe(&client, port).await.unwrap_or(false) {
            return Ok(healthy_sidecar_status());
        }
    }

    Ok(starting_sidecar_status())
}

pub async fn ensure_sidecar_running(
    app_handle: &AppHandle,
    state: &AppState,
) -> Result<SidecarStatus, String> {
    let started = ensure_sidecar_started(app_handle, state).await?;
    if !started.running {
        return Ok(started);
    }

    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };
    let client = Client::new();

    for _ in 0..HEALTH_RETRIES {
        if fetch_health(&client, port).await.unwrap_or(false) {
            if is_sidecar_compatible(&client, port).await.unwrap_or(false) {
                return Ok(healthy_sidecar_status());
            }

            if tracked_sidecar_running(state)? {
                shutdown_sidecar(state)?;
            }
            kill_port_listener(port)?;
            spawn_sidecar_if_needed(app_handle, state)?;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Ok(starting_sidecar_status())
}

pub async fn get_json<T: serde::de::DeserializeOwned>(
    state: &AppState,
    path: &str,
) -> Result<T, String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let response = Client::new()
        .get(format!("{}{}", sidecar_url(port), path))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    decode_json_response(response).await
}

pub async fn post_json<B: serde::Serialize, T: serde::de::DeserializeOwned>(
    state: &AppState,
    path: &str,
    body: &B,
) -> Result<T, String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let response = Client::new()
        .post(format!("{}{}", sidecar_url(port), path))
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    decode_json_response(response).await
}

pub async fn patch_json<B: serde::Serialize, T: serde::de::DeserializeOwned>(
    state: &AppState,
    path: &str,
    body: &B,
) -> Result<T, String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let response = Client::new()
        .patch(format!("{}{}", sidecar_url(port), path))
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    decode_json_response(response).await
}

pub async fn delete_ok(state: &AppState, path: &str) -> Result<(), String> {
    let port = {
        let guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;
        guard.port
    };

    let response = Client::new()
        .delete(format!("{}{}", sidecar_url(port), path))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    ensure_success(response).await
}
