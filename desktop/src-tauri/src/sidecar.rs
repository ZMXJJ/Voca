use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use reqwest::Client;
use tauri::{AppHandle, Manager};

use crate::state::{AppState, SidecarStatus};

const SIDECAR_HOST: &str = "127.0.0.1";
const HEALTH_RETRIES: usize = 20;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

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
    let home_dir = env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let base_dir = if cfg!(target_os = "macos") {
        PathBuf::from(home_dir)
            .join("Library")
            .join("Application Support")
    } else {
        PathBuf::from(home_dir).join(".local").join("share")
    };

    let app_support_dir = base_dir.join("Voca");
    fs::create_dir_all(&app_support_dir).map_err(|error| error.to_string())?;
    Ok(app_support_dir)
}

fn sidecar_log_path() -> Result<PathBuf, String> {
    let log_dir = voca_app_support_dir()?.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let log_path = log_dir.join("service.log");
    prepare_log_file(&log_path)?;
    Ok(log_path)
}

fn detect_site_packages(venv_root: &Path) -> Option<PathBuf> {
    let lib_root = venv_root.join("lib");
    let entries = fs::read_dir(lib_root).ok()?;

    for entry in entries.flatten() {
        let site_packages = entry.path().join("site-packages");
        if site_packages.exists() {
            return Some(site_packages);
        }
    }

    None
}

fn find_python_executable(bin_root: &Path) -> Option<PathBuf> {
    ["VocaService", "python3.11", "python3", "python"]
        .into_iter()
        .map(|name| bin_root.join(name))
        .find(|path| path.exists())
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

fn resolve_dev_sidecar_paths() -> SidecarPaths {
    let service_root = desktop_root().join("python-service");
    let voxcpm_src = repo_root().join("VoxCPM").join("src");

    SidecarPaths {
        python_executable: service_root.join(".venv/bin/python"),
        python_path_entries: Vec::new(),
        bundle_resource_dir: None,
        voxcpm_src,
        service_root,
    }
}

fn bundled_resource_roots(resource_dir: &Path) -> [PathBuf; 3] {
    [
        resource_dir.to_path_buf(),
        resource_dir.join(".bundle-resources"),
        resource_dir.join("_up_").join(".bundle-resources"),
    ]
}

fn resolve_bundled_sidecar_paths(app_handle: &AppHandle) -> Option<SidecarPaths> {
    let resource_dir = app_handle.path().resource_dir().ok()?;
    for bundle_root in bundled_resource_roots(&resource_dir) {
        let service_root = bundle_root.join("python-service");
        let runtime_root = bundle_root.join("python-runtime");
        let voxcpm_src = bundle_root.join("VoxCPM").join("src");

        if !service_root.join("app").exists() || !voxcpm_src.exists() {
            continue;
        }

        let python_executable = find_python_executable(&runtime_root.join("bin"))?;
        let site_packages = detect_site_packages(&service_root.join(".venv"))?;

        return Some(SidecarPaths {
            python_executable,
            python_path_entries: vec![service_root.clone(), site_packages, voxcpm_src.clone()],
            bundle_resource_dir: Some(bundle_root),
            voxcpm_src,
            service_root,
        });
    }
    None
}

fn resolve_sidecar_paths(app_handle: &AppHandle) -> SidecarPaths {
    resolve_bundled_sidecar_paths(app_handle).unwrap_or_else(resolve_dev_sidecar_paths)
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

fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args([
            "-t",
            "-nP",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
        ])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "failed to inspect listening sidecar process".into()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect())
}

