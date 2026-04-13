mod commands;
mod sidecar;
mod state;

use commands::bootstrap::{clear_cache, get_bootstrap_state, get_service_info, get_sidecar_status};
use commands::models::{get_model_catalog, get_provider_recommendation, prepare_model, start_model_download};
use commands::tasks::{create_generate_task, get_task, list_tasks};
use commands::voices::list_voices;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_state,
            get_sidecar_status,
            get_service_info,
            clear_cache,
            get_model_catalog,
            get_provider_recommendation,
            prepare_model,
            start_model_download,
            create_generate_task,
            get_task,
            list_tasks,
            list_voices
        ])
        .run(tauri::generate_context!())
        .expect("error while running voca desktop");
}
