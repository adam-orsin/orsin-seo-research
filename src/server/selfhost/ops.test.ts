import { beforeEach, expect, it, vi } from "vitest";
import { handleOrsinOpsRequest } from "./ops";

const mocks = vi.hoisted(() => ({
  verifyAccess: vi.fn(),
  summary: vi.fn(),
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  verifyCloudflareAccessToken: mocks.verifyAccess,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: vi.fn(),
}));

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the handler reads
const env = {
  ORSIN_CONTROL: { getByName: () => ({ summary: mocks.summary }) },
} as unknown as Env;
const request = () => new Request("https://selfhost.test/ops");
beforeEach(() => {
  mocks.verifyAccess.mockResolvedValue({ email: "adam@orsin.io" });
  mocks.summary.mockResolvedValue({
    asOf: "2026-10-21T12:00:00.000Z",
    status: {
      held: 0,
      dailySpent: 70_000,
      monthlySpent: 70_000,
      paused: false,
      limits: { daily: 2_000_000, monthly: 25_000_000 },
    },
    days: [{ day: "2026-10-21", calls: 2, spent: 70_000 }],
    byClient: [
      {
        clientRef: "demo-client",
        operation: "serp.organic",
        calls: 2,
        spent: 70_000,
        held: 0,
      },
    ],
    holds: [],
    events: [],
  });
});

it("never serves hosted mode", async () => {
  const response = await handleOrsinOpsRequest(request(), "hosted", env);
  expect(response.status).toBe(404);
  expect(mocks.summary).not.toHaveBeenCalled();
});
it("refuses a request without a valid Cloudflare Access token", async () => {
  mocks.verifyAccess.mockRejectedValue(new Error("missing token"));
  const response = await handleOrsinOpsRequest(
    request(),
    "cloudflare_access",
    env,
  );
  expect(response.status).toBe(401);
  expect(mocks.summary).not.toHaveBeenCalled();
});
it("renders client spend in dollars and is never cached", async () => {
  const response = await handleOrsinOpsRequest(
    request(),
    "cloudflare_access",
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  expect(html).toContain("demo-client");
  expect(html).toContain("$0.0700");
});
