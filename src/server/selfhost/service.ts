import { z } from "zod";
import { env, waitUntil } from "cloudflare:workers";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import {
  DataforseoChargedTaskError,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { domainOf, operationSchema, usdToMicros, PILOT_TOOLS } from "./policy";
import type { ToolContext } from "@/server/mcp/context";

export function selfHostControl() {
  if (!env.ORSIN_CONTROL)
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "Self-host control binding is missing; paid research is disabled.",
    );
  return env.ORSIN_CONTROL.getByName("dataforseo-account");
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
  if (!project?.domain)
    throw new AppError("FORBIDDEN", "Project domain is required.");
  await selfHostControl().authorizeProject(
    context.auth.organizationId,
    projectId,
    domainOf(project.domain),
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
      "FORBIDDEN",
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
  const reservation = await control.reserve({
    id: crypto.randomUUID(),
    organizationId: customer.organizationId,
    projectId: customer.projectId,
    domain: domainOf(project.domain),
    operation: parsed.data,
    estimated: usdToMicros(estimatedUsd),
  });
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
