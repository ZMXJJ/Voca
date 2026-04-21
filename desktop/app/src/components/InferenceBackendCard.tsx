import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CudaUpgradeRuntimeInfo,
  CudaUpgradeStage,
  SetupDiagnostics,
  TaskRecord,
} from "@voca/contracts";
import {
  getCudaRuntimeInfo,
  getTask,
  startCudaUpgrade,
} from "../lib/tauri";

type Props = {
  setupDiagnostics: SetupDiagnostics | null | undefined;
};

const STAGE_ORDER: CudaUpgradeStage[] = ["download", "verify", "install", "validate"];

function deriveStage(progress: number): CudaUpgradeStage {
  if (progress < 86) return "download";
  if (progress < 90) return "verify";
  if (progress < 96) return "install";
  return "validate";
}

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

export function InferenceBackendCard({ setupDiagnostics }: Props) {
  const { t } = useTranslation();
  const [runtimeInfo, setRuntimeInfo] = useState<CudaUpgradeRuntimeInfo | null>(null);
  const [activeTask, setActiveTask] = useState<TaskRecord | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refreshRuntimeInfo = useCallback(async () => {
    const info = await getCudaRuntimeInfo();
    setRuntimeInfo(info);
  }, []);

  useEffect(() => {
    void refreshRuntimeInfo();
  }, [refreshRuntimeInfo]);

  useEffect(() => {
    if (!activeTask || ["succeeded", "failed", "cancelled"].includes(activeTask.status)) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    if (pollRef.current) return;
    pollRef.current = window.setInterval(async () => {
      const updated = await getTask(activeTask.id);
      if (!updated) return;
      setActiveTask(updated);
      if (["succeeded", "failed", "cancelled"].includes(updated.status)) {
        await refreshRuntimeInfo();
      }
    }, 800);

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeTask, refreshRuntimeInfo]);

  const handleStartUpgrade = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const task = await startCudaUpgrade();
      if (task) {
        setActiveTask(task);
      }
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, []);

  const activeBackend = useMemo(() => {
    return (
      runtimeInfo?.active ??
      setupDiagnostics?.activeTorchBackend ??
      (setupDiagnostics?.hasNvidiaGpu ? "cpu" : "cpu")
    );
  }, [runtimeInfo?.active, setupDiagnostics?.activeTorchBackend, setupDiagnostics?.hasNvidiaGpu]);

  const hasNvidiaGpu = setupDiagnostics?.hasNvidiaGpu ?? false;
  const isUpgradeRunning =
    !!activeTask && !["succeeded", "failed", "cancelled"].includes(activeTask.status);
  const stage = activeTask ? deriveStage(activeTask.progress ?? 0) : "download";
  const showRolledBackBanner =
    activeTask?.status === "failed" ||
    activeTask?.status === "cancelled" ||
    (!activeTask && !!runtimeInfo?.lastUpgradeError);
  const showSuccessBanner = activeTask?.status === "succeeded";
  const isCudaActive = (activeBackend?.toString().toLowerCase() ?? "") === "cuda";
  const canUpgrade = hasNvidiaGpu && !isCudaActive && !isUpgradeRunning;

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
        </div>
        <div>
          {canUpgrade ? (
            <>
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 8px" }}>
                {t("settings.inferenceBackend.upgradeAvailable")}
              </p>
              <button
                className="btn btn--glass"
                disabled={starting}
                onClick={handleStartUpgrade}
              >
                {t("settings.inferenceBackend.upgradeButton")}
              </button>
              {startError ? (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "rgba(255, 80, 80, 0.12)",
                    color: "#d23a3a",
                    fontSize: 12,
                  }}
                >
                  {startError}
                </div>
              ) : null}
            </>
          ) : isCudaActive && !isUpgradeRunning ? (
            <p style={{ fontSize: 13, margin: 0 }}>
              {t("settings.inferenceBackend.activeCuda")}
            </p>
          ) : null}

          {isUpgradeRunning ? (
            <div style={{ marginTop: canUpgrade ? 12 : 0 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                {t("settings.inferenceBackend.upgradeRunning")}
              </div>
              <div className="progress-card__bar">
                <div
                  className="progress-card__fill"
                  style={{ width: `${activeTask?.progress ?? 0}%` }}
                />
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {STAGE_ORDER.map((s, idx) => {
                  const currentIdx = STAGE_ORDER.indexOf(stage);
                  const reached = idx <= currentIdx;
                  return (
                    <span
                      key={s}
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: reached
                          ? "rgba(67, 144, 255, 0.18)"
                          : "rgba(120, 120, 120, 0.08)",
                        color: reached ? "#2563eb" : "#888",
                      }}
                    >
                      {t(`settings.inferenceBackend.stage.${s}`)}
                    </span>
                  );
                })}
              </div>
              {activeTask?.message ? (
                <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
                  {activeTask.message}
                </div>
              ) : null}
            </div>
          ) : null}

          {showSuccessBanner ? (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 6,
                background: "rgba(45, 188, 132, 0.12)",
                color: "#1a8e64",
                fontSize: 12,
              }}
            >
              {t("settings.inferenceBackend.successBanner")}
            </div>
          ) : null}

          {showRolledBackBanner ? (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 6,
                background: "rgba(255, 80, 80, 0.12)",
                color: "#d23a3a",
                fontSize: 12,
              }}
            >
              {t("settings.inferenceBackend.rolledBackBanner", {
                message:
                  activeTask?.error?.message ??
                  activeTask?.message ??
                  runtimeInfo?.lastUpgradeError ??
                  "",
              })}
            </div>
          ) : null}

          {!isUpgradeRunning &&
          !showSuccessBanner &&
          !showRolledBackBanner &&
          runtimeInfo?.lastUpgradeError ? (
            <div style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
              {t("settings.inferenceBackend.lastError", {
                message: runtimeInfo.lastUpgradeError,
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
