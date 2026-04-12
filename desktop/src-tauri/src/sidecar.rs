use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use reqwest::Client;
use tauri::{AppHandle, Manager};

use crate::state::{AppState, SidecarStatus};

const SIDECAR_HOST: &str = "127.0.0.1";
const HEALTH_RETRIES: usize = 20;

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
    ["python3.11", "python3", "python"]
        .into_iter()
        .map(|name| bin_root.join(name))
        .find(|path| path.exists())
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

fn resolve_bundled_sidecar_paths(app_handle: &AppHandle) -> Option<SidecarPaths> {
    let resource_dir = app_handle.path().resource_dir().ok()?;
    let service_root = resource_dir.join("python-service");
    let runtime_root = resource_dir.join("python-runtime");
    let python_executable = find_python_executable(&runtime_root.join("bin"))?;
    let site_packages = detect_site_packages(&service_root.join(".venv"))?;
    let voxcpm_src = resource_dir.join("VoxCPM").join("src");

    if !service_root.join("app").exists() || !voxcpm_src.exists() {
        return None;
    }

    Some(SidecarPaths {
        python_executable,
        python_path_entries: vec![service_root.clone(), site_packages, voxcpm_src.clone()],
        bundle_resource_dir: Some(resource_dir),
        voxcpm_src,
        service_root,
    })
}

fn resolve_sidecar_paths(app_handle: &AppHandle) -> SidecarPaths {
    resolve_bundled_sidecar_paths(app_handle).unwrap_or_else(resolve_dev_sidecar_paths)
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
    if fetch_health(&client, port).await.unwrap_or(false) {
        return Ok(SidecarStatus {
            running: true,
            healthy: true,
            reason: None,
        });
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
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .env("VOCA_PYTHON_SERVICE_ROOT", &sidecar_paths.service_root)
                .env("VOCA_VOXCPM_SRC", &sidecar_paths.voxcpm_src);

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
            return Ok(SidecarStatus {
                running: true,
                healthy: true,
                reason: None,
            });
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

    Client::new()
        .get(format!("{}{}", sidecar_url(port), path))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<T>()
        .await
        .map_err(|error| error.to_string())
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

    Client::new()
        .post(format!("{}{}", sidecar_url(port), path))
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<T>()
        .await
        .map_err(|error| error.to_string())
}
