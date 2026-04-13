use tauri::{AppHandle, State};

use crate::{
    sidecar::{ensure_sidecar_running, get_json, post_json},
    state::{AppState, BootstrapState, SidecarStatus},
};

#[tauri::command]
pub async fn get_bootstrap_state(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner())
        .await
        .unwrap_or(SidecarStatus {
            running: false,
            healthy: false,
            reason: Some("python_sidecar_boot_failed".into()),
        });

    Ok(BootstrapState {
        is_first_launch: true,
        phase: if sidecar.healthy { "ready" } else { "welcome" }.into(),
        status: if sidecar.healthy { "ready" } else { "idle" }.into(),
        runtime_ready: sidecar.running,
        model_ready: false,
        sidecar_ready: sidecar.healthy,
        current_download_job_id: None,
        last_error: None,
    })
}

#[tauri::command]
pub async fn get_sidecar_status(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SidecarStatus, String> {
    ensure_sidecar_running(&app_handle, state.inner()).await
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
