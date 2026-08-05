//! Cross-platform helpers shared across commands.
//!
//! Keeps macOS/Windows/Linux-specific logic in one place so individual command
//! modules can stay platform-agnostic.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub const APP_DIR_NAME: &str = "Voca";

/// Root directory Voca uses to store its user data (logs, models, caches, etc.).
///
/// - macOS: `~/Library/Application Support/Voca`
/// - Windows: `%APPDATA%\Voca`
/// - Linux / other: `~/.local/share/Voca`
pub fn app_support_dir() -> Result<PathBuf, String> {
    let base = platform_app_support_root()?;
    let dir = base.join(APP_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn platform_app_support_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            let trimmed = PathBuf::from(&appdata);
            if !trimmed.as_os_str().is_empty() {
                return Ok(trimmed);
            }
        }
        if let Some(profile) = env::var_os("USERPROFILE") {
            let trimmed = PathBuf::from(&profile);
            if !trimmed.as_os_str().is_empty() {
                return Ok(trimmed.join("AppData").join("Roaming"));
            }
        }
        return Err("APPDATA is not set".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
        let home_path = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            Ok(home_path.join("Library").join("Application Support"))
        } else {
            Ok(home_path.join(".local").join("share"))
        }
    }
}

/// Filenames to probe when resolving the bundled Python interpreter inside a venv.
pub fn python_executable_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["python.exe", "python3.exe", "pythonw.exe"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &["VocaService", "python3.11", "python3", "python"]
    }
}

/// Subdirectory of a venv that contains the Python interpreter.
pub fn venv_bin_subdir() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Scripts"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "bin"
    }
}

/// Find the Python executable within a venv root directory or a python-build-standalone
/// style distribution. Probes the venv bin subdirectory first, then the root (Windows
/// python-build-standalone places `python.exe` directly at the root), then `bin/`.
pub fn find_python_executable(root: &Path) -> Option<PathBuf> {
    let candidates = python_executable_candidates();
    let search_roots: [PathBuf; 3] = [
        root.join(venv_bin_subdir()),
        root.to_path_buf(),
        root.join("bin"),
    ];

    for search_root in search_roots {
        for name in candidates {
            let candidate = search_root.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Locate the `site-packages` directory inside a venv.
///
/// - Unix layout: `<venv>/lib/python3.X/site-packages`
/// - Windows layout: `<venv>/Lib/site-packages`
pub fn detect_site_packages(venv_root: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidate = venv_root.join("Lib").join("site-packages");
        if candidate.exists() {
            return Some(candidate);
        }
        return None;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let lib_root = venv_root.join("lib");
        let entries = fs::read_dir(lib_root).ok()?;
        for entry in entries.flatten() {
            let site_packages = entry.path().join("site-packages");
            if site_packages.exists() {
                return Some(site_packages);
            }
        }
        None
    }
}

/// How long we let the sidecar shut itself down before forcing the issue.
///
/// Kept short because this runs on the main thread while the app is quitting:
/// an idle sidecar exits well inside it, and a busy one (mid-generation, where
/// uvicorn's graceful shutdown waits for the in-flight request) is force-killed
/// instead of hanging the quit.
const SIDECAR_GRACE_PERIOD: Duration = Duration::from_millis(2000);
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Terminate the sidecar **and every process it spawned**.
///
/// The sidecar is not a leaf process: the C++ TTS path keeps a resident
/// `llama-tts-server` child alive between generations. Killing only the Python
/// parent (`Child::kill`, i.e. `SIGKILL`) skipped its `atexit`/FastAPI shutdown
/// hooks and left that server running forever, holding several GB of GPU memory
/// after Voca had quit. So: ask nicely first, and if that fails, reap the
/// descendants *before* the parent — once the parent is gone they are reparented
/// to `launchd`/`init` and we can no longer find them.
pub fn terminate_child_tree(child: &mut std::process::Child) {
    let pid = child.id();

    #[cfg(not(target_os = "windows"))]
    {
        // SIGTERM → uvicorn runs its shutdown hooks, which stop llama-tts-server.
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        if wait_for_exit(child, SIDECAR_GRACE_PERIOD) {
            return;
        }

        for descendant in descendant_pids(pid) {
            let _ = Command::new("kill")
                .args(["-KILL", &descendant.to_string()])
                .status();
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows has no SIGTERM; `taskkill /T` takes out the whole tree in one
        // shot, which is what matters here (`Child::kill` would only get the
        // Python parent and orphan llama-tts-server.exe).
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        if wait_for_exit(child, SIDECAR_GRACE_PERIOD) {
            return;
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// Poll until the child is reaped or the deadline passes. Returns `true` when it exited.
fn wait_for_exit(child: &mut std::process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(EXIT_POLL_INTERVAL);
    }
}

/// Every transitive child of `pid`, deepest first, so callers can kill bottom-up.
#[cfg(not(target_os = "windows"))]
fn descendant_pids(pid: u32) -> Vec<u32> {
    fn collect(pid: u32, depth: usize, out: &mut Vec<u32>) {
        if depth > 4 {
            return;
        }
        let output = match Command::new("pgrep")
            .args(["-P", &pid.to_string()])
            .output()
        {
            Ok(output) => output,
            Err(_) => return,
        };
        for child in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            collect(child, depth + 1, out);
            out.push(child);
        }
    }

    let mut out = Vec::new();
    collect(pid, 0, &mut out);
    out
}

/// List PIDs currently holding a TCP listener on the given port.
pub fn listening_pids(port: u16) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        listening_pids_windows(port)
    }
    #[cfg(not(target_os = "windows"))]
    {
        listening_pids_unix(port)
    }
}

#[cfg(not(target_os = "windows"))]
fn listening_pids_unix(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-t", "-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "failed to inspect listening sidecar process".into()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect())
}

#[cfg(target_os = "windows")]
fn listening_pids_windows(port: u16) -> Result<Vec<u32>, String> {
    let mut command = Command::new("netstat");
    command.args(["-ano", "-p", "tcp"]);
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "failed to inspect listening sidecar process".into()
        } else {
            stderr
        });
    }

    let needle_suffix = format!(":{port}");
    let mut pids = Vec::new();
    for raw_line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = raw_line.trim();
        if !line.to_ascii_uppercase().contains("LISTENING") {
            continue;
        }
        let mut fields = line.split_whitespace();
        let _proto = match fields.next() {
            Some(value) => value,
            None => continue,
        };
        let local = match fields.next() {
            Some(value) => value,
            None => continue,
        };
        if !local.ends_with(&needle_suffix) {
            continue;
        }
        let Some(_remote) = fields.next() else {
            continue;
        };
        let Some(_state) = fields.next() else {
            continue;
        };
        let Some(pid_str) = fields.next() else {
            continue;
        };
        if let Ok(pid) = pid_str.parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    Ok(pids)
}

