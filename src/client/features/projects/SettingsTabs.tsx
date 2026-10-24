import { NavTab, NavTabs } from "@/client/components/NavTabs";
import {
  isPilotHiddenPath,
  useResearchPilot,
} from "@/client/lib/research-pilot";

const tabs = [
  { to: "/p/$projectId/settings" as const, label: "General", exact: true },
  { to: "/p/$projectId/settings/integrations" as const, label: "Integrations" },
];

export function SettingsTabs({ projectId }: { projectId: string }) {
  const researchPilot = useResearchPilot();
  const visibleTabs = researchPilot
    ? tabs.filter((tab) => !isPilotHiddenPath(tab.to))
    : tabs;
  return (
    <NavTabs label="Project settings sections">
      {visibleTabs.map((tab) => (
        <NavTab
          key={tab.to}
          to={tab.to}
          params={{ projectId }}
          activeOptions={{ exact: tab.exact ?? false }}
        >
          {tab.label}
        </NavTab>
      ))}
    </NavTabs>
  );
}
