import { beforeEach, expect, it, vi } from "vitest";
import {
  assertPilotDomainUnchanged,
  spendSelfHosted,
  authorizePilotTool,
} from "./service";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  authorizeProject: vi.fn(),
  settle: vi.fn(),
  project: vi.fn(),
  waitUntil: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    ORSIN_CONTROL: {
      getByName: () => ({
        reserve: mocks.reserve,
        settle: mocks.settle,
        authorizeProject: mocks.authorizeProject,
      }),
    },
  },
  waitUntil: mocks.waitUntil,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: mocks.project },
}));
const customer = {
  organizationId: "org",
  projectId: "project",
  userId: "user",
  userEmail: "operator@example.com",
};
beforeEach(() => {
  mocks.project.mockResolvedValue({ domain: "example.com" });
  mocks.reserve.mockResolvedValue({ id: "reservation" });
  mocks.settle.mockResolvedValue(undefined);
  mocks.authorizeProject.mockResolvedValue({ clientRef: "demo-client" });
});
it("does not call a provider when the durable reservation is refused", async () => {
  mocks.reserve.mockRejectedValue(new Error("budget exceeded"));
  const provider = vi.fn();
  await expect(
    spendSelfHosted(customer, provider, 0.01, "keywords.overview"),
  ).rejects.toMatchObject({
    code: "RESEARCH_UNAVAILABLE",
    message: "budget exceeded",
  });
  expect(provider).not.toHaveBeenCalled();
});
it("reserves raw USD before dispatch and settles the real provider cost", async () => {
  const provider = vi.fn(async () => {
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        estimated: 10_000,
        domain: "example.com",
        organizationId: "org",
        projectId: "project",
      }),
    );
    return { data: { rows: 3 }, billing: { path: ["test"], costUsd: 0.008 } };
  });
  await expect(
    spendSelfHosted(customer, provider, 0.01, "keywords.overview"),
  ).resolves.toEqual({ rows: 3 });
  expect(mocks.settle).toHaveBeenCalledWith({
    id: "reservation",
    actual: 8_000,
  });
  expect(mocks.waitUntil).toHaveBeenCalled();
});
it("retains a hold for unknown transport outcomes and never retries the provider", async () => {
  const provider = vi.fn().mockRejectedValue(new Error("timeout"));
  await expect(
    spendSelfHosted(customer, provider, 0.01, "serp.organic"),
  ).rejects.toThrow("uncertain");
  expect(provider).toHaveBeenCalledTimes(1);
  expect(mocks.settle).not.toHaveBeenCalled();
});
it("settles a billed provider failure before reporting the error", async () => {
  const provider = vi.fn().mockRejectedValue(
    new DataforseoChargedTaskError("billed failure", {
      path: ["test"],
      costUsd: 0.003,
    }),
  );
  await expect(
    spendSelfHosted(customer, provider, 0.01, "serp.organic"),
  ).rejects.toThrow("billed failure");
  expect(mocks.settle).toHaveBeenCalledWith({
    id: "reservation",
    actual: 3_000,
  });
});
it("does not return successful data when durable settlement fails", async () => {
  mocks.settle.mockRejectedValue(new Error("ledger unavailable"));
  const provider = vi.fn().mockResolvedValue({
    data: [],
    billing: { path: ["test"], costUsd: 0.001 },
  });
  await expect(
    spendSelfHosted(customer, provider, 0.01, "serp.organic"),
  ).rejects.toThrow("settlement is unconfirmed");
  expect(provider).toHaveBeenCalledTimes(1);
});
it("refuses an unsupported operation and an unavailable project before reserving", async () => {
  const provider = vi.fn();
  await expect(spendSelfHosted(customer, provider, 0.01)).rejects.toMatchObject(
    { code: "RESEARCH_UNAVAILABLE" },
  );
  mocks.project.mockResolvedValue(null);
  await expect(
    spendSelfHosted(customer, provider, 0.01, "serp.organic"),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(provider).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
});

const toolContext = {
  auth: {
    organizationId: "org",
    userId: "user",
    userEmail: "operator@example.com",
    role: "owner",
    orgScope: "pinned" as const,
    scopes: [],
    clientId: null,
    baseUrl: "https://local.test",
  },
};
it("checks mapped identity for cached or saved project data before the handler runs", async () => {
  mocks.authorizeProject.mockRejectedValue(new Error("mapping changed"));
  await expect(
    authorizePilotTool("get_report", { projectId: "project" }, toolContext),
  ).rejects.toMatchObject({
    code: "PROJECT_NOT_LINKED",
    message: "mapping changed",
  });
  expect(mocks.authorizeProject).toHaveBeenCalledWith(
    "org",
    "project",
    "example.com",
  );
});
it("blocks unsupported tools and name-based Maps targets before mapping or provider access", async () => {
  await expect(
    authorizePilotTool("run_site_audit", { projectId: "project" }, toolContext),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  for (const target of [
    { name: "Example" },
    { cid: "123", name: "Example" },
    {},
  ])
    await expect(
      authorizePilotTool(
        "get_local_rank_grid",
        { projectId: "project", target },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(mocks.authorizeProject).not.toHaveBeenCalled();
});
it("refuses a domain change on a linked project but accepts the same domain written differently", async () => {
  await expect(
    assertPilotDomainUnchanged("example.com", "https://www.example.com"),
  ).resolves.toBeUndefined();
  for (const next of ["other.com", undefined])
    await expect(
      assertPilotDomainUnchanged("example.com", next),
    ).rejects.toMatchObject({ code: "RESEARCH_UNAVAILABLE" });
});
