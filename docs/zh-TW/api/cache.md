# Cache — 快取管理

## POST `/api/v1/cache/clear`

清理已完成任務關聯的音訊快取檔案，並移除對應的任務記錄。

### 請求

無參數，無請求體。

### 響應

```json
{
  "success": true,
  "clearedFiles": 12,
  "clearedBytes": 52428800,
  "remainingBytes": 1073741824,
  "removedTasks": 5,
  "removedTaskIds": [
    "task-uuid-1",
    "task-uuid-2",
    "task-uuid-3",
    "task-uuid-4",
    "task-uuid-5"
  ],
  "clearedAudioDirs": [
    "/path/to/audio/output/dir"
  ],
  "serviceInfo": {
    "service": "voca-python-service",
    "status": "ok",
    "modelLoaded": true,
    "...":" (完整的 HealthResponse 欄位)"
  }
}
```

### 欄位說明

| 欄位 | 類型 | 說明 |
|------|------|------|
| `success` | boolean | 操作是否成功 |
| `clearedFiles` | number | 刪除的快取檔案數 |
| `clearedBytes` | number | 釋放的磁碟空間（位元組） |
| `remainingBytes` | number | 剩餘快取佔用（位元組） |
| `removedTasks` | number | 移除的任務記錄數 |
| `removedTaskIds` | string[] | 被移除的任務 ID 列表 |
| `clearedAudioDirs` | string[] | 被清理的音訊輸出目錄 |
| `serviceInfo` | object | 操作後的服務健康狀態快照（同 `GET /api/v1/health` 的響應） |
