# Voca 架構概覽

## 整體架構

Voca 採用三層架構：**Tauri (Rust) 桌面殼** → **React 前端** → **Python 推理 sidecar**。

```mermaid
graph TB
    subgraph Desktop["Voca Desktop"]
        subgraph Frontend["React UI (TypeScript)"]
            Pages["Pages<br/>Bootstrap / Workspace"]
            TauriTS["lib/tauri.ts<br/>invoke() 封裝"]
        end

        subgraph Rust["Tauri Shell (Rust)"]
            Commands["Tauri Commands<br/>bootstrap / models / tasks / voices / audio"]
            Sidecar["Sidecar Manager<br/>啟動 · 健康檢查 · 終止"]
            RustOnly["Rust-only 命令<br/>onboarding · logs · updater · file dialog"]
        end

        subgraph Python["Python Sidecar (FastAPI + Uvicorn)"]
            Routes["main.py<br/>17 API Endpoints"]
            TaskMgr["TaskManager<br/>任務編排"]
            VoxCPM["VoxCPM<br/>TTS Engine"]
            ASR["SenseVoice<br/>ASR Engine"]
            Enhancer["ZipEnhancer<br/>音訊增強"]
            VoiceLib["VoiceLibrary<br/>SQLite + 檔案"]
        end
    end

    Pages --> TauriTS
    TauriTS -- "invoke (IPC)" --> Commands
    TauriTS -- "invoke (IPC)" --> RustOnly
    Commands -- "HTTP 127.0.0.1:8765" --> Routes
    Sidecar -. "管理生命週期" .-> Python
    Routes --> TaskMgr
    Routes --> VoiceLib
    TaskMgr --> VoxCPM
    TaskMgr --> ASR
    TaskMgr --> Enhancer
```

## 通訊流程

前端不直接與 Python 服務通訊，所有請求經由 Tauri IPC 中轉：

```mermaid
sequenceDiagram
    participant UI as React UI
    participant Rust as Tauri (Rust)
    participant Py as Python Sidecar

    UI->>Rust: invoke("command_name", payload)
    Rust->>Rust: ensure_sidecar_running()
    alt 需要 Python 處理
        Rust->>Py: HTTP request (reqwest)
        Py-->>Rust: JSON response
    else Rust-only 命令
        Rust->>Rust: 本地處理
    end
    Rust-->>UI: 返回結果
```

Rust 層在轉發前會確保 sidecar 已啟動且健康。部分命令（如完成引導、匯出日誌、檢查更新）由 Rust 直接處理，不經過 Python。

## 目錄結構

