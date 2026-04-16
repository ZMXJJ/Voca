# Voices — 声音库

管理预设声音和用户自定义声音。内置声音不可修改或删除。

## VoiceEntry 结构

```json
{
  "id": "voice-uuid",
  "name": "示例声音",
  "language": "zh",
  "description": "一个温柔的女声",
  "isBuiltin": false,
  "referenceAudioPath": "/path/to/reference.wav",
  "referenceTranscript": "这是参考音频的转录文本。",
  "transcriptLanguage": "zh",
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-01T00:00:00Z"
}
```

---

## GET `/api/v1/voices`

获取所有声音列表。内置声音排在前面，用户声音按创建时间倒序排列。

### 请求

无参数。

### 响应

```json
[
  {
    "id": "builtin-1",
    "name": "预设声音 A",
    "language": "zh",
    "isBuiltin": true,
    "referenceAudioPath": "/path/to/builtin-a.wav",
    "referenceTranscript": "...",
    "transcriptLanguage": "zh"
  },
  {
    "id": "user-uuid",
    "name": "我的声音",
    "language": "zh",
    "isBuiltin": false,
    "referenceAudioPath": "/path/to/my-voice.wav",
    "referenceTranscript": "你好，这是测试。",
    "transcriptLanguage": "zh"
  }
]
```

---

## GET `/api/v1/voices/{voice_id}`

获取单个声音的详情。

### 请求

| 参数 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `voice_id` | path | string | 声音 ID |

### 响应

返回完整的 `VoiceEntry`。

### 错误

| 状态码 | 说明 |
|--------|------|
| 404 | `{"detail": "voice not found"}` |

---

## POST `/api/v1/voices`

创建自定义声音。如果提供了 `referenceAudioPath`，服务会将参考音频复制到声音库目录中。

### 请求

```json
{
  "name": "我的声音",
  "language": "zh",
  "description": "录制于安静环境的参考音频",
  "referenceAudioPath": "/path/to/original/audio.wav",
  "referenceTranscript": "你好，这是一段测试文本。",
  "transcriptLanguage": "zh"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 声音名称 |
| `language` | string | 否 | 语言代码，默认 `"zh"` |
| `description` | string | 否 | 声音描述 |
| `referenceAudioPath` | string | 否 | 参考音频的本地路径，服务会复制到声音库 |
| `referenceTranscript` | string | 否 | 参考音频的转录文本 |
| `transcriptLanguage` | string | 否 | 转录文本的语言 |

### 响应

**201 Created** — 返回创建的 `VoiceEntry`。

### 错误

| 状态码 | 说明 |
|--------|------|
| 400 | 参考音频文件不存在 |

---

## PATCH `/api/v1/voices/{voice_id}`

更新自定义声音的元信息。仅可更新用户创建的声音，内置声音不可修改。不支持通过此接口更换参考音频文件。

### 请求

所有字段均为可选，只传需要更新的字段：

```json
{
  "name": "新名称",
  "referenceTranscript": "修正后的转录文本"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 声音名称 |
| `language` | string | 语言代码 |
| `description` | string | 声音描述 |
| `referenceTranscript` | string | 参考音频的转录文本 |
| `transcriptLanguage` | string | 转录文本的语言 |

### 响应

返回更新后的 `VoiceEntry`。

### 错误

| 状态码 | 说明 |
|--------|------|
| 403 | 内置声音不可修改 |
| 404 | 声音不存在 |

---

## DELETE `/api/v1/voices/{voice_id}`

删除自定义声音及其存储的参考音频文件。内置声音不可删除。

### 请求

| 参数 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `voice_id` | path | string | 声音 ID |

### 响应

**204 No Content** — 无返回内容。

### 错误

| 状态码 | 说明 |
|--------|------|
| 403 | 内置声音不可删除 |
| 404 | 声音不存在 |
