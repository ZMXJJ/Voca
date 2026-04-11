use crate::state::{BootstrapState, SidecarStatus};

#[tauri::command]
pub async fn get_bootstrap_state() -> BootstrapState {
    BootstrapState {
        is_first_launch: true,
        phase: "welcome".into(),
        status: "idle".into(),
        runtime_ready: false,
        model_ready: false,
        sidecar_ready: false,
        current_download_job_id: None,
        last_error: None,
    }
}

#[tauri::command]
pub async fn get_sidecar_status() -> SidecarStatus {
    SidecarStatus {
        running: false,
        healthy: false,
        reason: Some("python_sidecar_not_connected".into()),
    }
}