/// Terminate anything listening on `port`. Best-effort; missing targets are not an error.
pub fn kill_port_listener(port: u16) -> Result<(), String> {
    let pids = listening_pids(port)?;
    if pids.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        for pid in &pids {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        std::thread::sleep(Duration::from_millis(300));
    }

    #[cfg(not(target_os = "windows"))]
    {
        for pid in &pids {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }

        std::thread::sleep(Duration::from_millis(300));

        for pid in listening_pids(port)? {
            // Descendants first: a SIGKILL'd parent can't run its cleanup, and
            // its children (llama-tts-server) would survive as orphans.
            for descendant in descendant_pids(pid) {
                let _ = Command::new("kill")
                    .args(["-KILL", &descendant.to_string()])
                    .status();
            }
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }

    Ok(())
}

/// Open a directory or file using the host file manager.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    let status = command
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;

    // `explorer` returns non-zero exit codes even on success, so treat that as OK on Windows.
    #[cfg(target_os = "windows")]
    {
        let _ = status;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to open path: {}", path.display()))
        }
    }
}

/// Open an external URL with the default browser.
pub fn open_external_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP(S) URLs are allowed".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", ""]);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = Command::new("xdg-open");

    command.arg(url).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Best-effort CPU brand name detection.
pub fn detect_cpu_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(name) = read_command_output("sysctl", &["-n", "machdep.cpu.brand_string"]) {
            return Some(name);
        }

        if let Some(profile) = read_command_output("system_profiler", &["SPHardwareDataType"]) {
            for raw_line in profile.lines() {
                let line = raw_line.trim();
                if let Some(value) = line.strip_prefix("Chip:") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
                if let Some(value) = line.strip_prefix("Processor Name:") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(output) = read_command_output("wmic", &["cpu", "get", "Name", "/FORMAT:LIST"]) {
            for raw_line in output.lines() {
                let line = raw_line.trim();
                if let Some(value) = line.strip_prefix("Name=") {
                    let name = value.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }

        if let Some(name) = read_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Processor).Name",
            ],
        ) {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }

        if let Some(name) = env::var_os("PROCESSOR_IDENTIFIER") {
            let lossy = name.to_string_lossy().trim().to_string();
            if !lossy.is_empty() {
                return Some(lossy);
            }
        }
    }

    Some(env::consts::ARCH.to_string())
}

/// Best-effort total physical memory detection (in bytes).
pub fn detect_total_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        return read_command_output("sysctl", &["-n", "hw.memsize"])?
            .parse()
            .ok();
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(output) = read_command_output(
            "wmic",
            &[
                "ComputerSystem",
                "get",
                "TotalPhysicalMemory",
                "/FORMAT:LIST",
            ],
        ) {
            for line in output.lines() {
                if let Some(value) = line.trim().strip_prefix("TotalPhysicalMemory=") {
                    if let Ok(bytes) = value.trim().parse::<u64>() {
                        return Some(bytes);
                    }
                }
            }
        }

        if let Some(output) = read_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ],
        ) {
            if let Ok(bytes) = output.trim().parse::<u64>() {
                return Some(bytes);
            }
        }
        return None;
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        None
    }
}

