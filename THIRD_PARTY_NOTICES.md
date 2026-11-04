# Third-Party Notices / 第三方组件与许可

Voca 自身以 Apache License 2.0 发布（见 [LICENSE](LICENSE)）。安装包与运行时还包含下述第三方组件。
本文件是**分发合规**的最低要求：随安装包一起提供本文件，并保证 GPL 组件的源码可获取性。

> 维护提示：新增/升级打包进产物的组件时，请同步更新本表。
> 表中“随包分发”指是否会被复制进 `.app` / NSIS 安装目录。

## 1. 桌面壳与前端

| 组件 | 版本 | 许可 | 随包分发 | 来源 |
|---|---|---|---|---|
| Tauri | 2.x | MIT / Apache-2.0 | 是（Rust 静态链接） | <https://github.com/tauri-apps/tauri> |
| React / React DOM | 19.x | MIT | 是 | <https://github.com/facebook/react> |
| i18next / react-i18next | 26.x / 17.x | MIT | 是 | <https://github.com/i18next/i18next> |
| Vite | 8.x | MIT | 否（仅构建期） | <https://github.com/vitejs/vite> |
| MiSans 字体 | — | 小米 MiSans 字体许可 | 是 | 见 `desktop/app/public/fonts/` |
| Manrope / Playfair Display | — | SIL OFL 1.1 | 是 | <https://fontsource.org> |

## 2. Python 推理 sidecar

| 组件 | 许可 | 随包分发 | 来源 |
|---|---|---|---|
| VoxCPM（推理引擎源码，git submodule） | Apache-2.0 | 是（`Resources/VoxCPM`） | <https://github.com/OpenBMB/VoxCPM> |
| FastAPI / Starlette / Uvicorn | MIT / BSD-3-Clause | 是（`.venv`） | <https://github.com/fastapi/fastapi> |
| PyTorch（macOS）/ torchaudio / torchcodec | BSD-3-Clause | 是 | <https://github.com/pytorch/pytorch> |
| ONNX Runtime | MIT | 是 | <https://github.com/microsoft/onnxruntime> |
| Hugging Face Hub / ModelScope SDK | Apache-2.0 | 是 | <https://github.com/huggingface/huggingface_hub> |
| NumPy / safetensors / soundfile / transformers / einops / inflect / wetext / tqdm | BSD / Apache-2.0 / MIT（各自仓库为准） | 是 | 见 `requirements.runtime.txt` |
| kaldi-native-fbank | Apache-2.0 | 是 | <https://github.com/csukuangfj/kaldi-native-fbank> |

## 3. 模型权重（首次启动下载，不随安装包分发）

| 模型 | 许可（上游声明） | 来源 |
|---|---|---|
| VoxCPM2 / VoxCPM1.5 / VoxCPM-0.5B | Apache-2.0 | <https://huggingface.co/openbmb> |
| SenseVoiceSmall（ONNX） | 代码 MIT；**ONNX 权重仓库未声明许可** | <https://github.com/FunAudioLLM/SenseVoice>、<https://huggingface.co/DennisHuang648/SenseVoiceSmall-onnx> |
| ZipEnhancer 16k | **未声明许可** | <https://modelscope.cn/models/iic/speech_zipenhancer_ans_multiloss_16k_base> |

> ⚠️ 待办：SenseVoiceSmall-onnx 目前同时从个人账号镜像（`DennisHuang648/...`）下载，
> 且权重仓库没有 license 字段；ZipEnhancer 的 ModelScope 模型页也未标注许可。
> 在正式对外分发前，应向模型方确认权重许可，或改用声明许可的官方仓库并固定 revision。

## 4. FFmpeg（macOS 打包，GPL 合规重点）

`desktop/scripts/prepare-dmg-resources.mjs` 会从 Homebrew bottle 下载 FFmpeg，并把
torchcodec 需要的动态库复制进 `.app`。

| 项 | 值 |
|---|---|
| 组件 | FFmpeg（Homebrew `ffmpeg` formula 构建） |
| 许可 | **GPL-3.0-or-later**（formula 声明：`GPL-3.0-or-later`） |
| 随包分发 | 是（`.app/Contents/Frameworks` 或等价位置） |

GPL-3.0 要求分发者向接收者提供**对应源码**（或书面源码获取方式）。
当前仓库没有附带 FFmpeg 源码与许可文本，**这是一个真实的合规缺口**。补齐方式二选一：

1. 在 `desktop/scripts/prepare-dmg-resources.mjs` 中把 FFmpeg 的 `COPYING.GPLv3`、
   构建配置（`ffmpeg -version` 输出）与源码下载地址一并写入安装包的 `Licenses/` 目录；或
2. 改用 LGPL 构建（`--disable-gpl`）或系统自带/用户自装的 FFmpeg，并从安装包中移除该二进制。

在补齐前，建议不要在 Release 页面把安装包描述为“可自由再分发”。

## 5. 其他随包文本

- 本文件应被复制进 macOS `.app/Contents/Resources/`（或与 DMG 同级）以及 Windows 安装目录。
- 打包脚本尚未实现该复制步骤，跟进项见 [issue #10](https://github.com/ZMXJJ/Voca/issues/10)。
