import { useTranslation } from "react-i18next";
import type { SetupDiagnostics } from "@voca/contracts";

type Props = {
  setupDiagnostics: SetupDiagnostics | null | undefined;
};

function backendLabel(
  backend: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!backend) return "—";
  switch (backend.toLowerCase()) {
    case "cuda":
      return t("settings.inferenceBackend.cuda");
    case "vulkan":
      return t("settings.inferenceBackend.vulkan");
    case "mps":
      return t("settings.inferenceBackend.mps");
    case "cpu":
    default:
      return t("settings.inferenceBackend.cpu");
  }
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(value, 0);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

export function InferenceBackendCard({ setupDiagnostics }: Props) {
  const { t } = useTranslation();
  const activeBackend = setupDiagnostics?.activeTorchBackend ?? null;
  // The GPU/VRAM panel only applies to Windows builds (Vulkan backend). On
  // macOS/Linux we render a slim card describing the active backend and skip
  // GPU warnings that would otherwise mislead users.
  const isWindows = setupDiagnostics?.platform === "windows";

  if (!isWindows) {
    return (
      <div className="settings-section">
        <div className="settings-section__title">{t("settings.inferenceBackend.title")}</div>
        <div className="kv-grid">
          <div>
            <div className="kv-row">
              <span className="kv-row__key">{t("settings.inferenceBackend.activeLabel")}</span>
              <span className="kv-row__value">{backendLabel(activeBackend?.toString(), t)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The Windows backend is llama.cpp + Vulkan — any GPU vendor with a
  // Vulkan-capable driver works. Only an explicit `false` counts as missing.
  const vulkanMissing = setupDiagnostics?.hasVulkanSupport === false;
  const gpuName = setupDiagnostics?.gpuName ?? null;
  const gpuMemoryBytes = setupDiagnostics?.gpuMemoryBytes ?? null;
  const minimumGpuMemoryBytes =
    setupDiagnostics?.minimumGpuMemoryBytes ?? 6 * 1024 * 1024 * 1024;
  // VRAM numbers are only trustworthy from nvidia-smi (dedicated VRAM).
  // WMI caps at 4 GB and iGPUs share system RAM (Vulkan can use ~half of
  // it), so non-NVIDIA readings are hidden and never trigger the warning.
  const hasReliableVramReading = setupDiagnostics?.hasNvidiaGpu === true;
  const lowVram =
    hasReliableVramReading && gpuMemoryBytes !== null && gpuMemoryBytes < minimumGpuMemoryBytes;

  return (
    <div className="settings-section">
      <div className="settings-section__title">{t("settings.inferenceBackend.title")}</div>
      <div className="kv-grid">
        <div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.inferenceBackend.activeLabel")}</span>
            <span className="kv-row__value">{backendLabel(activeBackend?.toString(), t)}</span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">GPU</span>
            <span className="kv-row__value">
              {gpuName ?? t("settings.inferenceBackend.gpuNotDetected")}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.inferenceBackend.vramLabel")}</span>
            <span className="kv-row__value">
              {hasReliableVramReading && gpuMemoryBytes !== null
                ? formatBytes(gpuMemoryBytes)
                : t("settings.inferenceBackend.vramShared")}
            </span>
          </div>
        </div>
        <div>
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {vulkanMissing
              ? t("settings.inferenceBackend.vulkanMissing")
              : lowVram
                ? t("settings.inferenceBackend.lowVram", {
                    memory: gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : "—",
                    minimum: formatBytes(minimumGpuMemoryBytes),
                  })
                : t("settings.inferenceBackend.vulkanReady")}
          </p>
        </div>
      </div>
    </div>
  );
}
