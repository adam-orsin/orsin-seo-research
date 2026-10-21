import { verifyCloudflareAccessToken } from "@/middleware/ensure-user/cloudflareAccess";
import { resolveLocalNoAuthContext } from "@/middleware/ensure-user/delegated";
import { timingSafeEqual } from "@/server/lib/timing-safe-equal";
import {
  maintenanceRequestSchema,
  ORSIN_MAINTENANCE_SECRET_HEADER,
  SELF_HOST_CONTROL_NAME,
} from "./policy";

const MAX_BODY_BYTES = 16 * 1024;

// Who is asking, for the ledger_events audit row. Cloudflare Access puts a
// login's email or a service token's common_name in the verified JWT; the
// local mode has one implicit admin.
async function resolveOperator(
  request: Request,
  authMode: "cloudflare_access" | "local_noauth",
): Promise<string | null> {
  if (authMode === "local_noauth") {
    return (await resolveLocalNoAuthContext()).userEmail;
  }
  const payload = await verifyCloudflareAccessToken(request.headers);
  const actor = [payload.email, payload.common_name].find(
    (claim): claim is string => typeof claim === "string" && claim.length > 0,
  );
  return actor ?? null;
}

// Operator recovery for the self-host research ledger: list unsettled holds,
// release one at zero, or unpause after an overrun. Requires both the Access
// identity in front of the worker and the deployment's maintenance secret;
// an unset secret disables the route. Hosted mode never serves it, and no
// MCP tool reaches these Durable Object methods.
export async function handleOrsinMaintenanceRequest(
  request: Request,
  authMode: "cloudflare_access" | "local_noauth" | "hosted",
  env: Env,
): Promise<Response> {
  const secret = env.ORSIN_MAINTENANCE_SECRET?.trim();
  if (authMode === "hosted" || !secret || !env.ORSIN_CONTROL) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const presented = request.headers.get(ORSIN_MAINTENANCE_SECRET_HEADER) ?? "";
  if (!timingSafeEqual(presented, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let actor: string | null;
  try {
    actor = await resolveOperator(request, authMode);
  } catch (error) {
    console.error("Orsin maintenance identity check failed:", error);
    actor = null;
  }
  if (!actor) return new Response("Unauthorized", { status: 401 });

  // Bound the body before buffering it; a body with no Content-Length would
  // stream unbounded, so the header is required.
  if (!request.headers.has("content-length")) {
    return new Response("Content-Length required", { status: 411 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  let input: unknown;
  try {
    input = JSON.parse(await request.text()) as unknown;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = maintenanceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid maintenance request" },
      { status: 400 },
    );
  }

  const control = env.ORSIN_CONTROL.getByName(SELF_HOST_CONTROL_NAME);
  const command = parsed.data;
  try {
    if (command.action === "list") {
      return Response.json({
        status: await control.status(),
        unsettled: await control.listUnsettled(),
      });
    }
    if (command.action === "release") {
      return Response.json(
        await control.release(command.id, command.reason, actor),
      );
    }
    return Response.json(await control.unpause(command.reason, actor));
  } catch (error) {
    // The ledger refuses with a plain message (unknown id, already settled,
    // not paused); it carries no secret and is what the operator must see.
    return Response.json(
      { error: error instanceof Error ? error.message : "Refused" },
      { status: 409 },
    );
  }
}
