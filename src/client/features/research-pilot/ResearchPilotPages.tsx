import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Bookmark,
  Brain,
  FileText,
  Lock,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "@/client/components/EmptyState";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";

/** Shown in place of a page the self-host research pilot does not serve. */
export function PilotUnavailableNotice({
  reason = "feature",
}: {
  reason?: "feature" | "not-linked";
}) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto max-w-xl pt-6">
        <EmptyState
          variant="card"
          icon={Lock}
          title={
            reason === "not-linked"
              ? "This project isn't linked to a client"
              : "Not available in this workspace"
          }
          description={
            reason === "not-linked"
              ? "Research here runs only for projects linked to a client. Link this project through the research connection, then reload the page."
              : "This workspace runs keyword research, Google results, saved keywords, reports, and project context. This page is turned off here."
          }
          action={
            <Button nativeButton={false} render={<Link to="/projects" />}>
              Back to projects
            </Button>
          }
        />
      </div>
    </div>
  );
}

const PILOT_PAGES: Array<{
  to:
    | "/p/$projectId/keywords"
    | "/p/$projectId/saved"
    | "/p/$projectId/reports"
    | "/p/$projectId/context";
  icon: LucideIcon;
  title: string;
  description: string;
}> = [
  {
    to: "/p/$projectId/keywords",
    icon: Search,
    title: "Keyword research",
    description: "Look up keywords and the Google results for them.",
  },
  {
    to: "/p/$projectId/saved",
    icon: Bookmark,
    title: "Saved keywords",
    description: "Review and refresh the keywords you saved.",
  },
  {
    to: "/p/$projectId/reports",
    icon: FileText,
    title: "Reports",
    description: "Read the reports saved for this client.",
  },
  {
    to: "/p/$projectId/context",
    icon: Brain,
    title: "Context",
    description: "Business notes and competitors used in research.",
  },
];

/**
 * The pilot's project home. The full dashboard is built from Search Console,
 * analytics, site audits, and backlinks, none of which the pilot serves.
 */
export function ResearchPilotDashboard({ projectId }: { projectId: string }) {
  const { data: projects } = useQuery(projectsQueryOptions());
  const project = projects?.find((candidate) => candidate.id === projectId);

  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <PageHeader
          title={project?.domain || project?.name || "Dashboard"}
          description="Research for this client runs under the workspace spending limit."
          actions={
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/p/$projectId/settings" params={{ projectId }} />
              }
            >
              <Settings />
              Project settings
            </Button>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {PILOT_PAGES.map((page) => (
            <Link
              key={page.to}
              to={page.to}
              params={{ projectId }}
              className="flex gap-3 rounded-xl border border-border bg-card p-4 transition hover:bg-muted/50"
            >
              <page.icon className="size-5 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{page.title}</span>
                <span className="text-sm text-muted-foreground">
                  {page.description}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
