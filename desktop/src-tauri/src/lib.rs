mod commands;
mod platform;
mod sidecar;
mod state;

use commands::audio::{
    audio_file_exists, pick_audio_file, pick_directory, read_audio_base64, save_audio_as,
    save_recorded_audio,
};
use commands::bootstrap::{
    cleanup_legacy_asr_model, clear_cache, complete_onboarding, export_logs,
    get_bootstrap_sidecar_status, get_bootstrap_state, get_quick_bootstrap_state, get_runtime_info,
    get_service_info, get_setup_diagnostics, get_sidecar_status, open_external_url,
    open_microphone_settings, open_storage_directory, start_bootstrap_download, start_cuda_upgrade,
};
use commands::models::{
    get_model_catalog, get_provider_recommendation, prepare_model, start_model_download,
};
use commands::tasks::{create_asr_task, create_generate_task, get_task, list_tasks};
use commands::updater::check_for_update;
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
            get_bootstrap_sidecar_status,
            get_sidecar_status,
            get_service_info,
            get_setup_diagnostics,
            complete_onboarding,
            start_bootstrap_download,
            start_cuda_upgrade,
            get_runtime_info,
            cleanup_legacy_asr_model,
            clear_cache,
            export_logs,
            open_storage_directory,
            open_external_url,
            open_microphone_settings,
            check_for_update,
            audio_file_exists,
            read_audio_base64,
            save_audio_as,
            save_recorded_audio,
            pick_audio_file,
            pick_directory,
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

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            // Tear the sidecar down on both ExitRequested (fires before any
            // listeners can prevent the exit) and Exit so we cover scenarios
            // where the OS forces a quick shutdown and `Exit` never reaches us.
            // `shutdown_sidecar` uses `Option::take` internally, so calling it
            // twice during the same shutdown is idempotent.
            let state = app_handle.state::<AppState>();
            let _ = sidecar::shutdown_sidecar(state.inner());
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            // When the last window is destroyed (e.g. user closes the main
            // window on Windows) Tauri may not always emit `Exit` before the
            // process is reclaimed. Eagerly drop the sidecar so its file
            // handles on the install/runtime directory are released.
            let state = app_handle.state::<AppState>();
            let _ = sidecar::shutdown_sidecar(state.inner());
        }
        _ => {}
    });
}
