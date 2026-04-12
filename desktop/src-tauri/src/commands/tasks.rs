use tauri::{AppHandle, State};

use crate::{
    sidecar::{ensure_sidecar_running, get_json, post_json},
    state::{AppState, GenerationPayload, TaskRecord},
};

#[tauri::command]
pub async fn create_generate_task(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    payload: GenerationPayload,
) -> Result<TaskRecord, String> {
    if payload.target_text.trim().is_empty() {
        return Err("targetText cannot be empty".into());
    }

    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    post_json(state.inner(), "/api/v1/tasks/generate", &payload).await
}

#[tauri::command]
pub async fn get_task(state: State<'_, AppState>, task_id: String) -> Result<TaskRecord, String> {
    get_json(state.inner(), &format!("/api/v1/tasks/{task_id}")).await
}
