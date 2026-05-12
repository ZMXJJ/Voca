# Probe — 轻量探针

## GET `/api/v1/probe`

返回轻量级存活探针信息，用于桌面端初始化阶段确认 Python sidecar 已经启动并可响应 HTTP 请求。

### 请求

无参数。

### 响应

```json
{
  "service": "voca-python-service",
  "status": "ok",
  "instanceId": "a1b2c3d4"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `service` | string | 固定为 `voca-python-service` |
| `status` | string | 存活探针状态；成功时为 `ok` |
| `instanceId` | string | 当前 sidecar 实例 ID，可用于区分重启后的新实例 |
