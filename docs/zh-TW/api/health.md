# Health — 健康檢查

## GET `/api/v1/health`

返回服務的執行狀態、裝置資訊、模型載入狀態、儲存目錄及空間佔用等診斷資訊。

### 請求

無參數。

### 響應

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

### 關鍵欄位說明

| 欄位 | 類型 | 說明 |
|------|------|------|
| `modelLoaded` | boolean | TTS 模型是否已載入到記憶體 |
| `asrLoaded` | boolean | ASR 模型是否已載入到記憶體 |
| `coreModelReady` | boolean | TTS 核心模型檔案是否就緒 |
| `asrModelReady` | boolean | ASR 模型檔案是否就緒 |
| `bootstrapAssetsReady` | boolean | 所有引導資源是否全部就緒 |
| `deviceType` | string | 推理裝置類型：`"mps"` / `"cuda"` / `"cpu"` |
| `bootstrapAssets` | array | 各引導資源的就緒狀態詳情 |
