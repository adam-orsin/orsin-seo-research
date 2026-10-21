import { z } from "zod";

export const operationSchema = z.enum([
  "keywords.overview",
  "serp.organic",
  "maps.grid",
  "business.profile",
]);
export const clientRefSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);

export function domainOf(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a website origin without a path, credentials, port, query, or fragment.",
    );
  }
  const domain = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain))
    throw new Error("Invalid website domain.");
  return domain;
}

export const directorySchema = z
  .object({
    schemaVersion: z.literal(1),
    clients: z
      .array(
        z
          .object({
            clientRef: clientRefSchema,
            domain: z.string().transform(domainOf),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((directory, ctx) => {
    const refs = new Set<string>(),
      domains = new Set<string>();
    for (const client of directory.clients) {
      if (refs.has(client.clientRef) || domains.has(client.domain)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate client reference or domain.",
        });
      }
      refs.add(client.clientRef);
      domains.add(client.domain);
    }
  });

// Integer microdollars avoid rounding a tiny paid request down to zero.
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000)
    throw new Error("Invalid provider cost.");
  return Math.ceil(usd * 1_000_000);
}

function limit(value: unknown): number {
  if (value === undefined || value === "") return 0;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new Error(
      "Budget limits must be nonnegative USD decimals with at most six decimal places.",
    );
  }
  return usdToMicros(Number(value));
}

export function readPolicy(env: object) {
  const operations = String(Reflect.get(env, "ORSIN_ENABLED_OPERATIONS") ?? "")
    .split(",")
    .filter(Boolean)
    .map((op) => operationSchema.parse(op.trim()));
  return {
    maxCall: limit(Reflect.get(env, "ORSIN_MAX_CALL_USD")),
    daily: limit(Reflect.get(env, "ORSIN_DAILY_USD")),
    monthly: limit(Reflect.get(env, "ORSIN_MONTHLY_USD")),
    operations,
    directory: directorySchema.parse(
      JSON.parse(
        String(
          Reflect.get(env, "ORSIN_CLIENT_DIRECTORY") ||
            '{"schemaVersion":1,"clients":[]}',
        ),
      ),
    ),
  };
}
export type ResearchPolicy = ReturnType<typeof readPolicy>;

export const PILOT_TOOLS = new Set([
  "whoami",
  "list_projects",
  "create_project",
  "get_project_context",
  "get_keyword_metrics",
  "get_serp_results",
  "get_local_rank_grid",
  "get_business_profile",
  "list_reports",
  "get_report",
  "save_report",
  "bind_client_project",
  "resolve_client_project",
  "get_spending_status",
  "estimate_research_cost",
]);

// Cloudflare Access handles login before the worker. The pilot has no browser
// app, in-app agent, server-function API, crawler, or public report surface.
export function pilotPathAllowed(path: string) {
  return path === "/mcp" || path === "/api/health";
}
