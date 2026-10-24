import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(() => {
    const configured = Boolean(env.DATAFORSEO_API_KEY?.trim());
    return { configured };
  });

// Every non-hosted deployment of this fork is the self-host research pilot.
// The browser reads this one flag to hide features the pilot does not serve.
export const getResearchPilotStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(() => ({ researchPilot: !isHostedAuthMode(env.AUTH_MODE) }));
