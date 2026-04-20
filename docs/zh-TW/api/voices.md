# Voices — 聲音庫

管理預設聲音和使用者自訂聲音。內建聲音不可修改或刪除。

## VoiceEntry 結構

```json
{
  "id": "voice-uuid",
  "name": "示例聲音",
  "language": "zh",
  "description": "一個溫柔的女聲",
  "isBuiltin": false,
  "referenceAudioPath": "/path/to/reference.wav",
  "referenceTranscript": "這是參考音訊的轉錄文字。",
  "transcriptLanguage": "zh",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-01T00:00:00Z"
}
```

---

## GET `/api/v1/voices`

獲取所有聲音列表。內建聲音排在前面，使用者聲音按建立時間倒序排列。

### 請求

無參數。

### 響應

```json
[
  {
    "id": "builtin-1",
    "name": "預設聲音 A",
    "language": "zh",
    "isBuiltin": true,
    "referenceAudioPath": "/path/to/builtin-a.wav",
    "referenceTranscript": "...",
    "transcriptLanguage": "zh"
  },
  {
    "id": "user-uuid",
    "name": "我的聲音",
    "language": "zh",
    "isBuiltin": false,
    "referenceAudioPath": "/path/to/my-voice.wav",
    "referenceTranscript": "你好，這是測試。",
    "transcriptLanguage": "zh"
  }
]
```

---

## GET `/api/v1/voices/{voice_id}`

獲取單個聲音的詳情。

### 請求

| 參數 | 位置 | 類型 | 說明 |
|------|------|------|------|
| `voice_id` | path | string | 聲音 ID |

### 響應

返回完整的 `VoiceEntry`。

### 錯誤

| 狀態碼 | 說明 |
|--------|------|
| 404 | `{"detail": "voice not found"}` |

---

## POST `/api/v1/voices`

建立自訂聲音。如果提供了 `referenceAudioPath`，服務會將參考音訊複製到聲音庫目錄中。

### 請求

```json
{
  "name": "我的聲音",
  "language": "zh",
  "description": "錄製於安靜環境的參考音訊",
  "referenceAudioPath": "/path/to/original/audio.wav",
  "referenceTranscript": "你好，這是一段測試文字。",
  "transcriptLanguage": "zh"
}
```

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `name` | string | 是 | 聲音名稱 |
| `language` | string | 否 | 語言程式碼，預設 `"zh"` |
| `description` | string | 否 | 聲音描述 |
| `referenceAudioPath` | string | 否 | 參考音訊的本地路徑，服務會複製到聲音庫 |
| `referenceTranscript` | string | 否 | 參考音訊的轉錄文字 |
| `transcriptLanguage` | string | 否 | 轉錄文字的語言 |

### 響應

**201 Created** — 返回建立的 `VoiceEntry`。

### 錯誤

| 狀態碼 | 說明 |
|--------|------|
| 400 | 參考音訊檔案不存在 |

---

## PATCH `/api/v1/voices/{voice_id}`

更新自訂聲音的元資訊。僅可更新使用者建立的聲音，內建聲音不可修改。不支援透過此介面更換參考音訊檔案。

### 請求

所有欄位均為可選，只傳需要更新的欄位：

```json
{
  "name": "新名稱",
  "referenceTranscript": "修正後的轉錄文字"
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `name` | string | 聲音名稱 |
| `language` | string | 語言程式碼 |
| `description` | string | 聲音描述 |
| `referenceTranscript` | string | 參考音訊的轉錄文字 |
| `transcriptLanguage` | string | 轉錄文字的語言 |

### 響應

返回更新後的 `VoiceEntry`。

### 錯誤

| 狀態碼 | 說明 |
|--------|------|
| 403 | 內建聲音不可修改 |
| 404 | 聲音不存在 |

---

## DELETE `/api/v1/voices/{voice_id}`

刪除自訂聲音及其儲存的參考音訊檔案。內建聲音不可刪除。

### 請求

| 參數 | 位置 | 類型 | 說明 |
|------|------|------|------|
| `voice_id` | path | string | 聲音 ID |

### 響應

**204 No Content** — 無返回內容。

### 錯誤

| 狀態碼 | 說明 |
|--------|------|
| 403 | 內建聲音不可刪除 |
| 404 | 聲音不存在 |
