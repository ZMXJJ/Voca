mod commands;
mod sidecar;
mod state;

use commands::bootstrap::{get_bootstrap_state, get_sidecar_status};
use commands::models::{get_model_catalog, get_provider_recommendation, prepare_model};
use commands::tasks::{create_generate_task, get_task};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_state,
            get_sidecar_status,
            get_model_catalog,
            get_provider_recommendation,
            prepare_model,
            create_generate_task,
            get_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running voca desktop");
}
