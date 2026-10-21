import { z } from "zod";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mf: Miniflare;
let persistence: string;
let script: string;
const options = () => ({
  modules: true,
  script,
  compatibilityDate: "2025-09-02",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: {
    ORSIN_CONTROL: { className: "SelfHostControl", useSQLite: true },
  },
  durableObjectsPersist: persistence,
  bindings: {
    ORSIN_MAX_CALL_USD: "0.01",
    ORSIN_DAILY_USD: "0.015",
    ORSIN_MONTHLY_USD: "0.02",
    ORSIN_ENABLED_OPERATIONS: "maps.grid",
    ORSIN_CLIENT_DIRECTORY: JSON.stringify({
      schemaVersion: 1,
      clients: [{ clientRef: "demo-client", domain: "example.com" }],
    }),
  },
});
async function rpc(action: string, input: unknown = {}) {
  return mf.dispatchFetch("http://local.test", {
    method: "POST",
    body: JSON.stringify({ action, input }),
  });
}
beforeAll(async () => {
  persistence = mkdtempSync(join(tmpdir(), "orsin-runtime-"));
  const bundle = await build({
    stdin: {
      contents: `
    import {SelfHostControl} from './src/server/selfhost/SelfHostControl';
    export {SelfHostControl};
    export default {async fetch(request, env) {
      const {action,input}=await request.json();
      const actor=env.ORSIN_CONTROL.getByName('dataforseo-account');
      try {
        const result=action==='bind' ? await actor.bind(input)
          : action==='reserve' ? await actor.reserve(input)
          : action==='settle' ? await actor.settle(input)
          : action==='listUnsettled' ? await actor.listUnsettled()
          : action==='release' ? await actor.release(input.id, input.reason, input.actor)
          : await actor.status();
        return Response.json(result??{});
      } catch {return new Response('refused',{status:409});}
    }};
  `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  script = bundle.outputFiles[0].text;
  mf = new Miniflare(options());
  await mf.ready;
}, 30_000);
afterAll(async () => {
  if (mf) await mf.dispose();
  if (persistence) rmSync(persistence, { recursive: true, force: true });
});
it("serializes concurrent RPC reservations and persists budget state across Worker restarts", async () => {
  expect(
    (
      await rpc("bind", {
        organizationId: "org",
        projectId: "project",
        clientRef: "demo-client",
        domain: "example.com",
      })
    ).status,
  ).toBe(200);
  const calls = await Promise.all(
    [1, 2].map(() =>
      rpc("reserve", {
        id: crypto.randomUUID(),
        organizationId: "org",
        projectId: "project",
        domain: "example.com",
        operation: "maps.grid",
        estimated: 10_000,
      }),
    ),
  );
  expect(calls.filter((call) => call.status === 200)).toHaveLength(1);
  expect(calls.filter((call) => call.status === 409)).toHaveLength(1);
  await mf.dispose();
  mf = new Miniflare(options());
  await mf.ready;
  expect(await (await rpc("status")).json()).toMatchObject({
    held: 10_000,
    dailySpent: 0,
  });
  const reservation = z
    .object({ id: z.string() })
    .parse(await calls.find((call) => call.status === 200)!.json());
  expect(
    (await rpc("settle", { id: reservation.id, actual: 8_000 })).status,
  ).toBe(200);
  expect(await (await rpc("status")).json()).toMatchObject({
    held: 0,
    dailySpent: 8_000,
  });
}, 30_000);
it("releases a retained hold over RPC so the next reservation fits the budget", async () => {
  const stuck = z.object({ id: z.string() }).parse(
    await (
      await rpc("reserve", {
        id: crypto.randomUUID(),
        organizationId: "org",
        projectId: "project",
        domain: "example.com",
        operation: "maps.grid",
        estimated: 7_000,
      })
    ).json(),
  );
  expect(await (await rpc("listUnsettled")).json()).toMatchObject([
    { id: stuck.id, estimated: 7_000 },
  ]);
  expect(
    (
      await rpc("release", {
        id: stuck.id,
        reason: "Timed out; provider shows no task",
        actor: "ops",
      })
    ).status,
  ).toBe(200);
  expect(
    (await rpc("release", { id: stuck.id, reason: "x", actor: "ops" })).status,
  ).toBe(409);
  expect(await (await rpc("status")).json()).toMatchObject({
    held: 0,
    dailySpent: 8_000,
  });
}, 30_000);
