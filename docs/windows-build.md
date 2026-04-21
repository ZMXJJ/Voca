# Windows Build Guide

This document explains how to build the **Voca** Windows installer (`.exe` via NSIS) on
a Windows 10/11 x86_64 development machine.

> Linux/macOS cross-compilation is **not** supported. Please build natively on Windows.

---

## 1. Prerequisites

Install the following tools (most can be installed via [Scoop](https://scoop.sh/) or
[winget](https://learn.microsoft.com/windows/package-manager/)):

| Tool | Version | Purpose |
|------|---------|---------|
| Windows 10 22H2 or Windows 11 (x86_64) | — | Build host |
| [Visual Studio 2022](https://visualstudio.microsoft.com/) Build Tools | with **C++ build tools** + Windows 10/11 SDK | Required by Tauri/Rust toolchain |
| [Rust](https://rustup.rs/) (`rustup`) | stable, `x86_64-pc-windows-msvc` toolchain | Builds the Tauri sidecar binary |
| [Node.js](https://nodejs.org/) | 20 LTS or newer | Builds the React frontend |
| [uv](https://docs.astral.sh/uv/) | latest | Manages the Python runtime + virtual env |
| Python (auto-managed by `uv`) | 3.11.x (`python-build-standalone`) | Runs the FastAPI sidecar |
| [WiX/NSIS toolchain](https://nsis.sourceforge.io/Download) (auto-downloaded by Tauri) | latest | Generates the installer |
| Windows SDK `signtool.exe` | shipped with the SDK | Code signs the bundled `.exe` |
| PowerShell 7+ | recommended | Drives the convenience scripts |

> If `signtool.exe` is not on `PATH`, the build script will warn but still produce an
> unsigned installer. For a release build you should always sign the artifacts.

---

## 2. Clone and bootstrap

```powershell
git clone https://github.com/ZMXJJ/Voca.git
cd Voca\desktop

# Install JS dependencies for the React frontend
npm --prefix app install

# Install workspace-level scripts (Tauri CLI etc.)
npm install
```

---

## 3. Stage Windows resources

The Python runtime, Voca service code, and VoxCPM source need to be staged into
`desktop/.bundle-resources-win/` before Tauri can package them.

```powershell
npm run prepare:windows
```

This script will:

1. Use `uv python install 3.11` to download a portable `python-build-standalone`
   distribution and copy it to `.bundle-resources-win/python-runtime`.
2. Create a venv at `.bundle-resources-win/python-service/.venv` and install
   `requirements.runtime.txt` plus `requirements.runtime.windows.txt` against
   PyTorch's CPU index (`https://download.pytorch.org/whl/cpu`).
3. Copy `python-service/app/` and `VoxCPM/src/` into `.bundle-resources-win/`.
4. Prune large unused files (caches, tests, `__pycache__/`, etc.) to keep the
   installer small.
5. Write a `manifest.json` describing the staged contents.

> The first run downloads ~2 GB; subsequent runs are incremental.

---

## 4. Build the installer

```powershell
npm run build:nsis
```

This wraps `npm run prepare:windows` followed by
`node ./scripts/run-tauri-build.mjs --bundles nsis`. The resulting installer is
written to:

```
desktop/src-tauri/target/release/bundle/nsis/Voca_<version>_x64-setup.exe
```

The NSIS installer ships in **per-user** install mode (`installMode: currentUser`)
so end users do not need administrator rights. The installer also ships with both
English and 简体中文 locales.

---

## 5. Code signing (optional but recommended)

For release builds, use the PowerShell helper that wires up
`signtool.exe` automatically:

```powershell
# 1) Provide signing credentials (NEVER commit this file)
notepad desktop\.env.windows-sign.local

# 2) Run the signed build
pwsh ./desktop/scripts/build-nsis-local.ps1
```

Required variables in `desktop/.env.windows-sign.local` (simple `KEY=VALUE` lines):

| Variable | Description |
|----------|-------------|
| `SIGNTOOL_CERT_PATH` | Absolute path to the signing certificate (`.pfx`) |
| `SIGNTOOL_CERT_PASSWORD` | Certificate password (kept locally, never logged) |
| `SIGNTOOL_TIMESTAMP_URL` | RFC 3161 timestamp server, e.g. `http://timestamp.digicert.com` |
| `SIGNTOOL_PATH` | Optional override if `signtool.exe` is not on `PATH` |

The script signs both the embedded `Voca.exe` and the generated NSIS installer
with SHA-256 + timestamping. Missing credentials fall back to an unsigned build
with a clear warning. Pass `-SkipSign` to skip the signing step entirely.

---

## 6. Smoke testing

After installation, the bundled Python sidecar performs a self-heal check on every
startup (see `desktop/src-tauri/src/sidecar.rs::ensure_torch_healthy`). If a
previous CUDA upgrade left a half-installed runtime, the sidecar will roll back
to the last known good backend automatically before starting.

To exercise the CUDA upgrade path manually:

1. Install the CPU build on a machine with an NVIDIA GPU.
2. Open **Settings → Inference Backend**. The "Upgrade to CUDA" button appears
   only when `nvidia-smi` (or the registry) reports an NVIDIA card.
3. The progress bar walks through four stages:
   `1/4 Downloading wheels` → `2/4 Verifying wheels` →
   `3/4 Installing runtime` → `4/4 Validating installation`.
4. On any failure the installer atomically rolls back and shows a red banner; the
   CPU backend remains active. Logs live under `%APPDATA%\Voca\logs\`.

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `prepare:windows` fails on `uv python install` | Make sure `uv` is on `PATH` and that you have network access to GitHub releases |
| Tauri build complains about missing `link.exe` | Install Visual Studio 2022 Build Tools with the **Desktop development with C++** workload |
| Installer launches but Python sidecar fails to start | Check `%APPDATA%\Voca\logs\sidecar.log`. Most common causes: AV flagged the venv (whitelist `%APPDATA%\Voca\runtime`), or the CPU lacks AVX2 |
| CUDA upgrade keeps rolling back | The wheels in `runtime/staging/` failed `import torch; torch.cuda.is_available()`. Inspect `runtime/runtime.json` and `runtime/rollback/` for details |
| Installer is unsigned | Either intentionally (developer build) or signing credentials are missing — see [Code signing](#5-code-signing-optional-but-recommended) |
