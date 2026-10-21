import { beforeEach, expect, it, vi } from "vitest";
import { handleOrsinMaintenanceRequest } from "./maintenance";

const mocks = vi.hoisted(() => ({
  verifyAccess: vi.fn(),
  localContext: vi.fn(),
  listUnsettled: vi.fn(),
  release: vi.fn(),
  unpause: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  verifyCloudflareAccessToken: mocks.verifyAccess,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: mocks.localContext,
}));

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the fields the handler reads
const env = {
  ORSIN_MAINTENANCE_SECRET: "maintenance-secret",
  ORSIN_CONTROL: {
    getByName: () => ({
      listUnsettled: mocks.listUnsettled,
      release: mocks.release,
      unpause: mocks.unpause,
      status: mocks.status,
    }),
  },
} as unknown as Env;
const reservationId = "0b9a3c9e-5a2f-4b5e-9d0e-3c1a2b4d5e6f";
function request(body: unknown, secret = "maintenance-secret") {
  const text = JSON.stringify(body);
  return new Request("https://selfhost.test/api/orsin/maintenance", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
      ...(secret ? { "x-orsin-maintenance-secret": secret } : {}),
    },
    body: text,
  });
}
beforeEach(() => {
  mocks.verifyAccess.mockResolvedValue({ common_name: "ops-service-token" });
  mocks.localContext.mockResolvedValue({ userEmail: "admin@localhost" });
  mocks.release.mockResolvedValue({ id: reservationId });
  mocks.unpause.mockResolvedValue({ paused: false });
  mocks.listUnsettled.mockResolvedValue([]);
  mocks.status.mockResolvedValue({ paused: true, held: 0 });
});

it("never serves hosted mode, even with the right secret and identity", async () => {
  const response = await handleOrsinMaintenanceRequest(
    request({ action: "list" }),
    "hosted",
    env,
  );
  expect(response.status).toBe(404);
  expect(mocks.listUnsettled).not.toHaveBeenCalled();
});
it("is disabled until the deployment sets a maintenance secret", async () => {
  const response = await handleOrsinMaintenanceRequest(
    request({ action: "list" }),
    "cloudflare_access",
    { ...env, ORSIN_MAINTENANCE_SECRET: "  " },
  );
  expect(response.status).toBe(404);
  expect(mocks.listUnsettled).not.toHaveBeenCalled();
});
it("refuses a missing or wrong secret before touching identity or the ledger", async () => {
  for (const secret of ["", "wrong-secret"]) {
    const response = await handleOrsinMaintenanceRequest(
      request({ action: "unpause", reason: "test" }, secret),
      "cloudflare_access",
      env,
    );
    expect(response.status).toBe(401);
  }
  expect(mocks.verifyAccess).not.toHaveBeenCalled();
  expect(mocks.unpause).not.toHaveBeenCalled();
});
it("refuses an Access token that names nobody", async () => {
  mocks.verifyAccess.mockResolvedValue({ sub: "" });
  const response = await handleOrsinMaintenanceRequest(
    request({ action: "unpause", reason: "test" }),
    "cloudflare_access",
    env,
  );
  expect(response.status).toBe(401);
  expect(mocks.unpause).not.toHaveBeenCalled();
});
it("releases one hold with the operator identity and reason recorded", async () => {
  const response = await handleOrsinMaintenanceRequest(
    request({
      action: "release",
      id: reservationId,
      reason: "No charge on the provider dashboard",
    }),
    "cloudflare_access",
    env,
  );
  expect(response.status).toBe(200);
  expect(mocks.release).toHaveBeenCalledWith(
    reservationId,
    "No charge on the provider dashboard",
    "ops-service-token",
  );
});
it("surfaces a ledger refusal to the operator and names the local admin in local mode", async () => {
  mocks.unpause.mockRejectedValue(new Error("Research is not paused."));
  const response = await handleOrsinMaintenanceRequest(
    request({ action: "unpause", reason: "test" }),
    "local_noauth",
    env,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Research is not paused." });
  expect(mocks.unpause).toHaveBeenCalledWith("test", "admin@localhost");
});
