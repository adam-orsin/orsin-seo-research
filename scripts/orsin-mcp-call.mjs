// Calls one MCP tool on the deployed Orsin research pilot through Cloudflare
// Access, using the token cloudflared stored after `cloudflared access login`.
//   node scripts/orsin-mcp-call.mjs <tool> '<json args>'
//   node scripts/orsin-mcp-call.mjs --list
import { execFileSync } from "node:child_process";

const APP =
  process.env.ORSIN_APP_URL ?? "https://open-seo-selfhost.orsin.workers.dev";
const token = execFileSync("cloudflared", ["access", "token", `--app=${APP}`], {
  encoding: "utf8",
}).trim();
if (!token.startsWith("eyJ"))
  throw new Error("No Access token; run: cloudflared access login " + APP);

let sessionId;
let nextId = 1;
async function rpc(method, params, notify = false) {
  const body = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "cf-access-token": token,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  if (notify) return undefined;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()))
      .find((msg) => msg.id === body.id);
    return data;
  }
  return JSON.parse(text);
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "orsin-mcp-call", version: "1.0.0" },
});
await rpc("notifications/initialized", {}, true);

const [tool, rawArgs] = process.argv.slice(2);
if (!tool)
  throw new Error(
    "Usage: node scripts/orsin-mcp-call.mjs <tool> '<json>' | --list",
  );
let result;
if (tool === "--list") {
  result = await rpc("tools/list", {});
  console.log(result.result.tools.map((t) => t.name).join("\n"));
} else {
  result = await rpc("tools/call", {
    name: tool,
    arguments: rawArgs ? JSON.parse(rawArgs) : {},
  });
  if (result.error) {
    console.log("RPC ERROR", JSON.stringify(result.error, null, 2));
    process.exitCode = 1;
  } else {
    const r = result.result;
    for (const item of r.content ?? [])
      if (item.type === "text") console.log(item.text);
    if (r.structuredContent)
      console.log(
        "\nstructured:",
        JSON.stringify(r.structuredContent, null, 2),
      );
    if (r.isError) process.exitCode = 1;
  }
}
