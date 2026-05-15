<p align="center">
  <br />
  <img src="assets/voca-logo.png" alt="Voca Logo" width="280" />
  <br /><br />
</p>

<h1 align="center">Voca — 本地語音複製桌面助手</h1>

<p align="center">
  <a href="README.md">English</a> | <a href="README_zh.md">简体中文</a> | 繁體中文
</p>

<p align="center">
  <a href="https://github.com/ZMXJJ/Voca/releases"><img src="https://img.shields.io/github/v/release/ZMXJJ/Voca?style=flat-square&label=Download" alt="Release" /></a>
  <a href="https://github.com/ZMXJJ/Voca/stargazers"><img src="https://img.shields.io/github/stars/ZMXJJ/Voca?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/ZMXJJ/Voca/issues"><img src="https://img.shields.io/github/issues/ZMXJJ/Voca?style=flat-square" alt="Issues" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  一款執行在本地的語音複製桌面應用。下載即用，無需聯網即可完成高品質語音合成與聲音複製！
</p>

<p align="center">
  <br />
  <a href="https://github.com/ZMXJJ/Voca/releases/latest">
    <img src="https://img.shields.io/badge/下載_macOS_版本-7c3aed?style=for-the-badge&logo=apple&logoColor=white" alt="下載 macOS 版" />
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/ZMXJJ/Voca/releases/latest">
    <img src="https://img.shields.io/badge/下載_Windows_版本-0078D4?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDMuNDk1bDkuODQtMS4zOFYxMS4wNUgwVjMuNDk1ek0wIDEyLjk1aDkuODR2OC45MzVMMCwyMC41MDVWMTIuOTV6TTEwLjk1IDEuOTc1TDI0IDB2MTEuMDVIMTAuOTVWMS45NzV6TTEwLjk1IDEyLjk1SDI0VjI0bC0xMy4wNS0xLjk3NVYxMi45NXoiLz48L3N2Zz4=&logoColor=white" alt="下載 Windows 版" />
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/ZMXJJ/Voca/releases/latest">
    <img src="https://img.shields.io/badge/下載_Linux_版本-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="下載 Linux 版" />
  </a>
  <br />
  <sub>Windows 推理僅支援 NVIDIA 顯示卡；Linux 支援 CPU 與 NVIDIA GPU 構建</sub>
</p>

---

## 應用截圖

<p align="center">
  <img src="assets/screenshot-workspace-zh.png" alt="語音創作工作區" width="48%" />
  &nbsp;
  <img src="assets/screenshot-settings-zh.png" alt="設定頁" width="48%" />
</p>

## Highlights

- **完全離線** — 模型下載完成後，所有推理在本地完成，無需聯網，無隱私顧慮
- **開箱即用** — 首次啟動自動完成環境檢測、執行時下載、模型下載與預熱，無需任何手動配置
- **高品質語音複製** — 基於 VoxCPM 引擎，支援中英雙語語音合成與聲音複製
- **精細可控** — CFG 引導強度、推理步數、種子值、文字歸一化、後處理降噪等參數均可調節
- **極致複製模式** — 使用參考音訊的轉錄文字進一步提升聲音還原度
- **內建 ASR** — 使用 SenseVoice 小型 ONNX 模型（ONNX Runtime，CPU）將參考音訊轉錄為文字，支援手動編輯校正
- **雙源模型下載** — 支援從 Hugging Face 或 ModelScope 下載模型，自動推薦最佳源
- **三語介面** — 支援繁體中文、簡體中文和英文

## 目錄

