# Health — 健康检查

## GET `/api/v1/health`

返回服务的运行状态、设备信息、模型加载状态、存储目录及空间占用等诊断信息。

### 请求

无参数。

### 响应

```json
{
  "service": "voca-python-service",
  "status": "ok",
  "version": "0.1.0",
  "instanceId": "a1b2c3d4",
  "startedAt": "2025-01-01T00:00:00Z",
  "modelLoaded": true,
  "asrLoaded": false,
  "coreModelReady": true,
  "asrModelReady": true,
  "zipEnhancerReady": true,
  "speechToolsReady": true,
  "bootstrapAssetsReady": true,
  "deviceName": "Apple M1",
  "deviceType": "mps",
  "audioOutputDir": "/path/to/audio",
  "cacheBytes": 0,
  "logLevel": "INFO",
  "logDir": "/path/to/logs",
  "logBytes": 1024,
  "storageDir": "/path/to/storage",
  "modelDir": "/path/to/models",
  "modelBytes": 1073741824,
  "voicesDir": "/path/to/voices",
  "voiceLibraryBytes": 2048,
  "huggingfaceCacheDir": "/path/to/hf-cache",
  "huggingfaceCacheBytes": 0,
  "modelscopeCacheDir": "/path/to/ms-cache",
  "modelscopeCacheBytes": 0,
  "torchCacheDir": "/path/to/torch-cache",
  "torchCacheBytes": 0,
  "downloadCacheBytes": 0,
  "managedStorageBytes": 1073741824,
  "bootstrapAssets": [
    {
      "key": "voxcpm2",
      "role": "tts",
      "ready": true,
      "configExists": true,
      "localDir": "/path/to/voxcpm2"
    }
  ]
}
```

### 关键字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `modelLoaded` | boolean | TTS 模型是否已加载到内存 |
| `asrLoaded` | boolean | ASR 模型是否已加载到内存 |
| `coreModelReady` | boolean | TTS 核心模型文件是否就绪 |
| `asrModelReady` | boolean | ASR 模型文件是否就绪 |
| `bootstrapAssetsReady` | boolean | 所有引导资源是否全部就绪 |
| `deviceType` | string | 推理设备类型：`"mps"` / `"cuda"` / `"cpu"` |
| `bootstrapAssets` | array | 各引导资源的就绪状态详情 |
