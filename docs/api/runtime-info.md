# Runtime Info — CUDA 运行时状态

## GET `/api/v1/bootstrap/runtime-info`

读取 `<app_support>/runtime/runtime.json` 中记录的 CUDA 运行时元信息。无论平台如何，本接口都可调用；当 `runtime.json` 不存在或字段缺失时各字段返回 `null`。

### 请求

无参数。

### 响应

```json
{
  "active": "cuda",
  "lastKnownGoodBackend": "cuda",
  "lastUpgradeAt": "2026-04-20T08:14:51.000Z",
  "lastUpgradeError": null
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `active` | `"cpu" \| "cuda" \| "mps" \| string \| null` | 当前激活的 torch 后端。Windows 上由 `cuda_upgrade` 流程写入；macOS/Linux 在没有 `runtime.json` 时为 `null`。 |
| `lastKnownGoodBackend` | 同上 | 上一次成功完成自检的后端，用于判断是否需要回滚。 |
| `lastUpgradeAt` | ISO 8601 字符串 \| `null` | 上次升级流程的时间戳。 |
| `lastUpgradeError` | string \| `null` | 上次升级失败的错误描述。成功时为 `null`。 |

### 与前端契约的对应

字段映射到 [`@voca/contracts`](../../desktop/packages/contracts/src/index.ts) 中的 `CudaUpgradeRuntimeInfo`，前端可直接消费。

### Tauri 命令对应

桌面前端通过 `invoke("get_runtime_info")` 调用本接口。该命令对所有平台开放，仅在 sidecar 未启动时返回 `python_sidecar_not_ready`。
