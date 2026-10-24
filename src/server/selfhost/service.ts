import { z } from "zod";
import { env, waitUntil } from "cloudflare:workers";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  DataforseoChargedTaskError,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  domainOf,
  operationSchema,
  usdToMicros,
  PILOT_TOOLS,
  SELF_HOST_CONTROL_NAME,
} from "./policy";
import type { ToolContext } from "@/server/mcp/context";

export function selfHostControl() {
  if (!env.ORSIN_CONTROL)
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "Self-host control binding is missing; paid research is disabled.",
    );
  return env.ORSIN_CONTROL.getByName(SELF_HOST_CONTROL_NAME);
}

export async function authorizePilotTool(
  name: string,
  args: unknown,
  context: ToolContext,
) {
  if (!PILOT_TOOLS.has(name))
    throw new AppError(
      "FORBIDDEN",
      "This tool is disabled in the self-host research pilot.",
    );
  if (name === "get_local_rank_grid") {
    const checked = z
      .object({
        target: z
          .object({
            cid: z.string().min(1).optional(),
            placeId: z.string().min(1).optional(),
            name: z.never().optional(),
          })
          .refine((target) => Boolean(target.cid || target.placeId)),
      })
      .safeParse(args);
    if (!checked.success)
      throw new AppError(
        "VALIDATION_ERROR",
        "The pilot requires an exact business cid or placeId. Omit name matching.",
      );
  }
  const projectId: unknown =
    args && typeof args === "object"
      ? Reflect.get(args, "projectId")
      : undefined;
  if (
    typeof projectId !== "string" ||
    name === "bind_client_project" ||
    name === "estimate_research_cost"
  )
    return;
  const project = await ProjectService.getProjectForOrganization(
    context.auth.organizationId,
    projectId,
  );
  await authorizeMappedProject(context.auth.organizationId, {
    id: projectId,
    domain: project?.domain ?? null,
  });
}

// The client-mapping check for project-scoped reads and research, shared by
// MCP tools, browser server functions, and the report viewer. A project whose
// mapping was removed or whose domain changed is refused.
export async function authorizeMappedProject(
  organizationId: string,
  project: { id: string; domain: string | null },
) {
  if (!project.domain)
    throw new AppError("PROJECT_NOT_LINKED", "Project domain is required.");
  try {
    await selfHostControl().authorizeProject(
      organizationId,
      project.id,
      domainOf(project.domain),
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "PROJECT_NOT_LINKED",
      error instanceof Error ? error.message : "Project mapping is missing.",
    );
  }
}

// A client mapping binds the project's domain. The pilot refuses a domain
// change in the browser, which would leave the project unlinked until an
// operator reviews it.
export async function assertPilotDomainUnchanged(
  current: string | null,
  next: string | undefined,
) {
  if (await isHostedServerAuthMode()) return;
  const same = (() => {
    try {
      return Boolean(current && next && domainOf(current) === domainOf(next));
    } catch {
      return false;
    }
  })();
  if (!same)
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      "A linked client's domain can't change in the self-host research pilot.",
    );
}

export async function spendSelfHosted<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  estimatedUsd: number,
  operation?: string,
): Promise<T> {
  const parsed = operationSchema.safeParse(operation);
  if (!parsed.success)
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      "This paid operation is disabled in the self-host pilot.",
    );
  if (!customer.projectId)
    throw new AppError("FORBIDDEN", "A mapped client project is required.");
  const project = await ProjectService.getProjectForOrganization(
    customer.organizationId,
    customer.projectId,
  );
  if (!project?.domain)
    throw new AppError(
      "FORBIDDEN",
      "An active project with a verified domain is required.",
    );
  const control = selfHostControl();
  let reservation: { id: string };
  try {
    reservation = await control.reserve({
      id: crypto.randomUUID(),
      organizationId: customer.organizationId,
      projectId: customer.projectId,
      domain: domainOf(project.domain),
      operation: parsed.data,
      estimated: usdToMicros(estimatedUsd),
    });
  } catch (error) {
    // Nothing was dispatched. The ledger's reason (operation off, budget
    // reached, paused, mapping changed) stays in the message for MCP agents;
    // the browser shows its own copy for the code.
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      error instanceof Error ? error.message : "Research was refused.",
    );
  }
  const work = (async () => {
    let response: DataforseoApiResponse<T>;
    try {
      response = await execute();
    } catch (error) {
      if (error instanceof DataforseoChargedTaskError) {
        await control.settle({
          id: reservation.id,
          actual: usdToMicros(error.billing.costUsd),
        });
        throw error;
      }
      // A timeout can follow dispatch. Unknown costs retain their hold across
      // restarts and period boundaries; no automatic refund or paid retry.
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Research outcome is uncertain and its reservation is retained. Inspect spending and provider evidence before retrying; do not retry automatically.",
      );
    }
    try {
      await control.settle({
        id: reservation.id,
        actual: usdToMicros(response.billing.costUsd),
      });
    } catch {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Research was dispatched but settlement is unconfirmed. Its reservation remains protected. Do not retry automatically.",
      );
    }
    return response.data;
  })();
  try {
    waitUntil(work.catch(() => undefined));
  } catch {
    /* workflows/tests await below */
  }
  return await work;
}
