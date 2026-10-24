import { useQuery } from "@tanstack/react-query";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { getResearchPilotStatus } from "@/serverFunctions/config";

// Pages the self-host research pilot does not serve. Their server functions
// refuse on the server anyway; hiding them keeps the user away from raw errors.
const PILOT_HIDDEN_PROJECT_PAGES = [
  "rank-tracking",
  "search-performance",
  "domain",
  "backlinks",
  "audit",
  "ai-visibility",
  "prompt-explorer",
  "brand-lookup",
  "sam",
  "settings/integrations",
];
const PILOT_HIDDEN_APP_PAGES = ["/ai", "/billing"];

const startsWithSegment = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Also matches route patterns such as `/p/$projectId/backlinks`. */
export function isPilotHiddenPath(pathname: string) {
  const projectPage = /^\/p\/[^/]+\/(.+)$/.exec(pathname)?.[1];
  if (projectPage)
    return PILOT_HIDDEN_PROJECT_PAGES.some((page) =>
      startsWithSegment(projectPage, page),
    );
  return PILOT_HIDDEN_APP_PAGES.some((page) =>
    startsWithSegment(pathname, page),
  );
}

/** True when the server is the self-host research pilot. */
export function useResearchPilot() {
  const { data } = useQuery({
    queryKey: ["researchPilotStatus"],
    queryFn: () => getResearchPilotStatus(),
    staleTime: Infinity,
    // Until the server answers, assume the client build's mode, so the
    // sidebar does not flash features the pilot hides.
    placeholderData: { researchPilot: !isHostedClientAuthMode() },
  });
  return data?.researchPilot ?? false;
}