fn kill_port_listener(port: u16) -> Result<(), String> {
    let pids = listening_pids(port)?;
    if pids.is_empty() {
        return Ok(());
    }

    for pid in &pids {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    std::thread::sleep(Duration::from_millis(300));

    for pid in listening_pids(port)? {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }

    Ok(())
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

pub async fn ensure_sidecar_running(
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
    let tracked_running = tracked_sidecar_running(state)?;
    if fetch_health(&client, port).await.unwrap_or(false) {
        let compatible = is_sidecar_compatible(&client, port).await.unwrap_or(false);
        if compatible {
            // Reuse any healthy compatible sidecar already listening on the port,
            // even if this app instance did not spawn or no longer tracks it.
            return Ok(healthy_sidecar_status());
        }

        if tracked_running {
            shutdown_sidecar(state)?;
        }
        kill_port_listener(port)?;
    }

    if fetch_health(&client, port).await.unwrap_or(false) {
        return Ok(healthy_sidecar_status());
    }

    let sidecar_paths = resolve_sidecar_paths(app_handle);
    if !sidecar_paths.python_executable.exists() {
        return Ok(SidecarStatus {
            running: false,
            healthy: false,
            reason: Some("python_service_venv_missing".into()),
        });
    }

    {
        let mut guard = state
            .sidecar
            .lock()
            .map_err(|_| "failed to lock sidecar state".to_string())?;

        let should_spawn = match guard.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(Some(_))),
            None => true,
        };

        if should_spawn {
            let mut command = Command::new(&sidecar_paths.python_executable);
            let log_path = sidecar_log_path()?;
            let app_support_dir = voca_app_support_dir()?;
            let model_dir = resolve_env_dir(&["VOCA_MODEL_DIR"], app_support_dir.join("models"));
            let hf_home = resolve_env_dir(&["HF_HOME"], app_support_dir.join("huggingface"));
            let hf_hub_cache = resolve_env_dir(&["HF_HUB_CACHE"], hf_home.join("hub"));
            let modelscope_cache =
                resolve_env_dir(&["MODELSCOPE_CACHE"], app_support_dir.join("modelscope"));
            let torch_home = resolve_env_dir(&["TORCH_HOME"], app_support_dir.join("torch"));
            fs::create_dir_all(&model_dir).map_err(|error| error.to_string())?;
            fs::create_dir_all(&hf_home).map_err(|error| error.to_string())?;
            fs::create_dir_all(&hf_hub_cache).map_err(|error| error.to_string())?;
            fs::create_dir_all(&modelscope_cache).map_err(|error| error.to_string())?;
            fs::create_dir_all(&torch_home).map_err(|error| error.to_string())?;
            let stdout_log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .map_err(|error| error.to_string())?;
            let stderr_log = stdout_log
                .try_clone()
                .map_err(|error| error.to_string())?;
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
                .current_dir(&sidecar_paths.service_root)
                .stdout(Stdio::from(stdout_log))
                .stderr(Stdio::from(stderr_log))
                .env("VOCA_PYTHON_SERVICE_ROOT", &sidecar_paths.service_root)
                .env("VOCA_VOXCPM_SRC", &sidecar_paths.voxcpm_src)
                .env("VOCA_APP_SUPPORT_DIR", &app_support_dir)
                .env("VOCA_MODEL_DIR", &model_dir)
                .env("HF_HOME", &hf_home)
                .env("HF_HUB_CACHE", &hf_hub_cache)
                .env("MODELSCOPE_CACHE", &modelscope_cache)
                .env("TORCH_HOME", &torch_home);

            if !sidecar_paths.python_path_entries.is_empty() {
                command.env(
                    "PYTHONPATH",
                    build_python_path(&sidecar_paths.python_path_entries)?,
                );
            }

            if let Some(resource_dir) = &sidecar_paths.bundle_resource_dir {
                command.env("VOCA_BUNDLE_RESOURCE_DIR", resource_dir);
            }

            let child = command.spawn().map_err(|error| error.to_string())?;

            guard.child = Some(child);
        }
    }

    for _ in 0..HEALTH_RETRIES {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if fetch_health(&client, port).await.unwrap_or(false) {
            return Ok(healthy_sidecar_status());
        }
    }

    Ok(SidecarStatus {
        running: true,
        healthy: false,
        reason: Some("python_sidecar_not_ready".into()),
    })
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
