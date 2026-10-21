import { SERP_ANALYSIS_DEPTH } from "@/server/lib/dataforseo/serp";
import { getKeywordDataProvider } from "@/shared/keyword-locations";
import { z } from "zod";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { mcpResponse } from "@/server/mcp/formatters";
import type { ToolContext } from "@/server/mcp/context";
import { selfHostControl } from "@/server/selfhost/service";
import {
  clientRefSchema,
  domainOf,
  usdToMicros,
} from "@/server/selfhost/policy";

async function requireSelfHost() {
  if (await isHostedServerAuthMode())
    throw new AppError(
      "FORBIDDEN",
      "Orsin control tools require self-host mode.",
    );
}
const projectId = z.string().min(1).max(200);
const read = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};
const output = z.looseObject({});

export const bindClientProjectTool = {
  name: "bind_client_project",
  config: {
    title: "Bind client project",
    description:
      "Bind an explicit canonical clientRef to a project with the same domain in the operator-reviewed directory. Requires an owner or admin. Repeating the identical mapping is safe; conflicting mappings are refused. Uses no provider credits. This does not copy or write back private vault content.",
    inputSchema: { projectId, clientRef: clientRefSchema },
    outputSchema: output,
    annotations: { ...read, readOnlyHint: false },
  },
  handler: withMcpProjectAuth(
    async (args: { projectId: string; clientRef: string }, context) => {
      await requireSelfHost();
      if (
        !context.auth.role
          .split(",")
          .some((role) => ["owner", "admin"].includes(role.trim()))
      )
        throw new AppError("FORBIDDEN");
      if (!context.project.domain)
        throw new AppError(
          "VALIDATION_ERROR",
          "An active project domain is required.",
        );
      const mapping = await selfHostControl().bind({
        ...args,
        organizationId: context.auth.organizationId,
        domain: domainOf(context.project.domain),
      });
      return mcpResponse({
        text: "Client mapping saved.",
        structuredContent: { mapping },
      });
    },
  ),
};

export const resolveClientProjectTool = {
  name: "resolve_client_project",
  config: {
    title: "Resolve client project",
    description:
      "Resolve an exact canonical clientRef within this self-host workspace. Rechecks the project domain and access; never guesses from a display name. Uses no provider credits.",
    inputSchema: { clientRef: clientRefSchema },
    outputSchema: output,
    annotations: read,
  },
  handler: async (args: { clientRef: string }, context: ToolContext) => {
    await requireSelfHost();
    const mapping = await selfHostControl().resolve(
      context.auth.organizationId,
      args.clientRef,
    );
    const project = await ProjectService.getProjectForOrganization(
      context.auth.organizationId,
      mapping.projectId,
    );
    if (!project?.domain || domainOf(project.domain) !== mapping.domain)
      throw new AppError(
        "FORBIDDEN",
        "Project domain changed or project is unavailable.",
      );
    return mcpResponse({
      text: `Mapped client: ${mapping.clientRef}.`,
      structuredContent: { mapping },
    });
  },
};

export const getSpendingStatusTool = {
  name: "get_spending_status",
  config: {
    title: "Get spending status",
    description:
      "Read deployment-wide DataForSEO limits, actual spend, outstanding reservations, enabled operations, and pause status. Values are integer USD microdollars. Periods use UTC. No budget is changed and no provider is called.",
    inputSchema: {} as Record<string, never>,
    outputSchema: output,
    annotations: read,
  },
  handler: async () => {
    await requireSelfHost();
    const budget = await selfHostControl().status();
    return mcpResponse({
      text: "DataForSEO spending status. One USD is 1,000,000 microdollars. Outstanding holds include unknown provider outcomes.",
      structuredContent: { budget },
    });
  },
};

const estimateInput = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("keywords.overview"),
    locationCode: z.number().int().positive().optional(),
    keywords: z.array(z.string().min(1)).min(1).max(700),
    includeClickstreamData: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal("serp.organic"),
    keyword: z.string().min(1),
    depth: z.number().int().min(1).max(200).default(SERP_ANALYSIS_DEPTH),
  }),
  z.object({
    operation: z.literal("maps.grid"),
    gridSize: z.union([z.literal(3), z.literal(5)]).default(3),
  }),
  z.object({ operation: z.literal("business.profile") }),
]);
type EstimateArgs = {
  projectId: string;
  research: z.infer<typeof estimateInput>;
};
export const estimateResearchCostTool = {
  name: "estimate_research_cost",
  config: {
    title: "Estimate research cost",
    description:
      "Preview raw DataForSEO USD cost for one enabled pilot request, using the same provider estimators as dispatch. Match all research parameters to the actual call. Does not reserve funds or authorize execution; the ledger rechecks limits and client mapping at dispatch. Unknown outcomes and provider overruns can retain funds or pause later calls.",
    inputSchema: { projectId, research: estimateInput },
    outputSchema: output,
    annotations: read,
  },
  handler: withMcpProjectAuth(async (args: EstimateArgs, context) => {
    await requireSelfHost();
    const r = args.research;
    if (
      r.operation === "keywords.overview" &&
      getKeywordDataProvider(r.locationCode ?? context.project.locationCode) !==
        "labs"
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "The pilot enables keyword metrics only for Labs-supported countries.",
      );
    const usd =
      r.operation === "keywords.overview"
        ? dataforseoPricing.labs.keywordOverview({
            keywords: r.keywords,
            includeClickstreamData: r.includeClickstreamData,
            locationCode: 2840,
            languageCode: "en",
          })
        : r.operation === "serp.organic"
          ? dataforseoPricing.serp.live({
              keyword: r.keyword,
              depth: r.depth,
              locationCode: 2840,
              languageCode: "en",
            })
          : r.operation === "maps.grid"
            ? dataforseoPricing.serp.localTaskPost({
                locationCoordinates: Array<string>(r.gridSize ** 2).fill("0,0"),
                keyword: "estimate",
                languageCode: "en",
                device: "mobile",
                depth: 20,
              })
            : dataforseoPricing.business.myBusinessInfo({
                keyword: "estimate",
                locationCode: 2840,
                languageCode: "en",
              });
    const budget = await selfHostControl().status();
    return mcpResponse({
      text: `Estimated provider cost: $${usd.toFixed(6)}. This preview does not start research or reserve funds.`,
      structuredContent: {
        operation: r.operation,
        estimatedUsd: usd,
        estimatedMicros: usdToMicros(usd),
        budget,
      },
    });
  }),
};
