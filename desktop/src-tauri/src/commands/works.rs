use tauri::{AppHandle, State};

use crate::{
    sidecar::{delete_ok, ensure_sidecar_running, get_json, patch_json, post_json},
    state::AppState,
};

async fn ensure_healthy_sidecar(
    app_handle: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let sidecar = ensure_sidecar_running(app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_works(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    limit: Option<u32>,
    offset: Option<u32>,
    search: Option<String>,
    voice_id: Option<String>,
    voice_name: Option<String>,
) -> Result<serde_json::Value, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;

    let mut query_parts: Vec<String> = Vec::new();
    if let Some(value) = limit {
        query_parts.push(format!("limit={value}"));
    }
    if let Some(value) = offset {
        query_parts.push(format!("offset={value}"));
    }
    if let Some(value) = &search
        && !value.trim().is_empty()
    {
        query_parts.push(format!("search={}", urlencoding::encode(value)));
    }
    if let Some(value) = &voice_id {
        query_parts.push(format!("voiceId={}", urlencoding::encode(value)));
    }
    if let Some(value) = &voice_name {
        query_parts.push(format!("voiceName={}", urlencoding::encode(value)));
    }
    let query = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    get_json(state.inner(), &format!("/api/v1/works{query}")).await
}

#[tauri::command]
pub async fn list_work_facets(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;
    get_json(state.inner(), "/api/v1/works/facets").await
}

#[tauri::command]
pub async fn get_work(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    work_id: String,
) -> Result<serde_json::Value, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;
    get_json(state.inner(), &format!("/api/v1/works/{work_id}")).await
}

#[tauri::command]
pub async fn update_work(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    work_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;
    patch_json(state.inner(), &format!("/api/v1/works/{work_id}"), &payload).await
}

#[tauri::command]
pub async fn delete_work(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    work_id: String,
) -> Result<bool, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;
    delete_ok(state.inner(), &format!("/api/v1/works/{work_id}")).await?;
    Ok(true)
}

#[tauri::command]
pub async fn import_works(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure_healthy_sidecar(&app_handle, &state).await?;
    post_json(state.inner(), "/api/v1/works/import", &payload).await
}
