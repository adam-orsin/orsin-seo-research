import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildClientDirectory } from "./orsin-client-directory";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "orsin-directory-"));
  mkdirSync(join(vault, "clients/_config"), { recursive: true });
  mkdirSync(join(vault, "clients/demo-client"), { recursive: true });
  writeFileSync(
    join(vault, "clients/_config/client-registry.yaml"),
    "schema_version: 1\nauthority_status: canonical\nclients:\n  - client_ref: demo-client\n    context_ref: clients/demo-client/context.md\n    lifecycle: active\n    engagements: [seo]\n",
  );
  writeFileSync(
    join(vault, "clients/demo-client/context.md"),
    "**Website:** https://www.example.com/\nPrivate client notes and provider account IDs must not be exported.",
  );
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));
it("exports only the selected canonical client reference and normalized domain", () => {
  expect(buildClientDirectory(vault, ["demo-client"])).toEqual({
    schemaVersion: 1,
    clients: [{ clientRef: "demo-client", domain: "example.com" }],
  });
});
it("refuses empty selections, unknown refs, and duplicate selections", () => {
  for (const refs of [[], ["missing"], ["demo-client", "demo-client"]])
    expect(() => buildClientDirectory(vault, refs)).toThrow();
});
it("refuses an ambiguous website without copying private context to the error", () => {
  writeFileSync(
    join(vault, "clients/demo-client/context.md"),
    "**Website:** https://example.com\n**Website:** https://other.com\nprivate-secret",
  );
  expect(() => buildClientDirectory(vault, ["demo-client"])).toThrow(
    "exactly one Website",
  );
});