```
Voca/
├── desktop/
│   ├── app/                      # React 前端
│   │   ├── src/
│   │   │   ├── pages/            # 頁面元件
│   │   │   │   ├── BootstrapFlowPage.tsx   # 首次啟動引導
│   │   │   │   ├── WorkspacePage.tsx        # 主工作區
│   │   │   │   └── PreviewGalleryPage.tsx   # 開發預覽
│   │   │   ├── components/       # UI 元件
│   │   │   ├── lib/
│   │   │   │   ├── tauri.ts      # Tauri invoke 封裝（唯一的後端通訊層）
│   │   │   │   └── historyStorage.ts  # 本地任務歷史持久化
│   │   │   └── App.tsx           # 根元件，基於狀態機的檢視切換
│   │   └── public/               # 靜態資源
│   │
│   ├── src-tauri/                # Rust 桌面殼
│   │   ├── src/
│   │   │   ├── lib.rs            # 應用入口，命令註冊，退出清理
│   │   │   ├── state.rs          # AppState（sidecar 埠、程序控制代碼）
│   │   │   ├── sidecar.rs        # Python sidecar 生命週期管理
│   │   │   └── commands/         # Tauri 命令實現
│   │   │       ├── bootstrap.rs  # 引導流程狀態與控制
│   │   │       ├── models.rs     # 模型目錄、下載、驗證
│   │   │       ├── tasks.rs      # 語音生成 & ASR 任務
│   │   │       ├── voices.rs     # 聲音庫 CRUD
│   │   │       ├── audio.rs      # 音訊檔案操作（選擇、讀取、儲存）
│   │   │       └── updater.rs    # GitHub Releases 更新檢查
│   │   └── tauri.conf.json       # Tauri 打包配置
│   │
│   ├── python-service/           # Python 推理服務
│   │   ├── app/
│   │   │   ├── main.py           # FastAPI 路由定義（17 個端點）
│   │   │   ├── models/
│   │   │   │   └── schemas.py    # Pydantic 請求/響應模型
│   │   │   └── services/         # 業務邏輯層
│   │   │       ├── task_manager.py       # 任務編排（生成、ASR、下載）
│   │   │       ├── voxcpm_bridge.py      # VoxCPM TTS 引擎橋接
│   │   │       ├── asr_bridge.py         # SenseVoice ASR 橋接
│   │   │       ├── audio_enhancer.py     # ZipEnhancer 音訊增強
│   │   │       ├── voice_library.py      # 聲音庫（SQLite + 檔案）
│   │   │       ├── model_catalog.py      # 模型目錄管理
│   │   │       ├── bootstrap_assets.py   # 引導資源就緒檢查
│   │   │       ├── provider_router.py    # 下載源路由（HF vs ModelScope）
│   │   │       └── storage_paths.py      # 儲存路徑規範
│   │   └── requirements.runtime.txt      # 執行時依賴
│   │
│   ├── packages/
│   │   └── contracts/            # 共享 TypeScript 類型定義
│   │       └── src/index.ts      # 前端與 Rust 的介面契約
│   │
│   └── scripts/                  # 構建輔助指令碼
│
├── VoxCPM/                       # VoxCPM 語音引擎（子目錄）
├── docs/                         # 文件
└── assets/                       # 倉庫級資源（logo 等）
```

## 模組詳解

### Tauri 桌面殼 (Rust)

負責視窗管理、系統整合和 sidecar 生命週期。

**Sidecar 管理** (`sidecar.rs`):
- 啟動時檢測埠 8765 是否已有服務執行
- 若無，則啟動 Python uvicorn 子程序
- 健康檢查：最多輪詢 20 次（間隔 250ms）等待 `/api/v1/health` 就緒
- 驗證 OpenAPI 相容性（檢查關鍵路徑是否存在）
- 應用退出時自動終止子程序

**Rust-only 命令**（不經過 Python）:
- `complete_onboarding` — 寫入引導完成標記檔案
- `export_logs` — 收集並匯出日誌
- `check_for_update` — 請求 GitHub Releases API
- `pick_audio_file` / `save_audio_as` — 系統檔案對話方塊
- `get_setup_diagnostics` — 系統環境檢測

### React 前端

基於狀態機的檢視切換，而非傳統路由：

```mermaid
stateDiagram-v2
    [*] --> welcome: 首次啟動
    welcome --> download: 使用者確認
    download --> initialize: 模型下載完成
    initialize --> complete: 預熱完成
    complete --> workspace: 使用者點選進入
    [*] --> workspace: 非首次啟動

    state "BootstrapFlowPage" as bootstrap {
        welcome: 歡迎頁
        download: 模型下載
        initialize: 模型預熱
        complete: 初始化完成
    }

    workspace: WorkspacePage (主工作區)
```

前端透過 `lib/tauri.ts` 中封裝的 `invoke()` 呼叫與 Rust 層通訊，不存在直接的 HTTP 請求。

### Python 推理服務

FastAPI 單檔案路由 + 分層 service 模組：

```mermaid
graph LR
    main["main.py<br/>FastAPI Routes"]

    main --> TM["TaskManager<br/>任務編排"]
    main --> VL["VoiceLibrary<br/>聲音 CRUD"]
    main --> BA["BootstrapAssets<br/>資源檢測"]

    TM --> Bridge["VoxCPMBridge<br/>TTS 推理"]
    TM --> ASR["ASRBridge<br/>語音識別"]
    TM --> AE["AudioEnhancer<br/>音訊增強"]

    VL --> DB[("SQLite<br/>voca.db")]

    Bridge --> MC["ModelCatalog"]
    Bridge --> PR["ProviderRouter<br/>HF / ModelScope"]
```

