# Models — 模型管理

## GET `/api/v1/models/catalog`

获取内置模型目录列表，包含每个模型的基本信息、下载源和本地状态。

### 请求

无参数。

### 响应

```json
[
  {
    "key": "voxcpm2",
    "displayName": "VoxCPM2",
    "role": "tts",
    "architecture": "voxcpm2",
    "isBootstrapEntry": true,
    "providers": {
      "huggingface": {
        "repoId": "DennisHuang648/VoxCPM2-GGUF",
        "allowPatterns": ["*BaseLM*Q8_0*.gguf", "*Acoustic*.gguf"]
      },
      "modelscope": {
        "modelId": "DennisHuang/VoxCPM2-GGUF",
        "allowPatterns": ["*BaseLM*Q8_0*.gguf", "*Acoustic*.gguf"]
      }
    },
    "localDir": "/path/to/voxcpm2_gguf",
    "configExists": true
  }
]
```

> TTS 模型均为 **GGUF** 格式（由 C++ `llama-tts-server` 加载），本地就绪判定为同时存在 BaseLM 与 Acoustic 两个 `.gguf` 文件（并非 `config.json`）。`allowPatterns` 让下载只拉取 Q8 BaseLM + Acoustic 两个文件。降噪模型（DPDFNet ONNX）随 app 内置，不在目录中。

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | 模型唯一标识 |
| `role` | string | 模型角色：`"tts"` / `"asr"` |
| `isBootstrapEntry` | boolean | 是否为首次启动引导必需模型 |
| `providers` | object | 各下载源的仓库信息（含可选 `allowPatterns` / `ignorePatterns`） |
| `configExists` | boolean | 本地资源是否就绪（GGUF：BaseLM + Acoustic `.gguf` 齐全；ASR：ONNX 权重齐全） |

---

## GET `/api/v1/providers/recommendation`

根据网络环境推荐最优模型下载源。

### 请求

| 参数 | 位置 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `preferred` | query | string | `"auto"` | `"auto"` / `"huggingface"` / `"modelscope"` |

### 响应

```json
{
  "recommended": "huggingface",
  "reason": "auto-detected",
  "available": ["huggingface", "modelscope"]
}
```

---

## POST `/api/v1/models/prepare`

解析模型路径，检查模型是否就绪。可选择同步下载。

### 请求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto",
  "ensureDownloaded": false
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `modelKey` | string | `"voxcpm2"` | 模型标识 |
| `providerPreference` | string | `"auto"` | 下载源偏好 |
| `ensureDownloaded` | boolean | `false` | 为 `true` 时会同步触发下载 |

### 响应

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

校验指定路径是否为有效模型目录（检查目录存在且包含 `config.json`）。

### 请求

```json
{
  "modelPath": "/path/to/model"
}
```

### 响应

校验通过：

```json
{
  "valid": true,
  "architecture": "voxcpm2",
  "modelKey": "voxcpm2",
  "version": "unknown"
}
```

校验失败：

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

创建一个异步任务下载指定模型。返回 `TaskRecord`，通过轮询 `GET /api/v1/tasks/{task_id}` 跟踪进度。

### 请求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto"
}
```

### 响应

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

任务进行中时，`downloadProgress` 会包含下载进度：

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

启动首次引导的批量下载任务，下载所有标记为 `isBootstrapEntry` 的模型（TTS + ASR）。降噪模型（DPDFNet ONNX）随 app 内置，不在此下载。

### 请求

```json
{
  "modelKey": "voxcpm2",
  "providerPreference": "auto"
}
```

### 响应

返回 `TaskRecord`（`type: "bootstrap"`），包含各资源的独立下载进度。

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
      "downloadedBytes": 120000000,
      "totalBytes": 234000000
    }
  ]
}
```
