# Tasks — 任務管理

所有耗時操作（語音生成、ASR 轉錄、模型下載）均以非同步任務方式執行。建立後返回 `TaskRecord`，透過輪詢獲取進度和結果。

## TaskRecord 結構

```json
{
  "id": "uuid",
  "type": "generate | asr_transcribe | bootstrap",
  "status": "queued | running | succeeded | failed | cancelled",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "title": "任務標題",
  "progress": 0,
  "message": "狀態訊息",
  "downloadProgress": null,
  "bootstrapAssetProgress": [],
  "result": null,
  "error": null
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `type` | string | 任務類型 |
| `status` | string | 任務狀態 |
| `progress` | number \| null | 進度百分比 0-100 |
| `result` | TaskResult \| null | 成功時的結果資料 |
| `error` | AppError \| null | 失敗時的錯誤資訊 |

---

## POST `/api/v1/tasks/generate`

建立語音生成任務。

### 請求

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

### 參數說明

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `mode` | string | 是 | 生成模式，見下方說明 |
| `targetText` | string | 是 | 要合成的文字 |
| `modelKey` | string | 否 | 模型標識，預設 `"voxcpm2"` |
| `providerPreference` | string | 否 | 下載源偏好，預設 `"auto"` |
| `referenceAudioPath` | string | 否 | 參考音訊檔案路徑（複製模式必填） |
| `promptText` | string | 否 | 參考音訊對應的文字 |
| `controlInstruction` | string | 否 | 聲音設計指令（voice_design 模式） |
| `extremeClone` | boolean | 否 | 是否啟用極致複製模式 |
| `cfgValue` | number | 否 | CFG 引導強度 |
| `inferenceTimesteps` | number | 否 | 推理步數 |
| `normalize` | boolean | 否 | 是否啟用文字歸一化 |
| `denoise` | boolean | 否 | 是否啟用後處理降噪 |
| `streaming` | boolean | 否 | 是否流式生成 |
| `seed` | number | 否 | 隨機種子，`null` 或不傳為隨機 |

### 生成模式

| 模式 | 說明 |
|------|------|
| `quick_tts` | 快速語音合成 |
| `voice_design` | 透過文字指令設計聲音風格 |
| `controllable_clone` | 可控語音複製（使用參考音訊） |
| `ultimate_clone` | 極致複製（使用參考音訊 + 轉錄文字增強還原度） |

### 成功響應

任務完成後，`result` 包含生成結果：

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

建立語音識別（ASR）任務，轉錄指定音訊檔案。

### 請求

```json
{
  "audioPath": "/path/to/audio.wav",
  "modelKey": "sensevoice_small"
}
```

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `audioPath` | string | 是 | 待轉錄音訊檔案的本地路徑 |
| `modelKey` | string | 否 | ASR 模型標識，預設 `"sensevoice_small"` |

### 成功響應

```json
{
  "id": "task-uuid",
  "type": "asr_transcribe",
  "status": "succeeded",
  "result": {
    "transcript": "你好，世界。",
    "transcriptLanguage": "zh",
    "modelPath": "/path/to/sensevoice_small"
  }
}
```

### 錯誤場景

ASR 模型未就緒時會返回失敗任務，`error` 中包含錯誤詳情。

---

## GET `/api/v1/tasks`

獲取任務列表，按建立時間倒序排列。

### 請求

| 參數 | 位置 | 類型 | 預設值 | 說明 |
|------|------|------|--------|------|
| `limit` | query | number | `50` | 每頁數量 |
| `offset` | query | number | `0` | 偏移量 |
| `status` | query | string | — | 按狀態篩選：`queued` / `running` / `succeeded` / `failed` / `cancelled` |

### 響應

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

獲取單個任務的詳情。

### 請求

| 參數 | 位置 | 類型 | 說明 |
|------|------|------|------|
| `task_id` | path | string | 任務 ID |

### 響應

返回完整的 `TaskRecord`。

### 錯誤

| 狀態碼 | 說明 |
|--------|------|
| 404 | `{"detail": "task not found"}` |
