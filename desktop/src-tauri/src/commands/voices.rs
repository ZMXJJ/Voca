use tauri::{AppHandle, State};

use crate::{
    sidecar::{delete_ok, ensure_sidecar_running, get_json, patch_json, post_json},
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

#[tauri::command]
pub async fn get_voice(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    voice_id: String,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), &format!("/api/v1/voices/{voice_id}")).await
}

#[tauri::command]
pub async fn create_voice(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    post_json(state.inner(), "/api/v1/voices", &payload).await
}

#[tauri::command]
pub async fn update_voice(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    voice_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    patch_json(
        state.inner(),
        &format!("/api/v1/voices/{voice_id}"),
        &payload,
    )
    .await
}

#[tauri::command]
pub async fn delete_voice(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    voice_id: String,
) -> Result<bool, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    delete_ok(state.inner(), &format!("/api/v1/voices/{voice_id}")).await?;
    Ok(true)
}
