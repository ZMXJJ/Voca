import type { ServiceInfo, SidecarStatus } from "@voca/contracts";
import { useTranslation } from "react-i18next";

type HealthIndicatorProps = {
  sidecarStatus: SidecarStatus;
  serviceInfo: ServiceInfo | null;
};

function formatDevice(serviceInfo: ServiceInfo | null): string {
  const name = serviceInfo?.deviceName?.trim();
  const type = serviceInfo?.deviceType?.trim();
  if (name && type) return `${name} [${type}]`;
  return name || type || "—";
}

export function HealthIndicator({ sidecarStatus, serviceInfo }: HealthIndicatorProps) {
  const { t } = useTranslation();
  const healthy = sidecarStatus.healthy;

  return (
    <div className="health-indicator">
      <span className="health-indicator__label">{t("sidebar.serviceStatus")}</span>
      <span className="health-indicator__status">
        {healthy ? t("sidebar.healthy") : t("sidebar.unhealthy")}
        <span className={`health-indicator__dot health-indicator__dot--${healthy ? "healthy" : "unhealthy"}`} />
      </span>

      <div className="health-indicator__tooltip">
        <div className="health-indicator__tooltip-title">{t("sidebar.inferenceService")}</div>
        <div className="health-indicator__tooltip-row">
          <span className="health-indicator__tooltip-key">{t("sidebar.device")}:</span>
          <span className="health-indicator__tooltip-val" title={formatDevice(serviceInfo)}>{formatDevice(serviceInfo)}</span>
        </div>
        <div className="health-indicator__tooltip-row">
          <span className="health-indicator__tooltip-key">{t("sidebar.queue")}:</span>
          <span className="health-indicator__tooltip-val">
            {sidecarStatus.running ? "IDLE" : "OFFLINE"}
          </span>
        </div>
      </div>
    </div>
  );
}
