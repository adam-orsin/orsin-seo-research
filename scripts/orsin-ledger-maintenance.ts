/**
 * Operator recovery for the self-host research ledger.
 *
 *   pnpm orsin:ledger https://<worker-host> list
 *   pnpm orsin:ledger https://<worker-host> release <reservation-id> --reason "<why>"
 *   pnpm orsin:ledger https://<worker-host> unpause --reason "<why>"
 *
 * Reads from the environment, never from argv:
 *   ORSIN_MAINTENANCE_SECRET  the deployment's maintenance secret
 *   CF_ACCESS_CLIENT_ID       Cloudflare Access service token (omit both for
 *   CF_ACCESS_CLIENT_SECRET   AUTH_MODE=local_noauth)
 *
 * Agents have no equivalent tool. Reconcile the hold against DataForSEO
 * evidence first: a release settles the hold at zero and refunds nothing.
 */
import process from "node:process";
import {
  maintenanceRequestSchema,
  ORSIN_MAINTENANCE_PATH,
  ORSIN_MAINTENANCE_SECRET_HEADER,
} from "../src/server/selfhost/policy";
import { parseArgs, requiredEnv } from "./cli-utils";

function usage(): never {
  throw new Error(
    "Usage: pnpm orsin:ledger <origin> list | release <id> --reason <why> | unpause --reason <why>",
  );
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = parseArgs(process.argv.slice(2));
const [originArg, action, id] = positional;
if (!originArg || !action) usage();

const origin = new URL(originArg);
if (
  origin.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(origin.hostname)
) {
  throw new Error("The deployment origin must use https.");
}

// Validate here with the server's own schema so a typo fails before the
// request leaves this machine.
const body = maintenanceRequestSchema.parse(
  action === "list"
    ? { action }
    : action === "release"
      ? { action, id, reason: flags.reason }
      : action === "unpause"
        ? { action, reason: flags.reason }
        : usage(),
);

const headers = new Headers({
  "content-type": "application/json",
  [ORSIN_MAINTENANCE_SECRET_HEADER]: requiredEnv("ORSIN_MAINTENANCE_SECRET"),
});
const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
if (Boolean(clientId) !== Boolean(clientSecret)) {
  throw new Error(
    "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither for local_noauth.",
  );
}
if (clientId && clientSecret) {
  headers.set("CF-Access-Client-Id", clientId);
  headers.set("CF-Access-Client-Secret", clientSecret);
}

const response = await fetch(new URL(ORSIN_MAINTENANCE_PATH, origin), {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const text = await response.text();
let printed = text;
try {
  printed = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  /* non-JSON refusal (401, 404, 405) prints as-is */
}
console.log(`${response.status} ${response.statusText}\n${printed}`);
if (!response.ok) process.exitCode = 1;
