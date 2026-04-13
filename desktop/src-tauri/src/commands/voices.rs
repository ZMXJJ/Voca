use tauri::{AppHandle, State};

use crate::{
    sidecar::{ensure_sidecar_running, get_json},
    state::AppState,
};

#[tauri::command]
pub async fn list_voices(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), "/api/v1/voices").await
}
