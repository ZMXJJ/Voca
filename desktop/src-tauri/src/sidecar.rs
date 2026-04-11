use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use reqwest::Client;

use crate::state::{AppState, SidecarStatus};

const SIDECAR_HOST: &str = "127.0.0.1";
const HEALTH_RETRIES: usize = 20;

fn python_service_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("desktop root should exist")
        .join("python-service")
}

fn python_executable() -> PathBuf {
    python_service_root().join(".venv/bin/python")
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

pub async fn ensure_sidecar_running(state: &AppState) -> Result<SidecarStatus, String> {
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

    let python_path = python_executable();
    if !python_path.exists() {
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
            let child = Command::new(&python_path)
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
                .current_dir(python_service_root())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| error.to_string())?;

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
