import {
  Outlet,
  createFileRoute,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { useHostedAuthRouteGuard } from "@/client/features/auth/useHostedAuthRouteGuard";
import { prefetchBillingAccount } from "@/client/features/billing/billingAccountQuery";
import { FreePlanBanner } from "@/client/features/billing/FreePlanBanner";
import { TermsUpdateBanner } from "@/client/features/auth/TermsUpdateBanner";
import { SkeletonPage } from "@/client/components/SkeletonPresets";
import { PageLoading } from "@/client/components/Spinner";
import { getLastProjectId } from "@/client/lib/active-project";
import { AuthenticatedAppLayout } from "@/client/layout/AppShell";
import { useOnboardingRedirect } from "@/client/features/onboarding/useOnboardingRedirect";
import { PilotUnavailableNotice } from "@/client/features/research-pilot/ResearchPilotPages";
import {
  isPilotHiddenPath,
  useResearchPilot,
} from "@/client/lib/research-pilot";

export const Route = createFileRoute("/_app")({
  component: AppRouteLayout,
});

// One layout for app pages and project pages (/p/$projectId/...), so the
// drawer, setup modal and GSC nudge keep their state when the user moves
// between the two.
function AppRouteLayout() {
  const authGate = useHostedAuthRouteGuard();
  const isOnboarded = useOnboardingRedirect();
  const { projectId } = useParams({ strict: false });
  const { pathname } = useLocation();
  // A page the research pilot does not serve, reached by URL or an old link.
  const pilotHidden = useResearchPilot() && isPilotHiddenPath(pathname);
  // The shell paints at once, and only the page waits for the session check,
  // so a full load shows the sidebar and a page skeleton instead of a spinner.
  const ready = authGate.canRenderAuthenticatedContent;

  // Billing, fix-payment, and the upgrade page all read this one cached
  // account, so loading it once here lets them open without waiting.
  useEffect(() => {
    if (ready) prefetchBillingAccount();
  }, [ready]);

  // Until onboarding is known to be done, show a plain spinner, so a user on
  // their way to /onboarding never sees the dashboard flash first. A browser
  // that has opened a project is past onboarding, so the shell paints at once.
  if (!isOnboarded && !getLastProjectId()) {
    return <PageLoading />;
  }

  return (
    <AuthenticatedAppLayout
      projectId={projectId}
      ready={ready}
      banner={
        ready && authGate.isHostedMode ? (
          <>
            <TermsUpdateBanner />
            {projectId ? <FreePlanBanner /> : null}
          </>
        ) : undefined
      }
    >
      {!ready ? (
        <SkeletonPage />
      ) : pilotHidden ? (
        <PilotUnavailableNotice />
      ) : (
        <Outlet />
      )}
    </AuthenticatedAppLayout>
  );
}
