# CUDA Upgrade — Windows CUDA 运行时

仅 Windows 桌面构建会暴露这一组接口。其他平台（macOS / Linux）的 sidecar 会以 HTTP 400 拒绝请求，且 Tauri 命令层会在到达 sidecar 之前直接拦截。

## POST `/api/v1/bootstrap/upgrade-cuda`

创建一个 CUDA 推理运行时下载与安装的异步任务。任务完成后，`runtime/site-packages/torch` 与 `runtime/site-packages/torchaudio` 会被原子替换为最新的 CUDA 轮子，并写入 `cuda-runtime-complete.json` 标记。

### 请求

无 body。请求体保留为空对象 `{}` 以兼容 FastAPI 默认解析行为。

### 响应

成功时返回新建的 `TaskRecord`，类型为 `cuda_upgrade`：

```json
{
  "id": "f0e1d2c3-...",
  "type": "cuda_upgrade",
  "status": "queued",
  "createdAt": "2026-04-20T08:11:32.000Z",
  "updatedAt": "2026-04-20T08:11:32.000Z",
  "title": "Prepare CUDA inference runtime",
  "progress": 0,
  "message": "Preparing CUDA inference runtime",
  "downloadProgress": {
    "phase": "listing",
    "downloadedBytes": 0,
    "totalBytes": null,
    "totalBytesComplete": false,
    "completedFiles": 0,
    "totalFiles": 2
  }
}
```

之后通过 `GET /api/v1/tasks/{task_id}` 轮询进度。任务的 `progress` 字段会按下列阶段递进：

| 阶段 | progress | downloadProgress.phase | 说明 |
|------|----------|------------------------|------|
| `download` | 0–85 | `downloading` | 下载 torch / torchaudio 轮子 |
| `verify` | 88 | — | SHA-256 校验已下载文件 |
| `install` | 94 | — | 解包到 `runtime/staging/` 并替换 site-packages |
| `validate` | 98 | — | 子进程 `import torch` 自检 |
| 完成 | 100 | — | 写入 `runtime.json` 与完成标记 |

### 错误响应

| HTTP | `detail.code` | 触发条件 |
|------|---------------|----------|
| 400 | `cuda_upgrade_unsupported_platform` | 调用方运行在非 Windows 平台 |
| 任务失败时 `task.error.code` | `cuda_upgrade_busy` | 已有一次升级在 `runtime/upgrade.lock` 上持有互斥锁 |
| 任务失败时 `task.error.code` | `cuda_upgrade_failed` | 下载、校验或安装阶段抛出 `CudaUpgradeError`（如网络中断、所有镜像源失败、SHA-256 不匹配等） |
| 任务失败时 `task.error.code` | `cuda_upgrade_unexpected` | 非预期异常（例如 zip 解压失败、磁盘满），错误细节见 `task.error.details` |

`detail` 在 HTTP 错误中的形态为：

```json
{
  "detail": {
    "code": "cuda_upgrade_unsupported_platform",
    "message": "cuda_upgrade is only supported on Windows builds"
  }
}
```

### Tauri 命令对应

桌面前端通过 `invoke("start_cuda_upgrade")` 触发本接口；该命令在非 Windows 平台直接返回 `cuda_upgrade_unsupported_platform`，不会调用 sidecar。
