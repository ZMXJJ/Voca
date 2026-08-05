# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Voca is a local-first desktop voice-cloning app. Everything ships as one installable binary; after a one-time model download it runs fully offline. The speech engine on **both platforms** is **VoxCPM2 in GGUF format** running on the C++ [`llama.cpp-omni`](https://github.com/tc-mb/llama.cpp-omni) backend (a resident TTS server — Metal on macOS, Vulkan on Windows), plus **SenseVoice Small** (ASR, ONNX Runtime on CPU) and **DPDFNet** denoise (ONNX, sherpa-onnx). `cpp_tts_backend.is_selected()` defaults to `cpp` everywhere; the PyTorch VoxCPM path survives only as a `VOCA_TTS_BACKEND=python` escape hatch and is no longer in the shipped model catalog. Both platforms ship a **torch-free venv** — the Windows `cuda_upgrade` overlay (downloads CUDA torch on demand into `runtime/site-packages`) is vestigial now that TTS runs on Vulkan, and is a candidate for removal. Targets macOS 14+ (Apple Silicon, Metal) and Windows 10/11 x86_64.

## Architecture: three layers, one strict data path

```
React frontend  ──invoke() IPC──▶  Tauri shell (Rust)  ──HTTP 127.0.0.1:8765──▶  Python sidecar (FastAPI)
  desktop/app/                       desktop/src-tauri/                            desktop/python-service/
```

The single most important rule: **the frontend never talks to the Python service directly.** All backend calls go through `desktop/app/src/lib/tauri.ts`, which wraps Tauri `invoke()`. Each `invoke()` hits a Rust command in `desktop/src-tauri/src/commands/`, which either handles the request itself (Rust-only) or forwards it over HTTP to the Python sidecar. There are no `fetch()`/HTTP calls in the React code.

- **Rust shell** (`src-tauri/src/`): owns the window, system integration, and the **sidecar lifecycle** (`sidecar.rs` — spawns the uvicorn child on `127.0.0.1:8765`, health-polls `/api/v1/health`, tears the process down on exit). Commands are registered in `lib.rs`'s `invoke_handler!` and implemented under `commands/` (`bootstrap`, `models`, `tasks`, `voices`, `audio`, `updater`). Some commands (onboarding marker, log export, update check, file dialogs, env diagnostics) are **Rust-only** and never touch Python.
- **Python sidecar** (`python-service/app/`): `main.py` defines ~25 FastAPI routes under `/api/v1/`. `services/task_manager.py` is the core orchestrator — it runs generation, ASR, and download jobs on background threads and holds an in-memory list of `TaskRecord`s, so the frontend **polls** `get_task` for status rather than receiving push events. Engine bridges live in `services/` (`voxcpm_bridge.py` → dispatches to the C++ backend via `cpp_tts_backend.py`; `voxcpm_server.py` owns the resident `llama-tts-server` lifecycle + HTTP client; `asr_bridge.py` + `sensevoice_onnx_session.py`; `audio_enhancer.py` = DPDFNet denoise via sherpa-onnx; `voice_library.py`).
- **VoxCPM** (`/VoxCPM`, a git submodule): the sidecar adds `VoxCPM/src` to `PYTHONPATH` at launch. If the submodule is empty the sidecar fails with `ModuleNotFoundError: voxcpm`.

### Process tree and shutdown

Three processes, each the child of the previous: Tauri shell → Python sidecar (packaged as `VocaService`) → the resident TTS server (packaged as **`voca-service`**; upstream builds it as `llama-tts-server` and the prepare scripts rename it — both names are probed, so dev trees still resolve).

**That grandchild is what leaks, and it is never safe to `SIGKILL` the sidecar to stop it** — its shutdown hooks won't run and the TTS server survives, holding GBs of GPU memory until reboot. Three independent layers enforce this: `platform::terminate_child_tree` (Rust), plus `process_guard.sweep_orphans` and `.start_parent_watchdog` (Python). When touching any one of them, keep the other two intact. Mechanism: `docs/architecture.md` §进程树与退出清理; regression test: `cargo test` in `src-tauri/`.

### Shared contracts

`desktop/packages/contracts/src/index.ts` holds the TypeScript types crossing the IPC boundary (consumed by `app/` as `@voca/contracts` via a `file:` link). These types mirror the Rust command signatures and the Python Pydantic schemas (`python-service/app/models/schemas.py`). **A change to any backend request/response shape must be made in all three places**: the Pydantic schema, the Rust command, and the contracts types (plus the `tauri.ts` wrapper).

