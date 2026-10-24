import { dashboardSearchSchema } from "@/types/schemas/dashboard";
import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/client/features/dashboard/DashboardPage";
import { ResearchPilotDashboard } from "@/client/features/research-pilot/ResearchPilotPages";
import { useResearchPilot } from "@/client/lib/research-pilot";

export const Route = createFileRoute("/_app/p/$projectId/")({
  validateSearch: dashboardSearchSchema,
  component: DashboardRoute,
});

function DashboardRoute() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (useResearchPilot())
    return <ResearchPilotDashboard projectId={projectId} />;
  return (
    <DashboardPage
      key={projectId}
      projectId={projectId}
      tab={search.tab}
      onTabChange={(tab) => void navigate({ search: { tab } })}
    />
  );
}
