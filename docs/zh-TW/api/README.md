# Voca Python Service API Reference

[简体中文](../../api/README.md) | 繁體中文

Voca 的推理後端是一個 FastAPI sidecar 服務，由桌面端自動啟動和管理。所有介面字首為 `/api/v1`。

> 開發模式下，服務啟動後可透過 `http://localhost:<port>/docs` 訪問 Swagger UI 互動式文件。

## 介面總覽

| 分組 | 方法 | 路徑 | 說明 |
|------|------|------|------|
| **健康檢查** | GET | [`/api/v1/health`](health.md) | 服務狀態與診斷資訊 |
| **模型管理** | GET | [`/api/v1/models/catalog`](models.md#get-apiv1modelscatalog) | 模型目錄列表 |
| | GET | [`/api/v1/providers/recommendation`](models.md#get-apiv1providersrecommendation) | 下載源推薦 |
| | POST | [`/api/v1/models/prepare`](models.md#post-apiv1modelsprepare) | 模型解析與準備 |
| | POST | [`/api/v1/models/validate`](models.md#post-apiv1modelsvalidate) | 模型路徑驗證 |
| | POST | [`/api/v1/models/download`](models.md#post-apiv1modelsdownload) | 下載單個模型（非同步任務） |
| | POST | [`/api/v1/bootstrap/start`](models.md#post-apiv1bootstrapstart) | 啟動引導下載（批次非同步任務） |
| **任務管理** | POST | [`/api/v1/tasks/generate`](tasks.md#post-apiv1tasksgenerate) | 建立語音生成任務 |
| | POST | [`/api/v1/tasks/asr`](tasks.md#post-apiv1tasksasr) | 建立語音識別任務 |
| | GET | [`/api/v1/tasks`](tasks.md#get-apiv1tasks) | 任務列表（分頁） |
| | GET | [`/api/v1/tasks/{task_id}`](tasks.md#get-apiv1taskstask_id) | 任務詳情 |
| **聲音庫** | GET | [`/api/v1/voices`](voices.md#get-apiv1voices) | 聲音列表 |
| | GET | [`/api/v1/voices/{voice_id}`](voices.md#get-apiv1voicesvoice_id) | 聲音詳情 |
| | POST | [`/api/v1/voices`](voices.md#post-apiv1voices) | 建立自訂聲音 |
| | PATCH | [`/api/v1/voices/{voice_id}`](voices.md#patch-apiv1voicesvoice_id) | 更新聲音資訊 |
| | DELETE | [`/api/v1/voices/{voice_id}`](voices.md#delete-apiv1voicesvoice_id) | 刪除自訂聲音 |
| **快取** | POST | [`/api/v1/cache/clear`](cache.md) | 清理快取與已完成任務 |

## OpenAPI 規範

完整的 OpenAPI 3.1 規範檔案：[`openapi.json`](openapi.json)

可匯入到 Swagger Editor、Postman、Insomnia 等工具中使用。開發模式下也可直接訪問 `http://localhost:8765/docs` 檢視 FastAPI 自動生成的 Swagger UI。

## 通用約定

- **Content-Type**: 所有 POST/PATCH 請求體使用 `application/json`
- **欄位命名**: camelCase（如 `modelKey`、`createdAt`）
- **錯誤響應**: HTTP 4xx/5xx，body 格式為 `{"detail": "錯誤描述"}`
- **非同步任務**: 生成、ASR、下載等耗時操作均為非同步，建立後返回 `TaskRecord`，透過輪詢 `GET /api/v1/tasks/{task_id}` 獲取進度和結果
