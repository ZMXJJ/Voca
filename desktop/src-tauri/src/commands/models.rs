use tauri::{AppHandle, State};

use crate::{
    sidecar::{ensure_sidecar_running, get_json, post_json},
    state::AppState,
};

#[tauri::command]
pub async fn get_model_catalog(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    get_json(state.inner(), "/api/v1/models/catalog").await
}

#[tauri::command]
pub async fn get_provider_recommendation(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    preferred: Option<String>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let query = preferred.unwrap_or_else(|| "auto".into());
    get_json(
        state.inner(),
        &format!("/api/v1/providers/recommendation?preferred={query}"),
    )
    .await
}

#[tauri::command]
pub async fn prepare_model(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    model_key: String,
    provider_preference: Option<String>,
    ensure_downloaded: Option<bool>,
) -> Result<serde_json::Value, String> {
    let sidecar = ensure_sidecar_running(&app_handle, state.inner()).await?;
    if !sidecar.healthy {
        return Err(sidecar
            .reason
            .unwrap_or_else(|| "python_sidecar_not_ready".into()));
    }

    let payload = serde_json::json!({
        "modelKey": model_key,
        "providerPreference": provider_preference.unwrap_or_else(|| "auto".into()),
        "ensureDownloaded": ensure_downloaded.unwrap_or(false),
    });

    post_json(state.inner(), "/api/v1/models/prepare", &payload).await
}
