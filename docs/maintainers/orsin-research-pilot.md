# Orsin research pilot

This fork provides a separate MCP research service. Deployment is not approved. It does not change `seo.orsin.io` or write to the Shelled vault.

## First increment

Self-host mode exposes `/mcp`, `/api/health`, the operator-only `/api/orsin/maintenance`, the read-only `/ops` page, and the browser app behind the same Cloudflare Access login. MCP tools outside the pilot allowlist refuse invocation. Hosted upstream behavior keeps its existing billing path.

The browser app serves its documents, assets, the signed-in report viewer at `/r/<id>`, and server functions. Every other raw route stays closed in self-host mode: the in-app agent at `/agents/*`, public report snapshots at `/s/*`, the AI-visibility download, OAuth callbacks, billing webhooks, and every other `/api/*` path. Scheduled execution does not run outside hosted mode.

Server functions pass a second allowlist, `pilotServerFunctionAllowed`, keyed by source file and function name. The pilot serves keyword research, Google results (SERP analysis), saved keywords and their metric refresh, project list and general settings, project context, reports and report templates, and free location lookups. Everything else refuses with `RESEARCH_UNAVAILABLE` before it runs: site audits, rank tracking, AI visibility, prompt research and the prompt explorer, brand lookup, backlinks, domain overview, Search Console and Analytics connections, IndexNow, billing and credits, the in-app agent, report sharing, website setup research, onboarding, and team management. Saving a project website starts no site audit in self-host mode.

Every project-scoped server function and the report viewer recheck the project's client mapping, as MCP tools do. A project without a mapping, or whose domain no longer matches it, refuses with `PROJECT_NOT_LINKED`, and the browser shows a short notice instead of the project. The browser refuses a domain change on a linked project, because it would leave the project unlinked until an operator reviews it.

Paid research inside an allowed server function goes through the same ledger as MCP. Ledger refusals (operation off, budget reached, spending paused) surface as `RESEARCH_UNAVAILABLE`, and the ledger's reason stays in the message MCP agents see. The browser's keyword ideas use DataForSEO Labs related, suggestions, and ideas endpoints, which are not pilot operations, so a keyword search in the browser shows the unavailable notice. Google results and saved-keyword metrics use `serp.organic` and `keywords.overview`. The upstream browser has no Maps grid or business profile page, so local research stays in MCP. Website research for project setup runs outside the ledger (site reads, the model, and live searches), so it refuses in self-host mode before any fetch.

The browser reads one server flag, `getResearchPilotStatus`, to hide the navigation, dashboard cards, billing link, Search Console prompts, and settings tabs for features the pilot does not serve. A project opens on a short pilot dashboard that links to the available pages. A hidden page reached by URL shows a plain notice.

The pilot supports four paid provider operations: `keywords.overview`, `serp.organic`, `maps.grid`, and `business.profile`. Each operation is disabled until it appears in `ORSIN_ENABLED_OPERATIONS`. Keyword metrics that require the Google Ads fallback are unavailable in this increment. Maps targets require an exact `cid` or `placeId`; omit the name fallback.

`GET /ops` is a read-only operator page behind Cloudflare Access. The worker verifies the Access JWT the same way the maintenance route does and returns 401 without it; hosted mode never serves it. The page shows monthly and daily spend against their limits, held funds, and the pause state; spend by client and operation for the current UTC month; daily spend for the last 30 days; unsettled holds with their age; and the last 50 operator interventions. It renders server-side with no client script, shows dollars to four decimals, and sets `Cache-Control: no-store`. It changes nothing; recovery still goes through the maintenance route.

Four MCP tools manage discovery and review: `bind_client_project`, `resolve_client_project`, `get_spending_status`, and `estimate_research_cost`. The estimate previews provider cost using the dispatch estimators. It neither reserves money nor overrides policy. Retain the same parameters in the actual research call.

## Spending policy

`ORSIN_MAX_CALL_USD`, `ORSIN_DAILY_USD`, and `ORSIN_MONTHLY_USD` default to zero. Values are nonnegative decimal USD with at most six decimal places. No budget is set by this implementation. Periods follow UTC. The call limit covers one provider dispatch, including all points in one queued Maps batch.

One SQLite-backed Durable Object coordinates the deployment's DataForSEO account. It stores normalized client mappings and reservations. Both the MCP guard and the provider client check project identity. A synchronous SQL transaction reserves the estimated raw provider cost before dispatch. Concurrent calls share the same account budget. Unsettled reservations count against both period limits, including after restarts and period boundaries.

