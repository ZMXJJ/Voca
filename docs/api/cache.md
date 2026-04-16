# Cache — 缓存管理

## POST `/api/v1/cache/clear`

清理已完成任务关联的音频缓存文件，并移除对应的任务记录。

### 请求

无参数，无请求体。

### 响应

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
    "...":" (完整的 HealthResponse 字段)"
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 操作是否成功 |
| `clearedFiles` | number | 删除的缓存文件数 |
| `clearedBytes` | number | 释放的磁盘空间（字节） |
| `remainingBytes` | number | 剩余缓存占用（字节） |
| `removedTasks` | number | 移除的任务记录数 |
| `removedTaskIds` | string[] | 被移除的任务 ID 列表 |
| `clearedAudioDirs` | string[] | 被清理的音频输出目录 |
| `serviceInfo` | object | 操作后的服务健康状态快照（同 `GET /api/v1/health` 的响应） |