**TaskManager** 是核心編排器，管理後臺執行緒中的生成、ASR 和下載任務，維護記憶體中的 `TaskRecord` 列表。

## 核心資料流

### 語音生成

```mermaid
sequenceDiagram
    participant User as 使用者
    participant UI as React UI
    participant Rust as Tauri (Rust)
    participant Py as Python Service
    participant TM as TaskManager
    participant Engine as VoxCPM

    User->>UI: 輸入文字，點選生成
    UI->>Rust: invoke("create_generate_task")
    Rust->>Py: POST /api/v1/tasks/generate
    Py->>TM: create_generate_task()
    TM-->>Py: TaskRecord (queued)
    Py-->>Rust: TaskRecord
    Rust-->>UI: TaskRecord

    TM->>Engine: generate_audio() [後臺執行緒]
    Engine-->>TM: 音訊檔案
    opt 啟用降噪
        TM->>TM: AudioEnhancer 後處理
    end
    TM->>TM: TaskRecord → succeeded

    loop 輪詢直到完成
        UI->>Rust: invoke("get_task")
        Rust->>Py: GET /api/v1/tasks/{id}
        Py-->>Rust: TaskRecord (最新狀態)
        Rust-->>UI: TaskRecord
    end

    User->>UI: 播放 / 匯出音訊
```

### 首次引導 (Bootstrap)

```mermaid
flowchart TD
    Start([App 啟動]) --> QuickCheck["invoke('get_quick_bootstrap_state')<br/>檢查 onboarding.json"]
    QuickCheck -->|不存在| Bootstrap["顯示 BootstrapFlowPage"]
    QuickCheck -->|已存在| Workspace["進入 WorkspacePage"]

    Bootstrap --> GetState["invoke('get_bootstrap_state')<br/>啟動 sidecar + 檢查資源狀態"]
    GetState --> UserClick["使用者點選下載"]
    UserClick --> StartDL["invoke('start_bootstrap_download')<br/>POST /api/v1/bootstrap/start"]

    StartDL --> DL_TTS["下載 VoxCPM (TTS)"]
    StartDL --> DL_ASR["下載 SenseVoice (ASR)"]
    StartDL --> DL_ENH["下載 ZipEnhancer"]

    DL_TTS --> Poll["輪詢任務進度"]
    DL_ASR --> Poll
    DL_ENH --> Poll

    Poll -->|全部完成| Complete["invoke('complete_onboarding')<br/>寫入標記檔案"]
    Complete --> Workspace
```

### 聲音複製

```mermaid
sequenceDiagram
    participant User as 使用者
    participant UI as React UI
    participant Py as Python Service

    User->>UI: 上傳參考音訊
    UI->>Py: POST /api/v1/tasks/asr
    Py-->>UI: transcript (轉錄文字)
    User->>UI: 編輯/確認轉錄文字

    UI->>Py: POST /api/v1/voices
    Note over Py: 儲存到 SQLite<br/>複製音訊檔案到 voices/
    Py-->>UI: VoiceEntry

    User->>UI: 選擇該聲音，輸入文字，生成
    UI->>Py: POST /api/v1/tasks/generate
    Note over Py: 使用參考音訊 +<br/>轉錄文字進行複製
    Py-->>UI: TaskRecord → 複製音訊
```

## 本地儲存

所有使用者資料儲存在 `~/Library/Application Support/Voca/`:

```
Voca/
├── models/           # 下載的模型檔案
├── voices/           # 使用者聲音庫（音訊 + 後設資料）
├── audio/            # 生成的音訊輸出
├── logs/             # 服務日誌（自動輪轉，5 MB 上限）
├── voca.db           # SQLite 資料庫（聲音庫）
├── onboarding.json   # 引導完成標記
└── model_catalog.json # 執行時模型目錄副本
```
