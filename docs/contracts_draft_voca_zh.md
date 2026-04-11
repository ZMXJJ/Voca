# Voca 契约草案（JSON Schema / TypeScript Types）

## 1. 文档定位

- 文档类型：工程契约草案
- 对应产品：`Voca`
- 关联文档：
  - [docs/tech_solution_voca_zh.md](docs/tech_solution_voca_zh.md)
  - [docs/api_event_protocol_voca_zh.md](docs/api_event_protocol_voca_zh.md)
- 适用范围：`P0 PoC` 到 `P1 MVP`

本文档的目标不是直接替代接口协议文档，而是进一步回答一个工程问题：

后续如果要把协议真正落成代码，`desktop/app`、`desktop/src-tauri` 和 `desktop/python-service` 应该如何共享同一套契约定义。

## 2. 契约落地目标

### 2.1 目标

1. 让前端、Tauri Core、Python Service 对同一份协议有一致理解。
2. 避免枚举值、事件名、错误码和字段名在三端各自维护。
3. 为后续生成 TypeScript 类型、Rust 结构体和 Python 校验模型预留基础。

### 2.2 非目标

1. 当前阶段不要求立刻生成代码。
2. 当前阶段不要求一次性覆盖所有未来能力。
3. 当前阶段不要求立刻引入复杂代码生成链，只先固定数据模型和目录布局。

## 3. 推荐的单一事实来源

### 3.1 推荐方案

推荐把 **JSON Schema** 作为跨层共享数据结构的主定义来源，再为前端补充一层 `TypeScript` 类型导出。

原因：

- 前端天然适合消费 `JSON Schema` 对应的 JSON 载荷
- Python 和 Rust 后续都可以围绕 JSON Schema 做校验或代码生成
- 相比只维护 TypeScript，JSON Schema 更适合作为跨语言契约的“中立层”

### 3.2 双层策略

建议采用两层定义：

1. **Schema 层**
   - 用于定义结构、枚举、必填字段、默认值、格式约束
2. **Types 层**
   - 用于前端开发体验
   - 提供更清晰的类型别名、联合类型和事件封装

### 3.3 Python HTTP 的来源

对于 `Python Service` 的 HTTP API，推荐使用：

- `OpenAPI` 描述 HTTP 路径和请求/响应
- 其中请求体和响应体复用同一批 `JSON Schema` 中的共享对象

也就是说：

- **共享领域对象**：`JSON Schema`
- **前端开发类型**：`TypeScript`
- **Python HTTP 接口说明**：`OpenAPI`

## 4. 推荐目录结构

建议未来在仓库中形成如下结构：

```text
desktop/
  packages/
    contracts/
      schemas/
        common/
          app-error.schema.json
          response-envelope.schema.json
          task-record.schema.json
        bootstrap/
          bootstrap-state.schema.json
          device-capabilities.schema.json
        download/
          provider-selection.schema.json
          model-manifest.schema.json
          download-job.schema.json
        generation/
          generation-params.schema.json
          generation-result.schema.json
        events/
          app-event.schema.json
          bootstrap-progress-event.schema.json
          download-progress-event.schema.json
          task-updated-event.schema.json
      openapi/
        python-service.openapi.yaml
      src/
        index.ts
        enums.ts
        commands.ts
        events.ts
        api.ts
        generated/
```

说明：

- `schemas/` 负责定义共享对象
- `openapi/` 负责定义 Python sidecar HTTP API
- `src/` 负责给前端导出更好用的 TypeScript 类型和常量

## 5. 契约分层建议

### 5.1 领域对象层

这层定义“系统里有什么对象”，例如：

- `AppError`
- `TaskRecord`
- `DownloadJob`
- `ModelManifest`
- `GenerationParams`
- `BootstrapState`

### 5.2 协议消息层

这层定义“对象如何在协议中传输”，例如：

- `ResponseEnvelope`
- `AppEvent`
- `CommandRequest`
- `CommandResult`

### 5.3 接口层

这层定义“谁可以调用什么”，例如：

- Tauri commands
- Python HTTP API
- Python SSE events

## 6. 推荐的 TypeScript 入口设计

未来前端建议只从一个入口引用契约：

```ts
import {
  AppError,
  TaskRecord,
  BootstrapState,
  GenerationParams,
  ModelManifest,
  DownloadJob,
  TauriCommandMap,
  AppEventMap,
} from "@voca/contracts";
```

### 6.1 推荐导出结构

```ts
export * from "./enums";
export * from "./commands";
export * from "./events";
export * from "./api";
export * from "./generated/common";
export * from "./generated/bootstrap";
export * from "./generated/download";
export * from "./generated/generation";
```

