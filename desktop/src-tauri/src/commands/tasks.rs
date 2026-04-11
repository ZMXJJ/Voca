use tauri::State;
use uuid::Uuid;

use crate::state::{now_string, AppState, GenerationPayload, TaskRecord, TaskResult};

#[tauri::command]
pub async fn create_generate_task(
    state: State<'_, AppState>,
    payload: GenerationPayload,
) -> Result<TaskRecord, String> {
    if payload.target_text.trim().is_empty() {
        return Err("targetText cannot be empty".into());
    }

    let id = Uuid::new_v4().to_string();
    let now = now_string();
    let task = TaskRecord {
        id: id.clone(),
        r#type: "generate".into(),
        status: "queued".into(),
        created_at: now.clone(),
        updated_at: now,
        progress: Some(0),
        message: Some(format!("P0 skeleton accepted task in mode {}", payload.mode)),
        error: None,
        result: Some(TaskResult {
            audio_path: Some("/tmp/voca-placeholder.wav".into()),
            sample_rate: Some(24000),
            duration_ms: Some(1000),
        }),
    };

    state
        .tasks
        .lock()
        .map_err(|_| "failed to lock task store".to_string())?
        .insert(id, task.clone());

    Ok(task)
}

#[tauri::command]
pub async fn get_task(state: State<'_, AppState>, task_id: String) -> Result<TaskRecord, String> {
    state
        .tasks
        .lock()
        .map_err(|_| "failed to lock task store".to_string())?
        .get(&task_id)
        .cloned()
        .ok_or_else(|| "task not found".to_string())
}
