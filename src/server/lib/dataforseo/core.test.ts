import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(async () => true),
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
}));

import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  dataforseoGet,
  dataforseoPost,
  dataforseoPostResponse,
} from "@/server/lib/dataforseo/core";

beforeEach(() => {
  vi.mocked(isHostedServerAuthMode).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DataForSEO transport", () => {
  it.each([dataforseoPost, dataforseoPostResponse])(
    "never retries self-host POSTs after an ambiguous HTTP failure",
    async (post) => {
      vi.mocked(isHostedServerAuthMode).mockResolvedValue(false);
      const provider = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("unknown charge", { status: 503 }))
        .mockResolvedValue(Response.json({ status_code: 20000, tasks: [] }));
      vi.stubGlobal("fetch", provider);
      await expect(
        post("/v3/serp/google/organic/live/advanced", []),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );
  it("still retries free self-host GET collection", async () => {
    vi.mocked(isHostedServerAuthMode).mockResolvedValue(false);
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("transient", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", provider);
    await expect(
      dataforseoGet("/v3/serp/google/maps/task_get/advanced/task-id"),
    ).resolves.toMatchObject({ status_code: 20000 });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("retries a transient 5xx on idempotent reads and returns the parsed envelope", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).resolves.toEqual({ status_code: 20000, tasks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Basic encoded-credentials",
    );
  });

  // The request-deadline abort arrives as a bare DOMException. Left unclassified
  // it escapes as an anonymous INTERNAL_ERROR; retrying it would replay a call
  // DataForSEO may already have billed. Both names are reachable: the shared
  // budget aborts with TimeoutError, Lighthouse's own controller with AbortError.
  it.each(["TimeoutError", "AbortError"])(
    "maps a %s abort to UPSTREAM_UNAVAILABLE without retrying",
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("aborted", name));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        dataforseoPost("/v3/serp/google/organic/live/advanced", []),
      ).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        name: "DataForSEOTimeoutError",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
