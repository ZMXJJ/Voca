import type { ReactNode } from "react";

type StatusBadgeTone = "accent" | "success" | "warning" | "danger" | "muted";

type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusBadgeTone;
};

export function StatusBadge({ children, tone = "muted" }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
