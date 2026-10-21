# Orsin research pilot

This fork provides a separate MCP research service. Deployment is not approved. It does not change `seo.orsin.io` or write to the Shelled vault.

## First increment

Self-host mode exposes `/mcp` and `/api/health`. Browser pages, server functions, in-app agents, public reports, site audits, and scheduled execution are blocked. MCP tools outside the pilot allowlist refuse invocation. Hosted upstream behavior keeps its existing billing path.

The pilot supports four paid provider operations: `keywords.overview`, `serp.organic`, `maps.grid`, and `business.profile`. Each operation is disabled until it appears in `ORSIN_ENABLED_OPERATIONS`. Keyword metrics that require the Google Ads fallback are unavailable in this increment. Maps targets require an exact `cid` or `placeId`; omit the name fallback.

Four MCP tools manage discovery and review: `bind_client_project`, `resolve_client_project`, `get_spending_status`, and `estimate_research_cost`. The estimate previews provider cost using the dispatch estimators. It neither reserves money nor overrides policy. Retain the same parameters in the actual research call.

## Spending policy

`ORSIN_MAX_CALL_USD`, `ORSIN_DAILY_USD`, and `ORSIN_MONTHLY_USD` default to zero. Values are nonnegative decimal USD with at most six decimal places. No budget is set by this implementation. Periods follow UTC. The call limit covers one provider dispatch, including all points in one queued Maps batch.

One SQLite-backed Durable Object coordinates the deployment's DataForSEO account. It stores normalized client mappings and reservations. Both the MCP guard and the provider client check project identity. A synchronous SQL transaction reserves the estimated raw provider cost before dispatch. Concurrent calls share the same account budget. Unsettled reservations count against both period limits, including after restarts and period boundaries.

A definitive provider cost settles the reservation. A definitive billed failure also settles its known cost. A timeout, invalid cost metadata, or interrupted settlement retains the reservation. Unknown outcomes never cause an automatic refund or automatic paid retry. Retrying a settled reservation is idempotent only when the cost matches. A repeated reservation ID refuses dispatch.

Estimates are not a provider-side spending guarantee. If a real bill exceeds its estimate, the ledger records the full cost and pauses subsequent research. Investigate pricing and reconcile unknown outcomes against provider evidence before operator maintenance. This increment deliberately has no agent tool to reset budgets, release unknown holds, unpause spending, or overwrite mappings.

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

Unit tests use real SQLite for the ledger, including period boundaries, overrun pauses, mapping conflicts, and concurrent reservations. Service tests verify that refused reservations prevent provider calls and that ambiguous outcomes retain holds. A Miniflare test runs the actual Durable Object over RPC, races reservations, restarts the Worker, and checks persisted settlement. No test requires client credentials or paid provider calls.

The binding file is generated with `cf-typegen`; the upstream runtime declarations remain separate to avoid unrelated runtime-type changes. The existing D1/Postgres product schemas are unchanged.

## Before a deployment review

Choose and review the pilot client, exact business identifiers, directory projection, enabled operations, and budget. Review separate Cloudflare resource names and Access configuration. Test both agent connections after an approved deployment. The shipped upstream plugin still points at hosted OpenSEO; do not install it as an Orsin connection until its endpoint is retargeted. Firecrawl, a browser interface, public report snapshots, and a dashboard merger remain later increments.
