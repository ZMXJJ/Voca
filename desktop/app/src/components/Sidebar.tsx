import type { ReactNode } from "react";
import type { SidecarStatus } from "@voca/contracts";
import { useTranslation } from "react-i18next";
import { HealthIndicator } from "./HealthIndicator";
import { IconHome, IconArchive, IconSettings, IconVocaLogo } from "./Icons";

type SidebarSection = "studio" | "history" | "settings";

type SidebarProps = {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  sidecarStatus: SidecarStatus;
};

const NAV_ITEMS: Array<{ key: SidebarSection; icon: ReactNode }> = [
  { key: "studio", icon: <IconHome size={20} /> },
  { key: "history", icon: <IconArchive size={20} /> },
  { key: "settings", icon: <IconSettings size={20} /> },
];

export function Sidebar({ activeSection, onSectionChange, sidecarStatus }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__logo"><IconVocaLogo height={28} /></div>
        <div className="sidebar__tagline">{t("sidebar.tagline")}</div>
      </div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`sidebar__nav-item${activeSection === item.key ? " sidebar__nav-item--active" : ""}`}
            onClick={() => onSectionChange(item.key)}
          >
            <span className="sidebar__nav-icon">{item.icon}</span>
            <span>{t(`sidebar.nav.${item.key}`)}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <HealthIndicator sidecarStatus={sidecarStatus} />
      </div>
    </aside>
  );
}
