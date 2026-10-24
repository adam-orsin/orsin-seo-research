import type { ResearchLedger } from "./ledger";
import { resolveOperator } from "./maintenance";
import { SELF_HOST_CONTROL_NAME } from "./policy";

type OpsSummary = ReturnType<ResearchLedger["summary"]>;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dollars(micros: number) {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function age(createdAt: string, asOf: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(asOf) - Date.parse(createdAt)) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} days`;
}

function utc(iso: string) {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function table(headers: string[], rows: string[][], empty: string) {
  if (rows.length === 0) return `<p class="muted">${empty}</p>`;
  const head = headers.map((cell) => `<th>${cell}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--bar:#57534e;--warn:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--bar:#d6d3d1;--warn:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:17px;margin:40px 0 12px}
.muted{color:var(--muted)}
.headline{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:24px}
.headline div{border:1px solid var(--line);border-radius:8px;padding:16px}
.headline strong{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.paused{color:var(--warn)}
.scroll{overflow-x:auto}
table{width:100%;min-width:600px;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted)}
code{font-size:13px}
.bars{display:flex;align-items:flex-end;gap:3px;height:120px;margin:0;padding:0;list-style:none;border-bottom:1px solid var(--line)}
.bars li{flex:1;background:var(--bar);min-height:1px;border-radius:2px 2px 0 0}
.axis{display:flex;justify-content:space-between;font-size:13px}
`;

function renderOpsPage(summary: OpsSummary, operator: string) {
  const { status, asOf } = summary;
  const monthTotal = summary.byClient.reduce((sum, row) => sum + row.spent, 0);
  const peak = Math.max(0, ...summary.days.map((day) => day.spent));
  const pause = status.paused
    ? `<p class="paused"><strong>Research is paused.</strong> A provider bill came in above its estimate, so the ledger refuses new research calls until an operator unpauses it.</p>`
    : `<p>Research is running. New calls go through while they fit the limits below.</p>`;

  const clientRows = summary.byClient.map((row) => [
    escapeHtml(row.clientRef),
    `<code>${escapeHtml(row.operation)}</code>`,
    String(row.calls),
    dollars(row.spent),
    dollars(row.held),
  ]);
  if (clientRows.length > 0) {
    clientRows.push([
      "<strong>Total</strong>",
      "",
      "",
      `<strong>${dollars(monthTotal)}</strong>`,
      "",
    ]);
  }
  const bars = summary.days
    .map((day) => {
      const label = `${day.day}: ${dollars(day.spent)} across ${day.calls} calls`;
      const height = peak ? Math.round((day.spent / peak) * 100) : 0;
      return `<li style="height:${height}%" title="${label}" aria-label="${label}"></li>`;
    })
    .join("");
  const holdRows = summary.holds.map((hold) => [
    escapeHtml(hold.clientRef),
    `<code>${escapeHtml(hold.operation)}</code>`,
    dollars(hold.estimated),
    utc(hold.createdAt),
    age(hold.createdAt, asOf),
    `<code>${escapeHtml(hold.id)}</code>`,
  ]);
  const eventRows = summary.events.map((event) => [
    utc(event.createdAt),
    event.kind === "release" ? "Released a hold" : "Unpaused research",
    escapeHtml(event.actor),
    escapeHtml(event.reason),
    event.reservationId
      ? `<code>${escapeHtml(event.reservationId)}</code>`
      : "",
  ]);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research operations</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Research operations</h1>
<p class="muted">Read-only view of the research ledger as of ${utc(asOf)}. Signed in as ${escapeHtml(operator)}.</p>
<div class="headline">
<div><span class="muted">This month</span><strong>${dollars(status.monthlySpent)}</strong><span class="muted">of ${dollars(status.limits.monthly)} limit</span></div>
<div><span class="muted">Today</span><strong>${dollars(status.dailySpent)}</strong><span class="muted">of ${dollars(status.limits.daily)} limit</span></div>
<div><span class="muted">Held in unsettled calls</span><strong>${dollars(status.held)}</strong><span class="muted">counts against both limits</span></div>
</div>
${pause}
<h2>Spend by client this month</h2>
<div class="scroll">${table(["Client", "Operation", "Calls", "Spent", "Held"], clientRows, "No research calls this month.")}</div>
<h2>Daily spend, last 30 days</h2>
<ol class="bars">${bars}</ol>
<div class="axis muted"><span>${summary.days[0]?.day ?? ""}</span><span>Peak ${dollars(peak)}</span><span>${summary.days.at(-1)?.day ?? ""}</span></div>
<h2>Unsettled holds</h2>
<div class="scroll">${table(["Client", "Operation", "Estimated", "Started", "Age", "Reservation"], holdRows, "No unsettled holds.")}</div>
<h2>Recent operator actions</h2>
<div class="scroll">${table(["When", "Action", "By", "Reason", "Reservation"], eventRows, "No operator actions yet.")}</div>
</main>
</body>
</html>`;
}

// Read-only operator page for the self-host research pilot: spend against the
// limits, spend by client, daily spend, unsettled holds, and the audit trail.
// Cloudflare Access sits in front; the handler verifies its JWT the same way
// the maintenance route does. Hosted mode never serves it.
export async function handleOrsinOpsRequest(
  request: Request,
  authMode: "cloudflare_access" | "local_noauth" | "hosted",
  env: Env,
): Promise<Response> {
  if (authMode === "hosted" || !env.ORSIN_CONTROL) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  let operator: string | null;
  try {
    operator = await resolveOperator(request, authMode);
  } catch (error) {
    console.error("Orsin ops identity check failed:", error);
    operator = null;
  }
  if (!operator) return new Response("Unauthorized", { status: 401 });

  const summary = await env.ORSIN_CONTROL.getByName(
    SELF_HOST_CONTROL_NAME,
  ).summary();
  return new Response(renderOpsPage(summary, operator), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
