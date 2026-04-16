<p align="center">
  <img src="assets/voca-logo.png" alt="Voca Logo" width="256" />
</p>

<h1 align="center">Voca</h1>

<p align="center"><em>Your Local Voice Clone Assistant</em></p>

<p align="center">
  一款运行在本地的语音克隆桌面应用，无需联网即可完成语音合成与声音克隆。
</p>

---

## 功能介绍

### 语音生成工作台

输入文本，选择模型和声音，一键生成高质量语音。支持队列化任务管理，可同时提交多个生成请求。

生成参数可自由调节：

- **CFG Scale** — 控制生成的引导强度
- **推理步数** — 平衡生成质量与速度
- **种子值** — 固定种子可复现结果，也可随机生成
- **文本归一化** — 自动处理数字、缩写等文本规范化
- **后处理降噪** — 生成后自动去除背景噪声
- **极致克隆模式** — 使用参考音频的转录文本，进一步提升声音克隆的还原度

### 声音库

管理预设与自定义声音。创建自定义声音时可上传参考音频，应用内置 SenseVoice ASR 引擎自动转录参考音频文本，转录结果支持手动编辑校正。

### 生成历史

查看所有生成任务的状态（排队中 / 生成中 / 已完成 / 失败 / 已取消），已完成的任务可直接播放试听。

### 模型管理

内置模型目录，支持从 Hugging Face 或 ModelScope 下载模型。可管理 TTS 主模型及辅助模型（ASR、音频增强）。

### 首次启动引导

首次运行时自动完成环境检测、运行时下载、模型下载与校验、模型预热等初始化流程，开箱即用。

### 多语言

支持中文和英文界面。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端 | React 19 + TypeScript + Vite |
| 推理服务 | Python (FastAPI + Uvicorn) |
| 语音引擎 | VoxCPM |
| 平台 | macOS 14.0+ |

## 应用内更新检查

设置中的「检查更新」会请求 GitHub Releases 的 `latest` 接口。开源后请在 [`desktop/src-tauri/src/commands/updater.rs`](desktop/src-tauri/src/commands/updater.rs) 顶部将 `GITHUB_REPO` 改为你的 `owner/repo`；有新版本时会打开浏览器跳转到对应 Release 页面下载。

## 许可证

本项目仅供个人学习与研究使用。
