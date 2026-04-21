# Tasks — 任务管理

所有耗时操作（语音生成、ASR 转录、模型下载）均以异步任务方式执行。创建后返回 `TaskRecord`，通过轮询获取进度和结果。

## TaskRecord 结构

```json
{
  "id": "uuid",
  "type": "generate | asr_transcribe | bootstrap",
  "status": "queued | running | succeeded | failed | cancelled",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "title": "任务标题",
  "progress": 0,
  "message": "状态消息",
  "downloadProgress": null,
  "bootstrapAssetProgress": [],
  "result": null,
  "error": null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 任务类型 |
| `status` | string | 任务状态 |
| `progress` | number \| null | 进度百分比 0-100 |
| `result` | TaskResult \| null | 成功时的结果数据 |
| `error` | AppError \| null | 失败时的错误信息 |

---

## POST `/api/v1/tasks/generate`

创建语音生成任务。

### 请求

```json
{
  "mode": "controllable_clone",
  "targetText": "你好，世界。",
  "modelKey": "voxcpm2",
  "providerPreference": "auto",
  "referenceAudioPath": "/path/to/reference.wav",
  "promptText": "你好，世界。",
  "extremeClone": false,
  "cfgValue": 0.5,
  "inferenceTimesteps": 32,
  "normalize": true,
  "denoise": false,
  "seed": 42
}
```

### 参数说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | 是 | 生成模式，见下方说明 |
| `targetText` | string | 是 | 要合成的文本 |
| `modelKey` | string | 否 | 模型标识，默认 `"voxcpm2"` |
| `providerPreference` | string | 否 | 下载源偏好，默认 `"auto"` |
| `referenceAudioPath` | string | 否 | 参考音频文件路径（克隆模式必填） |
| `promptText` | string | 否 | 参考音频对应的文本 |
| `controlInstruction` | string | 否 | 声音设计指令（voice_design 模式） |
| `extremeClone` | boolean | 否 | 是否启用极致克隆模式 |
| `cfgValue` | number | 否 | CFG 引导强度 |
| `inferenceTimesteps` | number | 否 | 推理步数 |
| `normalize` | boolean | 否 | 是否启用文本归一化 |
| `denoise` | boolean | 否 | 是否启用后处理降噪 |
| `streaming` | boolean | 否 | 是否流式生成 |
| `seed` | number | 否 | 随机种子，`null` 或不传为随机 |

### 生成模式

| 模式 | 说明 |
|------|------|
| `quick_tts` | 快速语音合成 |
| `voice_design` | 通过文本指令设计声音风格 |
| `controllable_clone` | 可控语音克隆（使用参考音频） |
| `ultimate_clone` | 极致克隆（使用参考音频 + 转录文本增强还原度） |

### 成功响应

任务完成后，`result` 包含生成结果：

```json
{
  "id": "task-uuid",
  "type": "generate",
  "status": "succeeded",
  "result": {
    "outputPath": "/path/to/output.wav",
    "sampleRate": 24000,
    "duration": 3.5,
    "modelPath": "/path/to/voxcpm2",
    "provider": "huggingface"
  }
}
```

---

## POST `/api/v1/tasks/asr`

创建语音识别（ASR）任务，转录指定音频文件。

### 请求

```json
{
  "audioPath": "/path/to/audio.wav",
  "modelKey": "sensevoice_small"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `audioPath` | string | 是 | 待转录音频文件的本地路径 |
| `modelKey` | string | 否 | ASR 在模型目录中的标识，默认 `"sensevoice_small"`（与 ONNX 资源对应；本地安装目录名为 `sensevoice_small_onnx`，见 `model_catalog.json` 的 `localDirName`） |

### 成功响应

```json
{
  "id": "task-uuid",
  "type": "asr_transcribe",
  "status": "succeeded",
  "result": {
    "transcript": "你好，世界。",
    "transcriptLanguage": "zh",
    "modelPath": "/path/to/sensevoice_small_onnx"
  }
}
```

### 错误场景

ASR 模型未就绪时会返回失败任务，`error` 中包含错误详情。

---

## GET `/api/v1/tasks`

获取任务列表，按创建时间倒序排列。

### 请求

| 参数 | 位置 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `limit` | query | number | `50` | 每页数量 |
| `offset` | query | number | `0` | 偏移量 |
| `status` | query | string | — | 按状态筛选：`queued` / `running` / `succeeded` / `failed` / `cancelled` |

### 响应

```json
[
  {
    "id": "task-uuid-1",
    "type": "generate",
    "status": "succeeded",
    "createdAt": "2025-01-01T00:00:10Z",
    "updatedAt": "2025-01-01T00:00:15Z",
    "progress": 100,
    "result": { "..." : "..." }
  },
  {
    "id": "task-uuid-2",
    "type": "asr_transcribe",
    "status": "running",
    "createdAt": "2025-01-01T00:00:05Z",
    "updatedAt": "2025-01-01T00:00:06Z",
    "progress": 60
  }
]
```

---

## GET `/api/v1/tasks/{task_id}`

获取单个任务的详情。

### 请求

| 参数 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `task_id` | path | string | 任务 ID |

### 响应

返回完整的 `TaskRecord`。

### 错误

| 状态码 | 说明 |
|--------|------|
| 404 | `{"detail": "task not found"}` |