- [快速開始](#快速開始)
- [功能介紹](#功能介紹)
- [技術棧](#技術棧)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [已知限制](#已知限制)
- [致謝](#致謝)
- [許可證](#許可證)

## 快速開始

### 系統要求

| 項目 | macOS | Windows | Linux |
|------|-------|---------|-------|
| 版本 | macOS 14.0 (Sonoma) 及以上 | Windows 10 22H2 / Windows 11（x86_64） | 現代 x86_64 桌面 Linux，需 WebKitGTK 執行階段函式庫 |
| 晶片 | Apple Silicon (M1/M2/M3/M4) | Intel/AMD x86_64（需 NVIDIA GPU） | Intel/AMD x86_64 CPU，可選 NVIDIA GPU |
| 磁碟空間 | 約 6 GB（應用 + 模型） | 約 11 GB（應用 + 模型 + CUDA runtime；runtime 下載約 2.5 GB） | CPU 構建約 6 GB；NVIDIA 構建需額外 CUDA wheel 空間 |
| 推理後端 | 預設 MPS（Apple Silicon） | CUDA（需 NVIDIA GPU） | 預設 CPU；使用 `VOCA_LINUX_ACCELERATOR=nvidia` 構建時啟用 CUDA |

### 安裝

**macOS**

1. 前往 [Releases](https://github.com/ZMXJJ/Voca/releases) 頁面，下載最新版本的 `.dmg` 檔案
2. 開啟 DMG，將 Voca 拖入「應用程式」資料夾
3. 首次開啟時，按照引導完成模型下載即可開始使用

**Windows**

1. 前往 [Releases](https://github.com/ZMXJJ/Voca/releases) 頁面，下載最新的 `Voca-x.y.z-x64-setup.exe`
2. 雙擊安裝包（按使用者安裝，無需管理員權限），安裝完成後從開始功能表啟動 Voca
3. 首次啟動時，引導流程會自動下載 CUDA runtime（下載約 2.5 GB，支援斷點續傳）

> **注意：** CUDA runtime 安裝需要約 **5 GB** 的額外可用磁碟空間，請確保安裝前磁碟空間充足。

**Linux**

1. 前往 [Releases](https://github.com/ZMXJJ/Voca/releases) 頁面，下載最新的 `.deb` 或 `.AppImage`
2. 通用裝置請選擇 CPU 構建；具備相容 NVIDIA 驅動的裝置可選擇 NVIDIA 構建以啟用 CUDA 推理
3. 首次開啟時，按照引導完成模型下載即可開始使用

> **關於 App 簽名與公證**
>
> Voca 已透過 Apple Developer ID 簽名，並已提交 Apple 公證（Notarization）審核透過，可在 macOS 上安全執行。
>
> 如果首次開啟時仍然遇到 macOS Gatekeeper 攔截（例如提示「"Voca" 無法開啟」「已損壞，無法開啟」或「無法驗證開發者」），通常是因為系統對從瀏覽器下載的檔案新增了隔離屬性（quarantine）。可在終端執行以下命令解除隔離：
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Voca.app
> ```
>
> 執行後重新開啟 Voca 即可。如果仍有問題，也可以在「系統設定 → 隱私與安全性」中點選「仍要開啟」來放行。

### 首次啟動

Voca 內建了完整的初始化引導流程：

**環境檢測** → **執行時下載** → **模型下載與驗證** → **模型預熱** → **進入工作區**

整個過程只需跟隨引導點選即可，無需任何手動配置。

## 功能介紹

### 語音生成工作區

輸入文字，選擇模型和聲音，一鍵生成高品質語音。支援佇列化任務管理，可同時提交多個生成請求。

可調節的生成參數：

| 參數 | 說明 |
|------|------|
| CFG Scale | 控制生成的引導強度 |
| 推理步數 | 平衡生成品質與速度 |
| 種子值 | 固定種子可復現結果，也可隨機生成 |
| 文字歸一化 | 自動處理數字、縮寫等文字規範化 |
| 後處理降噪 | 生成後自動去除背景噪聲 |
| 極致複製模式 | 使用參考音訊的轉錄文字，進一步提升聲音複製的還原度 |

### 聲音庫

管理預設與自訂聲音。建立自訂聲音時可上傳參考音訊，應用內建 SenseVoice ONNX 辨識器自動轉錄參考音訊文字，轉錄結果支援手動編輯校正。

### 生成歷史

檢視所有生成任務的狀態（排隊中 / 生成中 / 已完成 / 失敗 / 已取消），已完成的任務可直接播放試聽並匯出音訊檔案。

### 模型管理

內建模型目錄，支援從 Hugging Face 或 ModelScope 下載模型，根據網路環境自動推薦最佳下載源。可管理 TTS 主模型及輔助模型（ASR、音訊增強）。

### 應用內更新檢查

在設定中可檢查新版本，有更新時自動跳轉到對應 Release 頁面下載。

## 技術棧

| 層級 | 技術 |
|------|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端 | React 19 + TypeScript + Vite |
| 推理服務 | Python (FastAPI + Uvicorn) sidecar |
| 語音引擎 | VoxCPM |
| 執行時 | Python 3.11+ |
| 平台 | macOS 14.0+ (Apple Silicon) |

## Roadmap

> 以下是 Voca 後續的開發方向，優先順序可能根據社群反饋調整。

- [x] **更輕量的模型推理後端** — 已將 ASR 從 PyTorch/FunASR 遷移至 ONNX Runtime（`iic/SenseVoiceSmall-onnx`，INT8），大幅減少 App 體積和模型下載大小
- [ ] **量化模型支援** — 引入 INT8 等量化推理，降低記憶體佔用與磁碟空間需求
- [ ] **更豐富的 TTS 功能** — 支援更多 TTS 模型和更豐富的語音合成能力
- [ ] **Windows 端更輕量的資源佔用** — 降低 Windows 端的磁碟與記憶體佔用，優化整體體積
- [x] Windows 平台支援（x86_64，NSIS 安裝器，可選 CUDA 升級）

有想法或建議？歡迎透過 [Issues](https://github.com/ZMXJJ/Voca/issues) 告訴我們。

## Contributing

> **注意：** Voca 目前仍處於早期開發階段，工程化體驗（構建流程、開發文件、程式碼結構等）可能還不夠完善。如果你在使用或開發過程中遇到任何問題，非常歡迎提 Issue 或直接參與貢獻，一起把它變得更好。

你可以透過以下方式參與：

- 提交 Bug 報告或功能建議 → [Issues](https://github.com/ZMXJJ/Voca/issues)
- 提交程式碼改進 → Pull Request
- 完善文件或翻譯

## 已知限制

- 目前支援 macOS（Apple Silicon）和 Windows x86_64；Linux 暫無支援計畫
- 首次啟動需聯網下載模型（約 1-2 GB），之後可完全離線使用
- 語音複製效果受參考音訊品質影響較大，建議使用清晰、無背景噪聲的音訊

## 致謝

- [VoxCPM](https://github.com/OpenBMB/VoxCPM) — 語音合成引擎
- [Tauri](https://tauri.app/) — 桌面應用框架
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — 語音識別模型
- Model: [Claude Opus 4.6](https://www.anthropic.com/) & [GPT-5.4](https://openai.com/)

## 許可證

本專案基於 [Apache License 2.0](LICENSE) 開源。

---

<p align="center">
  <a href="https://star-history.com/#ZMXJJ/Voca&Date">
    <img src="https://api.star-history.com/svg?repos=ZMXJJ/Voca&type=Date" width="600" alt="Star History" />
  </a>
</p>
