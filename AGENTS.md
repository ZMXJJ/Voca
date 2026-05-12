# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

Voca is a three-layer Tauri 2 desktop app for local voice cloning and TTS: **Rust shell** (Tauri) → **React frontend** (TypeScript + Vite) → **Python FastAPI sidecar** (inference).

### Services

| Service | Location | Dev Command | Port |
|---------|----------|-------------|------|
| React Frontend | `desktop/app/` | `npm run dev` (from `desktop/app/`) | 127.0.0.1:1420 |
| Python Sidecar | `desktop/python-service/` | `source .venv/bin/activate && uvicorn app.main:app --host 127.0.0.1 --port 8765` | 127.0.0.1:8765 |
| Tauri Shell (Rust) | `desktop/src-tauri/` | `cargo check` (GUI not available on headless Linux) | N/A |

### Important Dev Notes

- **Rust edition 2024**: Requires Rust 1.85+. Run `rustup default stable` to ensure the right toolchain is active.
- **Tauri bundle resources**: `cargo check` requires `desktop/.bundle-resources/{python-service,python-runtime,VoxCPM}` directories to exist (can be empty for dev). Create them with `mkdir -p`.
- **Tauri desktop shell cannot run on headless Linux** (needs webkit2gtk display). Use `cargo check` / `cargo clippy` for Rust validation. The frontend and Python sidecar can run independently.
- **TypeScript typecheck**: Run from the app directory: `cd desktop/app && npx tsc -b`. The `npm run typecheck:web` script from `desktop/` searches for a root tsconfig that doesn't exist.
- **ESLint**: `cd desktop/app && npx eslint .` — existing code has some warnings/errors (react-hooks rules).
- **Python venv**: Located at `desktop/python-service/.venv`. Activate before running the sidecar.
- **Contracts package** (`desktop/packages/contracts/`): Pure TypeScript types shared between frontend and Rust layer. Install its deps with `cd desktop/packages/contracts && npm install`.
- **No lockfile for root** (`desktop/package.json`): Only `@tauri-apps/cli` as a devDependency; `desktop/app/` has its own `package-lock.json`.
- **VoxCPM submodule** (`VoxCPM/`): Not needed for dev unless testing actual TTS inference locally.

### Running Tests

No automated test suite is currently configured. Validation is done via:
- `cd desktop/app && npx eslint .` (lint)
- `cd desktop/app && npx tsc -b` (typecheck)
- `cd desktop/src-tauri && cargo check` (Rust compilation)
- `cd desktop/src-tauri && cargo clippy` (Rust lint)
- Manual API testing against the Python sidecar (e.g. `curl http://127.0.0.1:8765/api/v1/health`)
