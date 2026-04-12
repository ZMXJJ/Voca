use tauri::{AppHandle, State};

use crate::{
    sidecar::ensure_sidecar_running,
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
