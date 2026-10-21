import { beforeEach, expect, it, vi } from "vitest";
import {
  bindClientProjectTool,
  resolveClientProjectTool,
  estimateResearchCostTool,
} from "./orsin-controls";
import { makeToolContext } from "./tool-test-support";

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {},
}));
const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  bind: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  hosted: vi.fn(),
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: mocks.project },
}));
vi.mock("@/server/selfhost/service", () => ({
  selfHostControl: () => ({
    bind: mocks.bind,
    resolve: mocks.resolve,
    status: mocks.status,
  }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.hosted,
}));
beforeEach(() => {
  mocks.hosted.mockResolvedValue(false);
  mocks.project.mockResolvedValue({
    id: "project",
    domain: "www.example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.bind.mockResolvedValue({
    clientRef: "demo-client",
    projectId: "project",
    domain: "example.com",
  });
  mocks.resolve.mockResolvedValue({
    clientRef: "demo-client",
    projectId: "project",
    domain: "example.com",
  });
  mocks.status.mockResolvedValue({
    held: 0,
    limits: { maxCall: 0, daily: 0, monthly: 0 },
  });
});
it("requires owner/admin permission before changing a mapping", async () => {
  await expect(
    bindClientProjectTool.handler(
      { projectId: "project", clientRef: "demo-client" },
      makeToolContext({ role: "member" }),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(mocks.bind).not.toHaveBeenCalled();
});
it("binds the authorized organization and normalized project domain", async () => {
  await bindClientProjectTool.handler(
    { projectId: "project", clientRef: "demo-client" },
    makeToolContext(),
  );
  expect(mocks.bind).toHaveBeenCalledWith({
    organizationId: "org_123",
    projectId: "project",
    clientRef: "demo-client",
    domain: "example.com",
  });
});
it("does not resolve a mapping after the project domain changes", async () => {
  mocks.project.mockResolvedValue({ domain: "changed.example.com" });
  await expect(
    resolveClientProjectTool.handler(
      { clientRef: "demo-client" },
      makeToolContext(),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("previews clickstream and grid multipliers without changing the budget", async () => {
  const preview = await estimateResearchCostTool.handler(
    { projectId: "project", research: { operation: "maps.grid", gridSize: 3 } },
    makeToolContext(),
  );
  expect(preview.structuredContent?.estimatedUsd).toBeCloseTo(0.0108, 8);
  const plain = await estimateResearchCostTool.handler(
    {
      projectId: "project",
      research: {
        operation: "keywords.overview",
        keywords: ["test"],
        includeClickstreamData: false,
      },
    },
    makeToolContext(),
  );
  const clickstream = await estimateResearchCostTool.handler(
    {
      projectId: "project",
      research: {
        operation: "keywords.overview",
        keywords: ["test"],
        includeClickstreamData: true,
      },
    },
    makeToolContext(),
  );
  expect(clickstream.structuredContent?.estimatedUsd).toBeCloseTo(
    Number(plain.structuredContent?.estimatedUsd) * 2,
    8,
  );
  expect(mocks.bind).not.toHaveBeenCalled();
});
