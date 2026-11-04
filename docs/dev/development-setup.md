# 二次开发环境搭建 / Development Setup

> 目标读者：想在本机编译、调试、打包 Voca 的贡献者。
> 这份文档只写**当前仓库真实存在**的路径与命令；如果你发现它和代码不一致，请提 issue。

## 0. 先看结论

Voca 是三层结构，仓库里对应三个目录：

| 层 | 目录 | 你改的东西 |
|---|---|---|
| 桌面壳（Rust / Tauri 2） | `desktop/src-tauri/` | 进程监管、Tauri command、安装器 |
| 前端（React 19 + TS + Vite） | `desktop/app/` | 界面、i18n、状态 |
| 推理服务（FastAPI sidecar） | `desktop/python-service/` | 任务队列、模型下载、TTS/ASR 封装 |

Tauri 在启动时会**自动拉起 Python sidecar**（`desktop/src-tauri/src/sidecar.rs`），
所以正常开发只需要 `npm run tauri dev`，不需要手动起 Python。

## 1. 前置依赖

| 平台 | 需要 |
|---|---|
| macOS 14+ (Apple Silicon) | Xcode Command Line Tools、Node.js ≥ 20、Rust stable、Python 3.11 或 3.12 |
| Windows 10 22H2+ / 11 (x86_64) | Visual Studio Build Tools（C++ 桌面开发）、Node.js ≥ 20、Rust stable、Python 3.11 或 3.12、NVIDIA 驱动 |

> 推理引擎 VoxCPM 是 git submodule，**必须**带 `--recurse-submodules` 克隆，否则
> `VoxCPM/src` 不存在，sidecar 会在 import 阶段失败。

```bash
git clone --recurse-submodules https://github.com/ZMXJJ/Voca.git
cd Voca
git submodule update --init --recursive   # 已经 clone 过、但忘了 submodule 时补这一步
```

## 2. 安装依赖

```bash
# Python sidecar
cd desktop/python-service
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.runtime.txt -r requirements.runtime.macos.txt
# Windows 用： .venv\Scripts\pip install -r requirements.runtime.txt -r requirements.runtime.windows.txt

# 前端 + Tauri CLI
cd ../..          # 回到仓库根目录的 desktop/
npm install
npm --prefix app install
```

说明：

- `requirements.runtime.txt` 是跨平台基线；`requirements.runtime.macos.txt` / `.windows.txt`
  只放平台专属轮子（macOS 的 torch/torchaudio/torchcodec + CPU `onnxruntime`，
  Windows 的 `onnxruntime-gpu`）。
- **Windows 安装包默认不带 torch**：正式安装时首启动会把 CUDA 版 torch/torchaudio
  下载到 `%APPDATA%\Voca\runtime\site-packages`。本地开发如果想直接跑推理，
  可以在 `.venv` 里自行 `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124`，
  sidecar 会优先使用它。
- 不要为了“省空间”只装 `pyproject.toml` 的依赖——它只声明了 import 期基线，
  真正锁定的版本在 `requirements.runtime*.txt`。

## 3. 跑起来

```bash
cd desktop
npm run tauri dev
```

- 前端 dev server 由 Tauri 启动（`vite`，端口 1420）。
- Tauri 会 spawn `desktop/python-service/.venv` 里的解释器，命令形如
  `python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --log-level warning`
  （见 `desktop/src-tauri/src/sidecar.rs`）。
- sidecar 的日志写到 `~/Library/Application Support/Voca/logs/service.log`
  （Windows 为 `%APPDATA%\Voca\logs\service.log`）。需要更详细的应用日志时，
  启动前 `export VOCA_LOG_LEVEL=INFO`（sidecar 会把它用于 `app.*` logger）。

### 只调后端（不起桌面端）

```bash
cd desktop/python-service
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --log-level info
# 打开 http://127.0.0.1:8765/docs
```

注意：桌面端和这个手动实例会抢同一个端口 8765，同开前先关掉另一个。

### 只调前端

```bash
cd desktop/app
npm run dev        # http://127.0.0.1:1420
```

此时没有 Tauri IPC，`lib/tauri.ts` 里的 invoke 会失败；要看界面可以配合
`?preview=workspace|settings|bootstrap|all`（见 `src/preview.ts`）。

## 4. 常用环境变量

| 变量 | 作用 |
|---|---|
| `VOCA_APP_SUPPORT_DIR` | 覆盖应用数据目录（测试/多配置隔离用） |
| `VOCA_MODEL_DIR` | 覆盖模型目录 |
| `VOCA_LOG_LEVEL` | sidecar 应用日志级别，默认 `INFO` |
| `VOCA_DISABLE_DOWNLOAD_PING=1` | 关闭启动时的模型下载计数 ping |
| `HF_HOME` / `HF_HUB_CACHE` / `MODELSCOPE_CACHE` / `TORCH_HOME` | 覆盖各下载缓存目录 |
| `VOCA_DEV_BUNDLE_ROOT` | 指定一个已准备好的 bundle 资源目录，跳过源码模式 |

## 5. 测试与静态检查

```bash
# Python（当前覆盖 manifest/校验/promote、路径解析、下载源推荐）
cd desktop/python-service
.venv/bin/python -m pytest

# 前端
cd desktop/app
npm run lint
npm run typecheck      # 注意：当前 tsconfig 未开启 strict，见 issue
```

## 6. 打包

```bash
cd desktop
npm run build:dmg      # macOS：先 prepare:dmg 再 tauri build --bundles dmg
npm run build:nsis     # Windows：NSIS 安装包
```

- `scripts/prepare-dmg-resources.mjs` 会把 Python runtime、VoxCPM 源码和
  FFmpeg/torchcodec 动态库复制到 `desktop/.bundle-resources/`，再交给 Tauri 打包。
- macOS 签名/公证依赖本机的 `desktop/.env.apple-notarize.local`（已在 `.gitignore` 中），
  或参考 `scripts/build-dmg-appleid-local.sh` 里的环境变量名。
- 构建产物在 `desktop/src-tauri/target/release/bundle/`。

## 7. 提交前检查清单

- [ ] `cd desktop/python-service && .venv/bin/python -m pytest`
- [ ] `cd desktop/app && npm run lint && npm run typecheck`
- [ ] 改到 sidecar 协议时，同步 `desktop/packages/contracts/src/index.ts` 与 `docs/api/`
- [ ] 改到模型/资源行为时，同步 `docs/architecture.md` 与 `docs/api/models.md`
- [ ] 不要提交 `desktop/.bundle-resources*`、`node_modules`、`.venv`、`target/`
