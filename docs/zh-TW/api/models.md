# Models — 模型管理

## GET `/api/v1/models/catalog`

獲取內建模型目錄列表，包含每個模型的基本資訊、下載源和本地狀態。

### 請求

無參數。

### 響應

```json
[
  {
    "key": "voxcpm2",
    "displayName": "VoxCPM 2",
    "role": "tts",
    "architecture": "voxcpm2",
    "isBootstrapEntry": true,
    "providers": {
      "huggingface": {
        "repoId": "openbmb/VoxCPM2"
      },
      "modelscope": {
        "modelId": "openbmb/VoxCPM2"
      }
    },
    "localDir": "/path/to/voxcpm2",
    "configExists": true
  }
]
```

### 欄位說明

| 欄位 | 類型 | 說明 |
|------|------|------|
| `key` | string | 模型唯一標識 |
| `role` | string | 模型角色：`"tts"` / `"asr"` / `"enhancer"` |
| `isBootstrapEntry` | boolean | 是否為首次啟動引導必需模型 |
| `providers` | object | 各下載源的倉庫資訊 |
| `configExists` | boolean | 本地 `config.json` 是否存在（即模型是否已下載） |

---

## GET `/api/v1/providers/recommendation`

根據網路環境推薦最佳模型下載源。

### 請求

| 參數 | 位置 | 類型 | 預設值 | 說明 |
|------|------|------|--------|------|
| `preferred` | query | string | `"auto"` | `"auto"` / `"huggingface"` / `"modelscope"` |

### 響應

```json
{
  "recommended": "huggingface",
  "reason": "auto-detected",
  "available": ["huggingface", "modelscope"]
}
```

---

## POST `/api/v1/models/prepare`

解析模型路徑，檢查模型是否就緒。可選擇同步下載。

### 請求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto",
  "ensureDownloaded": false
}
```

| 欄位 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `modelKey` | string | `"voxcpm2"` | 模型標識 |
| `providerPreference` | string | `"auto"` | 下載源偏好 |
| `ensureDownloaded` | boolean | `false` | 為 `true` 時會同步觸發下載 |

### 響應

```json
{
  "modelPath": "/path/to/voxcpm2",
  "configExists": true,
  "recommendation": {
    "recommended": "huggingface",
    "reason": "auto-detected",
    "available": ["huggingface", "modelscope"]
  }
}
```

---

## POST `/api/v1/models/validate`

驗證指定路徑是否為有效模型目錄（檢查目錄存在且包含 `config.json`）。

### 請求

```json
{
  "modelPath": "/path/to/model"
}
```

### 響應

驗證透過：

```json
{
  "valid": true,
  "architecture": "voxcpm2",
  "modelKey": "voxcpm2",
  "version": "unknown"
}
```

驗證失敗：

```json
{
  "valid": false,
  "architecture": null,
  "modelKey": null,
  "version": null
}
```

---

## POST `/api/v1/models/download`

建立一個非同步任務下載指定模型。返回 `TaskRecord`，透過輪詢 `GET /api/v1/tasks/{task_id}` 跟蹤進度。

### 請求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto"
}
```

### 響應

返回 `TaskRecord`（`type: "bootstrap"`，初始 `status: "queued"`）。

```json
{
  "id": "task-uuid",
  "type": "bootstrap",
  "status": "queued",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-01T00:00:00Z",
  "title": "Download voxcpm2",
  "progress": null,
  "downloadProgress": null,
  "result": null,
  "error": null
}
```

任務進行中時，`downloadProgress` 會包含下載進度：

```json
{
  "downloadProgress": {
    "downloadedBytes": 524288000,
    "totalBytes": 1073741824,
    "speed": 10485760,
    "eta": 52
  }
}
```

---

## POST `/api/v1/bootstrap/start`

啟動首次引導的批次下載任務，下載所有標記為 `isBootstrapEntry` 的模型（TTS、ASR、音訊增強等）。

### 請求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto"
}
```

### 響應

返回 `TaskRecord`（`type: "bootstrap"`），包含各資源的獨立下載進度。

```json
{
  "id": "task-uuid",
  "type": "bootstrap",
  "status": "running",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-01T00:00:05Z",
  "progress": 33,
  "bootstrapAssetProgress": [
    {
      "key": "voxcpm2",
      "role": "tts",
      "status": "succeeded",
      "downloadedBytes": 1073741824,
      "totalBytes": 1073741824
    },
    {
      "key": "sensevoice_small",
      "role": "asr",
      "status": "running",
      "downloadedBytes": 200000000,
      "totalBytes": 936000000
    }
  ]
}
```
