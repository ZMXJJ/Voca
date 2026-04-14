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
pub async fn create_asr_task(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    audio_path: String,
    model_key: Option<String>,
) -> Result<TaskRecord, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let payload = serde_json::json!({
        "audioPath": audio_path,
        "modelKey": model_key.unwrap_or_else(|| "sensevoice_small".into()),
    });
    post_json(state.inner(), "/api/v1/tasks/asr", &payload).await
}

#[tauri::command]
pub async fn get_task(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskRecord, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), &format!("/api/v1/tasks/{task_id}")).await
}

#[tauri::command]
pub async fn list_tasks(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    limit: Option<u32>,
    offset: Option<u32>,
    status: Option<String>,
) -> Result<Vec<TaskRecord>, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let mut query_parts: Vec<String> = Vec::new();
    if let Some(l) = limit {
        query_parts.push(format!("limit={l}"));
    }
    if let Some(o) = offset {
        query_parts.push(format!("offset={o}"));
    }
    if let Some(s) = &status {
        query_parts.push(format!("status={s}"));
    }

    let query = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    get_json(state.inner(), &format!("/api/v1/tasks{query}")).await
}
