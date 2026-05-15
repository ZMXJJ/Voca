# Linux build guide

Voca supports Linux x86_64 bundles in two modes:

- CPU: broad compatibility, no NVIDIA hardware required.
- NVIDIA: CUDA inference, requires a compatible NVIDIA driver on the target host.

## Prerequisites

- Linux x86_64 build host.
- Node.js and npm.
- Rust toolchain.
- `uv` on `PATH` or `UV_BIN` pointing to the `uv` executable.
- Tauri Linux build dependencies, including WebKitGTK, GTK, librsvg, and AppImage/deb packaging tools for your distribution.

## Build CPU bundles

```bash
cd desktop
npm install
npm run build:linux:cpu
```

This creates `desktop/.bundle-resources-linux` with CPU ONNX Runtime and CPU PyTorch wheels.

## Build NVIDIA bundles

```bash
cd desktop
npm install
VOCA_LINUX_TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128 npm run build:linux:nvidia
```

The NVIDIA bundle uses `onnxruntime-gpu` and marks the packaged runtime as CUDA-enabled. At launch, the Rust sidecar reads `python-service/manifest.json` and sets `VOCA_REQUIRE_CUDA=1`, so both VoxCPM and SenseVoice require CUDA instead of silently falling back to CPU.

Override `VOCA_LINUX_TORCH_INDEX_URL` when upgrading PyTorch/CUDA wheels.

## Development

```bash
cd desktop
npm run dev
```

The dev script configures the macOS SDK only on macOS, so it can run on Linux without `xcrun`.
