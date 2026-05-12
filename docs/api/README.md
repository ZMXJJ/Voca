# Voca Python Service API Reference

简体中文 | [繁體中文](../zh-TW/api/README.md)

Voca 的推理后端是一个 FastAPI sidecar 服务，由桌面端自动启动和管理。所有接口前缀为 `/api/v1`。

> 开发模式下，服务启动后可通过 `http://localhost:<port>/docs` 访问 Swagger UI 交互式文档。

## 接口总览

| 分组 | 方法 | 路径 | 说明 |
|------|------|------|------|
| **健康检查** | GET | [`/api/v1/health`](health.md) | 服务状态与诊断信息 |
| | GET | [`/api/v1/probe`](probe.md) | 轻量级 sidecar 存活探针 |
| **模型管理** | GET | [`/api/v1/models/catalog`](models.md#get-apiv1modelscatalog) | 模型目录列表 |
| | GET | [`/api/v1/providers/recommendation`](models.md#get-apiv1providersrecommendation) | 下载源推荐 |
| | POST | [`/api/v1/models/prepare`](models.md#post-apiv1modelsprepare) | 模型解析与准备 |
| | POST | [`/api/v1/models/validate`](models.md#post-apiv1modelsvalidate) | 模型路径校验 |
| | POST | [`/api/v1/models/download`](models.md#post-apiv1modelsdownload) | 下载单个模型（异步任务） |
| | POST | [`/api/v1/bootstrap/start`](models.md#post-apiv1bootstrapstart) | 启动引导下载（批量异步任务） |
| | POST | [`/api/v1/bootstrap/upgrade-cuda`](cuda-upgrade.md) | 启动 CUDA 推理运行时下载（仅 Windows） |
| | GET | [`/api/v1/bootstrap/runtime-info`](runtime-info.md) | 读取 CUDA 运行时元信息 |
| **任务管理** | POST | [`/api/v1/tasks/generate`](tasks.md#post-apiv1tasksgenerate) | 创建语音生成任务 |
| | POST | [`/api/v1/tasks/asr`](tasks.md#post-apiv1tasksasr) | 创建语音识别任务 |
| | GET | [`/api/v1/tasks`](tasks.md#get-apiv1tasks) | 任务列表（分页） |
| | GET | [`/api/v1/tasks/{task_id}`](tasks.md#get-apiv1taskstask_id) | 任务详情 |
| **声音库** | GET | [`/api/v1/voices`](voices.md#get-apiv1voices) | 声音列表 |
| | GET | [`/api/v1/voices/{voice_id}`](voices.md#get-apiv1voicesvoice_id) | 声音详情 |
| | POST | [`/api/v1/voices`](voices.md#post-apiv1voices) | 创建自定义声音 |
| | PATCH | [`/api/v1/voices/{voice_id}`](voices.md#patch-apiv1voicesvoice_id) | 更新声音信息 |
| | DELETE | [`/api/v1/voices/{voice_id}`](voices.md#delete-apiv1voicesvoice_id) | 删除自定义声音 |
| **缓存** | POST | [`/api/v1/cache/clear`](cache.md) | 清理缓存与已完成任务 |

## OpenAPI 规范

完整的 OpenAPI 3.1 规范文件：[`openapi.json`](openapi.json)

可导入到 Swagger Editor、Postman、Insomnia 等工具中使用。开发模式下也可直接访问 `http://localhost:8765/docs` 查看 FastAPI 自动生成的 Swagger UI。

## 通用约定

- **Content-Type**: 所有 POST/PATCH 请求体使用 `application/json`
- **字段命名**: camelCase（如 `modelKey`、`createdAt`）
- **错误响应**: HTTP 4xx/5xx，body 格式为 `{"detail": "错误描述"}`
- **异步任务**: 生成、ASR、下载等耗时操作均为异步，创建后返回 `TaskRecord`，通过轮询 `GET /api/v1/tasks/{task_id}` 获取进度和结果