/// Best-effort free storage detection for the path Voca writes to.
pub fn detect_available_storage_bytes() -> Option<u64> {
    let target = app_support_dir().ok()?;

    #[cfg(target_os = "windows")]
    {
        return detect_free_space_windows(&target);
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(capacity) = detect_available_storage_bytes_macos(&target) {
            return Some(capacity);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        detect_available_storage_bytes_df(&target)
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_available_storage_bytes_df(target: &Path) -> Option<u64> {
    let target_string = target.to_string_lossy().to_string();
    let output = read_command_output("df", &["-k", &target_string])?;
    let line = output.lines().nth(1)?.trim();
    let available_kb = line
        .split_whitespace()
        .nth(3)
        .and_then(|value| value.parse::<u64>().ok())?;
    Some(available_kb.saturating_mul(1024))
}

#[cfg(target_os = "macos")]
fn detect_available_storage_bytes_macos(target: &Path) -> Option<u64> {
    use objc2_foundation::{NSNumber, NSURL, NSURLVolumeAvailableCapacityForImportantUsageKey};
    let url = NSURL::from_file_path(target)?;
    let mut value = None;
    unsafe {
        url.getResourceValue_forKey_error(
            &mut value,
            &NSURLVolumeAvailableCapacityForImportantUsageKey,
        )
    }
    .ok()?;
    let number = value?.downcast::<NSNumber>().ok()?;
    let capacity = number.as_u64();
    if capacity > 0 { Some(capacity) } else { None }
}

#[cfg(target_os = "windows")]
fn detect_free_space_windows(target: &Path) -> Option<u64> {
    let root = target
        .ancestors()
        .find(|candidate| candidate.exists())
        .unwrap_or(target)
        .to_path_buf();
    let drive = root
        .components()
        .next()?
        .as_os_str()
        .to_string_lossy()
        .to_string();
    let drive_letter = drive.trim_end_matches(['\\', '/']);
    let command_str = format!(
        "(Get-PSDrive -Name '{}' -PSProvider FileSystem).Free",
        drive_letter.trim_end_matches(':')
    );
    let output = read_command_output("powershell", &["-NoProfile", "-Command", &command_str])?;
    output.trim().parse::<u64>().ok()
}

/// Run a subprocess and capture a trimmed stdout string. Returns `None` on non-zero exit.
pub fn read_command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Detect whether an NVIDIA GPU is available on this host.
/// Returns a short, human-readable label (GPU name) when detected.
pub fn detect_nvidia_gpu() -> Option<String> {
    if let Some(output) = read_command_output("nvidia-smi", &["-L"]) {
        let first = output.lines().next().unwrap_or("").trim();
        if !first.is_empty() {
            return Some(first.to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(name) = read_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1).Name",
            ],
        ) {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

/// Best-effort NVIDIA VRAM detection in bytes.
pub fn detect_nvidia_gpu_memory_bytes() -> Option<u64> {
    if let Some(output) = read_command_output(
        "nvidia-smi",
        &["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
    ) {
        let first = output.lines().next()?.trim();
        if let Ok(megabytes) = first.parse::<u64>() {
            return Some(megabytes.saturating_mul(1024 * 1024));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(output) = read_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1).AdapterRAM",
            ],
        ) {
            if let Ok(bytes) = output.trim().parse::<u64>() {
                return Some(bytes);
            }
        }
    }

    None
}
#[cfg(all(test, not(target_os = "windows")))]
mod terminate_tests {
    use super::*;
    use std::process::Command;

    /// The bug this guards: killing only the parent orphans its children.
    /// The `trap '' TERM` makes the parent ignore the graceful signal, so this
    /// exercises the forced path where descendants must be reaped explicitly.
    #[test]
    fn terminate_child_tree_kills_grandchildren() {
        let pidfile = "/tmp/voca_terminate_test.pid";
        let _ = fs::remove_file(pidfile);
        let mut child = Command::new("sh")
            .args([
                "-c",
                &format!("trap '' TERM; sleep 300 & echo $! > {pidfile}; wait"),
            ])
            .spawn()
            .expect("spawn test tree");

        // Wait for the grandchild to register itself.
        let mut grandchild = None;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(raw) = fs::read_to_string(pidfile) {
                if let Ok(pid) = raw.trim().parse::<u32>() {
                    grandchild = Some(pid);
                    break;
                }
            }
        }
        let grandchild = grandchild.expect("grandchild pid");
        assert!(descendant_pids(child.id()).contains(&grandchild));

        terminate_child_tree(&mut child);

        std::thread::sleep(Duration::from_millis(200));
        let alive = Command::new("kill")
            .args(["-0", &grandchild.to_string()])
            .status()
            .expect("probe")
            .success();
        let _ = fs::remove_file(pidfile);
        assert!(!alive, "grandchild {grandchild} survived the teardown");
    }
}