## 7. 核心对象草案

本节不是重复接口文档，而是明确“哪些对象值得单独抽成 schema 文件”。

### 7.1 `AppError`

建议拆成独立 schema：

- 文件：`schemas/common/app-error.schema.json`

建议字段：

```json
{
  "$id": "AppError",
  "type": "object",
  "required": ["code", "userMessageKey", "severity", "recoverable", "actions"],
  "properties": {
    "code": { "type": "string" },
    "message": { "type": "string" },
    "userMessageKey": { "type": "string" },
    "severity": {
      "type": "string",
      "enum": ["info", "warning", "error", "blocking"]
    },
    "recoverable": { "type": "boolean" },
    "actions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "retry",
          "resume",
          "switch_download_source",
          "open_settings",
          "reinitialize",
          "export_logs",
          "check_disk",
          "contact_support"
        ]
      }
    },
    "details": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "additionalProperties": false
}
```

### 7.2 `TaskRecord`

建议拆成独立 schema：

- 文件：`schemas/common/task-record.schema.json`

建议用途：

- Tauri 侧任务存储
- 前端任务展示
- Python 任务状态查询响应

建议字段：

- `id`
- `type`
- `status`
- `createdAt`
- `updatedAt`
- `progress`
- `message`
- `error`
- `result`

### 7.3 `BootstrapState`

建议拆成独立 schema：

- 文件：`schemas/bootstrap/bootstrap-state.schema.json`

用途：

- App 启动时恢复初始化状态
- 初始化向导渲染

建议枚举：

- `phase`
  - `welcome`
  - `env_check`
  - `runtime_download`
  - `model_download`
  - `asset_verify`
  - `warmup`
  - `ready`
  - `failed`

### 7.4 `DeviceCapabilities`

建议拆成独立 schema：

- 文件：`schemas/bootstrap/device-capabilities.schema.json`

用途：

- 首次启动设备检查
- 前端展示支持与否的原因

### 7.5 `ProviderSelection`

建议拆成独立 schema：

- 文件：`schemas/download/provider-selection.schema.json`

用途：

- 前端设置页展示下载源状态
- Tauri Core 记录自动推荐和用户覆盖

建议字段：

- `preferred`
- `recommended`
- `current`
- `reason`
- `userOverridden`

### 7.6 `ModelManifest`

建议拆成独立 schema：

- 文件：`schemas/download/model-manifest.schema.json`

这是模型下载体系的关键对象，建议一开始就固定下来。

最少字段：

- `modelKey`
- `version`
- `displayName`
- `defaultProvider`
- `recommendedRegions`
- `providers`
- `files`

### 7.7 `DownloadJob`

建议拆成独立 schema：

- 文件：`schemas/download/download-job.schema.json`

用途：

- Tauri 侧下载任务持久化
- 前端下载页实时展示

### 7.8 `GenerationParams`

建议拆成独立 schema：

- 文件：`schemas/generation/generation-params.schema.json`

该对象应尽量保持和现有 `VoxCPM` Python 形参语义一致，避免前后端再发明一层不必要的映射。

建议字段：

- `mode`
- `targetText`
- `controlInstruction`
- `referenceAudioPath`
- `promptText`
- `cfgValue`
- `inferenceTimesteps`
- `normalize`
- `denoise`
- `streaming`
- `minLen`
- `maxLen`

### 7.9 `GenerationResult`

建议拆成独立 schema：

- 文件：`schemas/generation/generation-result.schema.json`

建议字段：

- `audioPath`
- `sampleRate`
- `durationMs`
- `waveformPreview`

## 8. Tauri Command 契约草案

建议把 `Renderer -> Tauri Core` 的 command 做成统一映射。

### 8.1 TypeScript 映射草案

```ts
export interface TauriCommandMap {
  get_bootstrap_state: {
    request: undefined;
    response: BootstrapState;
  };
  get_device_capabilities: {
    request: undefined;
    response: DeviceCapabilities;
  };
  start_bootstrap: {
    request: {
      modelKey: string;
      providerPreference: "auto" | "huggingface" | "modelscope";
      autoStartSidecar: boolean;
    };
    response: {
      taskId: string;
      phase: string;
      status: string;
    };
  };
  create_generate_task: {
    request: GenerationParams;
    response: {
      taskId: string;
      status: "queued" | "running";
    };
  };
  create_clone_task: {
    request: GenerationParams;
    response: {
      taskId: string;
      status: "queued" | "running";
    };
  };
  get_task: {
    request: {
      taskId: string;
    };
    response: TaskRecord;
  };
}
```

