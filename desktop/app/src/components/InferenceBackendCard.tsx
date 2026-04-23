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
  const hasNvidiaGpu = setupDiagnostics?.hasNvidiaGpu ?? false;
  const gpuMemoryBytes = setupDiagnostics?.gpuMemoryBytes ?? null;
  const minimumGpuMemoryBytes =
    setupDiagnostics?.minimumGpuMemoryBytes ?? 6 * 1024 * 1024 * 1024;
  const gpuReady =
    hasNvidiaGpu && gpuMemoryBytes !== null && gpuMemoryBytes >= minimumGpuMemoryBytes;

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
              {hasNvidiaGpu
                ? `${t("settings.inferenceBackend.gpuDetected")}${
                    setupDiagnostics?.gpuName ? ` · ${setupDiagnostics.gpuName}` : ""
                  }`
                : t("settings.inferenceBackend.gpuNotDetected")}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-row__key">{t("settings.inferenceBackend.vramLabel")}</span>
            <span className="kv-row__value">
              {gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : "—"}
            </span>
          </div>
        </div>
        <div>
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {gpuReady
              ? t("settings.inferenceBackend.downloadedCuda")
              : hasNvidiaGpu
                ? t("settings.inferenceBackend.gpuInsufficient", {
                    memory: gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : "—",
                    minimum: formatBytes(minimumGpuMemoryBytes),
                  })
                : t("settings.inferenceBackend.gpuRequired", {
                    minimum: formatBytes(minimumGpuMemoryBytes),
                  })}
          </p>
        </div>
      </div>
    </div>
  );
}
