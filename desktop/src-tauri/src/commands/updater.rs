//! GitHub Releases update check. Replace `GITHUB_REPO` with your `owner/repo` after open-sourcing.
use reqwest::header::{HeaderMap, USER_AGENT};
use serde::{Deserialize, Serialize};

/// GitHub repository in `owner/repo` form. Update when the project is published.
const GITHUB_REPO: &str = "ZMXJJ/Voca";

fn releases_api_url() -> String {
    format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=1")
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub release_notes: Option<String>,
}

fn normalize_version_tag(raw: &str) -> &str {
    raw.trim()
        .trim_start_matches(|c: char| c == 'v' || c == 'V')
}

fn is_newer_than_current(latest_tag: &str, current: &str) -> bool {
    let latest_norm = normalize_version_tag(latest_tag);
    let current_norm = normalize_version_tag(current);

    match (
        semver::Version::parse(latest_norm),
        semver::Version::parse(current_norm),
    ) {
        (Ok(l), Ok(c)) => l > c,
        _ => latest_norm != current_norm,
    }
}

fn truncate_notes(body: Option<String>) -> Option<String> {
    const MAX: usize = 4000;
    body.map(|s| {
        if s.len() <= MAX {
            s
        } else {
            format!("{}…", s.chars().take(MAX).collect::<String>())
        }
    })
}

/// Returns the latest GitHub release compared to the running app version (`CARGO_PKG_VERSION`).
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        format!("VocaDesktop/{}", current_version)
            .parse()
            .map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
    );

    let client = reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())?;

    let url = releases_api_url();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API returned {status}. {body}"));
    }

    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Invalid GitHub release payload: {e}"))?;

    let release = releases
        .into_iter()
        .next()
        .ok_or_else(|| "No releases found on GitHub".to_string())?;

    let latest_version = normalize_version_tag(&release.tag_name).to_string();
    let update_available = is_newer_than_current(&release.tag_name, &current_version);

    Ok(UpdateCheckResult {
        update_available,
        current_version,
        latest_version,
        release_url: release.html_url,
        release_notes: truncate_notes(release.body),
    })
}