### 8.2 工程建议

后续在前端可封装成：

```ts
async function invokeCommand<K extends keyof TauriCommandMap>(
  name: K,
  payload: TauriCommandMap[K]["request"]
): Promise<TauriCommandMap[K]["response"]> {
  // 这里后续再接 Tauri invoke
  throw new Error("not implemented");
}
```

这样前端调用可以做到：

- 命令名可枚举
- 请求和响应类型自动推导
- 不容易写错 payload

## 9. Event 契约草案

### 9.1 推荐事件定义方式

建议不要只用一个宽泛的 `type: string`，而是额外保留事件映射表。

### 9.2 TypeScript 事件映射

```ts
export interface AppEventMap {
  "bootstrap.progress": {
    phase: string;
    status: string;
    message?: string;
    progress?: number;
  };
  "bootstrap.failed": {
    phase: string;
    error: AppError;
  };
  "bootstrap.ready": {
    runtimeReady: boolean;
    modelReady: boolean;
    sidecarReady: boolean;
  };
  "download.progress": DownloadJob;
  "download.completed": DownloadJob;
  "download.failed": DownloadJob & {
    suggestedProvider?: "huggingface" | "modelscope";
  };
  "task.updated": TaskRecord;
  "task.succeeded": TaskRecord;
  "task.failed": TaskRecord;
  "sidecar.state_changed": {
    running: boolean;
    healthy: boolean;
    reason?: string;
  };
  "settings.changed": {
    downloadProviderPreference: "auto" | "huggingface" | "modelscope";
    experimentalEnabled: boolean;
  };
}
```

### 9.3 前端事件订阅建议

前端后续建议封装：

```ts
function subscribeEvent<K extends keyof AppEventMap>(
  eventName: K,
  handler: (payload: AppEventMap[K]) => void
) {
  // 后续接 Tauri event listen
}
```

这样能显著减少前端事件使用时的字符串错误和 payload 结构误判。

## 10. Python Service OpenAPI 草案

### 10.1 OpenAPI 文件建议

- 文件：`desktop/packages/contracts/openapi/python-service.openapi.yaml`

建议包含：

- `/api/v1/health`
- `/api/v1/bootstrap/validate`
- `/api/v1/models/validate`
- `/api/v1/models/load`
- `/api/v1/tasks/generate`
- `/api/v1/tasks/clone`
- `/api/v1/tasks/asr_transcribe`
- `/api/v1/tasks/{taskId}`
- `/api/v1/tasks/{taskId}/cancel`
- `/api/v1/events`

### 10.2 共享对象复用原则

在 OpenAPI 中应尽可能复用同一批对象定义：

- `AppError`
- `TaskRecord`
- `GenerationParams`
- `GenerationResult`

避免出现：

- API 文档里一套字段名
- 前端类型里另一套字段名
- Python 内部模型又是第三套字段名

## 11. 版本管理建议

### 11.1 版本字段

建议在契约包中引入：

```ts
export const CONTRACT_VERSION = "0.1.0";
```

并在：

- Tauri Core 启动时打印
- Python Service `/health` 响应中返回
- 前端错误上报或日志导出中附带

### 11.2 兼容性原则

1. 新增字段优先使用可选字段。
2. 已发布事件名不随意改名。
3. 已发布枚举值不随意变更语义。
4. 删除字段时必须先经过废弃期。

## 12. P0 阶段最小实现建议

当前不需要一口气把所有 schema 都生成出来，建议按 PoC 先做最小集合：

### 12.1 第一批必须落地的对象

- `AppError`
- `TaskRecord`
- `BootstrapState`
- `DeviceCapabilities`
- `GenerationParams`
- `GenerationResult`
- `DownloadJob`

### 12.2 第一批必须落地的事件

- `bootstrap.progress`
- `bootstrap.failed`
- `bootstrap.ready`
- `task.updated`
- `task.succeeded`
- `task.failed`

### 12.3 第一批必须落地的 command

- `get_bootstrap_state`
- `get_device_capabilities`
- `start_bootstrap`
- `create_generate_task`
- `get_task`

## 13. 当前结论

`Voca` 后续如果要真正进入三端并行开发，最推荐的做法是：

1. 用 `JSON Schema` 作为共享对象的主定义
2. 用 `TypeScript` 暴露更易用的前端类型入口
3. 用 `OpenAPI` 描述 Python sidecar 的 HTTP API
4. 先在 `P0` 只落最小集合，不追求一次性做全

这样既能保证契约一致性，也不会在项目初期引入过重的工程成本。