### Local user data

Lives outside the repo, under the OS app-support dir (`~/Library/Application Support/Voca/` on macOS): `models/`, `voices/`, `audio/`, `logs/service.log` (rotates at 5 MB), `run/native-children.json` (native-child PID registry, see below), `voca.db` (SQLite voice library), `onboarding.json` (bootstrap-complete marker). Delete `onboarding.json` to replay the first-launch bootstrap flow.

## Repo layout

This is a frontend monorepo rooted at `desktop/` but **without npm workspaces** — dependencies must be installed in `desktop/` and `desktop/app/` separately. `desktop/package.json` is the command entrypoint; `desktop/app/` is the React app; `desktop/python-service/` is the sidecar.

## Development

All `npm` commands run from `desktop/`. Windows build details are in `docs/windows-build.md`; `docs/dev/development-setup.md` has more setup detail but is **local-only** (gitignored — absent in a fresh clone). The canonical architecture doc is `docs/architecture.md`.

### One-time setup

```bash
git clone --recurse-submodules <repo>        # the VoxCPM submodule is required
# (or, if already cloned) git submodule update --init --recursive

cd desktop
npm install                                  # Tauri CLI + build scripts
npm --prefix app install                     # React/Vite deps

cd python-service                            # create the sidecar venv (uv required)
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.runtime.txt
```

The Rust shell looks for the sidecar interpreter at `desktop/python-service/.venv/bin/python` in dev mode (missing → `python_service_venv_missing`). `uv` is **mandatory** for release builds (the packaging scripts depend on it); prefer it in dev too.

### Run

```bash
cd desktop
npm run dev          # full app: Vite + Tauri, auto-spawns the Python sidecar
npm run dev:web      # frontend only (Vite at 127.0.0.1:1420), no Tauri/sidecar
```

`npm run dev` first exports `SDKROOT`/`CPATH` from `xcrun` (required for Rust to find macOS system headers) before running `tauri dev`. Frontend edits hot-reload; Rust edits restart the window; **Python edits require restarting `npm run dev`** (or killing whatever holds port 8765 so the sidecar respawns).

To debug the sidecar standalone (bypassing Tauri), with Swagger at `/docs`:

```bash
cd desktop/python-service
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

### Lint / typecheck / format

```bash
# from desktop/
npm run lint:web         # ESLint (app/)
npm run typecheck:web    # tsc -b (app/)

# from desktop/src-tauri/
cargo check              # fast type check
cargo clippy             # Rust lint
cargo fmt                # Rust format
```

There is no JS/Python test suite or CI test job in the repo; verification is manual. The one exception is `cargo test` in `src-tauri/`, which holds a regression test for the sidecar process-tree teardown (see "Process tree and shutdown" above).

### Build / package

```bash
# from desktop/
npm run build:dmg        # macOS DMG → src-tauri/target/release/bundle/dmg/
npm run build:nsis       # Windows NSIS installer (per-user, no admin)
```

The `prepare:dmg` / `prepare:windows` steps (run by the above) flatten the Python runtime, site-packages, VoxCPM source, and ffmpeg into `desktop/.bundle-resources/`, which `tauri.conf.json` then bundles into the app. Signed+notarized macOS builds use `scripts/build-dmg-appleid-local.sh` with secrets in the gitignored `desktop/.env.apple-notarize.local`.

## Conventions worth knowing

- Adding a backend feature touches four layers in lockstep: Pydantic schema → FastAPI route in `main.py` → Rust command in `commands/` (and register it in `lib.rs`'s `invoke_handler!`) → contracts type + `tauri.ts` wrapper. Forgetting the `invoke_handler!` registration is the common miss.
- Long-running work (generation, ASR, downloads) is modeled as a `TaskManager` job that returns a `TaskRecord` immediately; the UI polls for completion. Don't add blocking endpoints for these.
- The React UI uses **state-machine view switching, not a router** — `App.tsx` toggles between `BootstrapFlowPage` and `WorkspacePage` based on bootstrap state.
- Trilingual UI (en / zh / zh-TW) via i18next; user-facing strings go through `app/src/locales/`, and errors carry a `userMessageKey` (see the `AppError` type) rather than a raw message.
- `findings.md`, `progress.md`, `task_plan.md`, and `docs/dev/` are gitignored local working notes — not part of the shipped project.
