mod commands;
mod sidecar;
mod state;

use commands::audio::{audio_file_exists, pick_audio_file, read_audio_base64, save_audio_as};
use commands::bootstrap::{
    clear_cache, complete_onboarding, export_logs, get_bootstrap_state, get_quick_bootstrap_state,
    get_service_info, get_setup_diagnostics, get_sidecar_status, open_storage_directory,
    start_bootstrap_download,
};
use commands::models::{get_model_catalog, get_provider_recommendation, prepare_model, start_model_download};
use commands::tasks::{create_asr_task, create_generate_task, get_task, list_tasks};
use commands::voices::{create_voice, delete_voice, get_voice, list_voices, update_voice};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_quick_bootstrap_state,
            get_bootstrap_state,
            get_sidecar_status,
            get_service_info,
            get_setup_diagnostics,
            complete_onboarding,
            start_bootstrap_download,
            clear_cache,
            export_logs,
            open_storage_directory,
            audio_file_exists,
            read_audio_base64,
            save_audio_as,
            pick_audio_file,
            get_model_catalog,
            get_provider_recommendation,
            prepare_model,
            start_model_download,
            create_asr_task,
            create_generate_task,
            get_task,
            list_tasks,
            list_voices,
            get_voice,
            create_voice,
            update_voice,
            delete_voice
        ])
        .build(tauri::generate_context!())
        .expect("error while building voca desktop");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            let _ = sidecar::shutdown_sidecar(state.inner());
        }
    });
}
