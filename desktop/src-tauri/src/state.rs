use serde::{Deserialize, Serialize};
use std::process::Child;
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: Option<String>,
    pub user_message_key: String,
    pub severity: String,
    pub recoverable: bool,
    pub actions: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub is_first_launch: bool,
    pub phase: String,
    pub status: String,
    pub runtime_ready: bool,
    pub model_ready: bool,
    pub sidecar_ready: bool,
    pub current_download_job_id: Option<String>,
    pub last_error: Option<AppError>,
}

#[derive(Clone, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub healthy: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDiagnostics {
    pub cpu_name: Option<String>,
    pub total_memory_bytes: Option<u64>,
    pub available_storage_bytes: Option<u64>,
    pub recommended_memory_bytes: u64,
    pub minimum_free_storage_bytes: u64,
    pub environment_ready: bool,
    pub environment_status: String,
    pub environment_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub phase: String,
    pub provider: Option<String>,
    pub current_file: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub total_bytes_complete: bool,
    pub completed_files: u32,
    pub total_files: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAssetDownloadProgress {
    pub model_key: String,
    pub display_name: String,
    pub status: String,
    pub progress: u8,
    pub provider: Option<String>,
    pub current_file: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub total_bytes_complete: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub audio_path: Option<String>,
    pub raw_audio_path: Option<String>,
    pub enhanced_audio_path: Option<String>,
    pub sample_rate: Option<u32>,
    pub duration_ms: Option<u32>,
    pub transcript: Option<String>,
    pub transcript_language: Option<String>,
    pub model_key: Option<String>,
    pub model_path: Option<String>,
    pub provider: Option<String>,
    pub completed_assets: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub r#type: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: Option<String>,
    pub progress: Option<u8>,
    pub message: Option<String>,
    pub download_progress: Option<DownloadProgress>,
    pub bootstrap_asset_progress: Option<Vec<BootstrapAssetDownloadProgress>>,
    pub error: Option<AppError>,
    pub result: Option<TaskResult>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPayload {
    pub mode: String,
    pub target_text: String,
    pub model_key: Option<String>,
    pub provider_preference: Option<String>,
    pub control_instruction: Option<String>,
    pub reference_audio_path: Option<String>,
    pub prompt_text: Option<String>,
    pub cfg_value: Option<f32>,
    pub inference_timesteps: Option<u32>,
    pub normalize: Option<bool>,
    pub denoise: Option<bool>,
    pub streaming: Option<bool>,
    pub seed: Option<i32>,
}

pub struct SidecarProcess {
    pub child: Option<Child>,
    pub port: u16,
}

pub struct AppState {
    pub sidecar: Mutex<SidecarProcess>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sidecar: Mutex::new(SidecarProcess {
                child: None,
                port: 8765,
            }),
        }
    }
}