A definitive provider cost settles the reservation. A definitive billed failure also settles its known cost, including a billed SERP payload that fails result validation. The HTTP transport never retries self-host POST requests after a server error; free GET collection retains its retry policy. A timeout, invalid cost metadata, or interrupted settlement retains the reservation. Unknown outcomes never cause an automatic refund or automatic paid retry. Retrying a settled reservation is idempotent only when the cost matches. A repeated reservation ID refuses dispatch.

Estimates are not a provider-side spending guarantee. If a real bill exceeds its estimate, the ledger records the full cost and pauses subsequent research. Investigate pricing and reconcile unknown outcomes against provider evidence before operator maintenance. This increment deliberately has no agent tool to reset budgets, release unknown holds, unpause spending, or overwrite mappings.

Recovery is an operator action outside MCP. `POST /api/orsin/maintenance` requires two things: the Cloudflare Access identity in front of the worker (a login admitted by the Access application, or a service token the application's Service Auth policy admits) and the `x-orsin-maintenance-secret` header matching `ORSIN_MAINTENANCE_SECRET`. The secret is compared in constant time. An unset or empty secret disables the route, hosted mode never serves it, and `AUTH_MODE=local_noauth` attributes the action to the local admin. The JSON body is one of `{"action":"list"}`, which returns the spending status and every unsettled reservation; `{"action":"release","id":"<reservation>","reason":"<why>"}`, which settles one unsettled reservation at zero; or `{"action":"unpause","reason":"<why>"}`, which clears the pause. Releasing a settled reservation and unpausing an unpaused ledger both refuse. Each intervention writes a `ledger_events` row with the actor, reason, and UTC timestamp. A release refunds nothing on the provider side and budgets and mappings still change only through a deploy.

Run `pnpm orsin:ledger <origin> list`, `pnpm orsin:ledger <origin> release <id> --reason "<why>"`, or `pnpm orsin:ledger <origin> unpause --reason "<why>"` with `ORSIN_MAINTENANCE_SECRET`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET` in the environment. The script takes no secret on the command line.

Existing Maps receipt caching still collects previously submitted tasks without another charge when the receipt is available. It is not an exactly-once provider guarantee: a lost receipt or simultaneous identical tool calls can buy duplicate research within the overall budget. Review unknown outcomes before repeating a request.

## Client mapping

`ORSIN_CLIENT_DIRECTORY` is a reviewed deployment configuration projection with this shape:

```json
{
  "schemaVersion": 1,
  "clients": [{ "clientRef": "demo-client", "domain": "example.com" }]
}
```

The directory contains no project IDs, private prose, provider account IDs, or credentials. The normalized mapping table binds one `(organization, client_ref)` to one project and domain. Bindings require owner/admin permission and an exact match to the directory and the authorized active project's normalized domain. Identical bindings are safe to repeat. Conflicting bindings require operator review rather than silent reassignment. Research and saved/cached project reads recheck the domain and directory so a changed or removed client does not retain access through an old mapping.

The export script reads only explicitly selected active/internal SEO clients from Shelled's canonical registry and their Website fields. It refuses ambiguous websites, duplicate identities, and context paths outside the vault. It does not read the derived service manifest or export private client prose.

Run the exporter locally, inspect its output, and put the approved projection in the ignored self-host environment file. Use exact canonical client references. Do not commit the exported client roster or environment file.

## Verification

Unit tests use real SQLite for the ledger, including period boundaries, overrun pauses, mapping conflicts, and concurrent reservations. Service tests verify that refused reservations prevent provider calls and that ambiguous outcomes retain holds. A Miniflare test runs the actual Durable Object over RPC, races reservations, restarts the Worker, checks persisted settlement, and releases a retained hold. The maintenance route test covers the hosted refusal, the disabled-until-configured secret, the wrong-secret refusal, and the operator identity recorded with each action. Policy tests cover the browser path gate and the server-function allowlist. Service tests cover the browser mapping refusal, the domain-change refusal, website research refusing before any fetch, and saving a website without starting an audit. No test requires client credentials or paid provider calls.

The binding file is generated with `cf-typegen`; the upstream runtime declarations remain separate to avoid unrelated runtime-type changes. The existing D1/Postgres product schemas are unchanged.

## Before a deployment review

Choose and review the pilot client, exact business identifiers, directory projection, enabled operations, and budget. Review separate Cloudflare resource names and Access configuration. Test both agent connections after an approved deployment. The shipped upstream plugin still points at hosted OpenSEO; do not install it as an Orsin connection until its endpoint is retargeted. Firecrawl, browser keyword ideas, a browser local research view, public report snapshots, and a dashboard merger remain later increments.
