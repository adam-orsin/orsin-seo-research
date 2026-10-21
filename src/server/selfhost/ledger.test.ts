import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchLedger, type LedgerStorage } from "./ledger";
import {
  readPolicy,
  domainOf,
  directorySchema,
  usdToMicros,
  pilotPathAllowed,
} from "./policy";

let db: DatabaseSync;
let store: LedgerStorage;
let ledger: ResearchLedger;
const config = {
  ORSIN_MAX_CALL_USD: "0.1",
  ORSIN_DAILY_USD: "0.15",
  ORSIN_MONTHLY_USD: "0.2",
  ORSIN_ENABLED_OPERATIONS:
    "keywords.overview,serp.organic,maps.grid,business.profile",
  ORSIN_CLIENT_DIRECTORY: JSON.stringify({
    schemaVersion: 1,
    clients: [
      { clientRef: "demo-client", domain: "example.com" },
      { clientRef: "other-client", domain: "other.example.com" },
    ],
  }),
};
const mapping = {
  organizationId: "org",
  projectId: "project",
  clientRef: "demo-client",
  domain: "https://www.example.com/",
};
function reservation(estimated = 100_000) {
  return {
    id: crypto.randomUUID(),
    organizationId: "org",
    projectId: "project",
    domain: "example.com",
    operation: "keywords.overview",
    estimated,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  db = new DatabaseSync(":memory:");
  store = {
    query: (sql, ...values) => db.prepare(sql).all(...values),
    transaction: (callback) => {
      db.exec("BEGIN");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  ledger = new ResearchLedger(store, readPolicy(config));
  ledger.bind(mapping);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("self-host spending and client routing", () => {
  it("defaults to zero spending and refuses unpriced or disabled operations", () => {
    const closed = new ResearchLedger(
      store,
      readPolicy({
        ...config,
        ORSIN_MAX_CALL_USD: "0",
        ORSIN_ENABLED_OPERATIONS: "",
      }),
    );
    expect(() => closed.reserve(reservation())).toThrow("disabled");
    expect(() =>
      ledger.reserve({ ...reservation(), estimated: NaN }),
    ).toThrow();
    expect(() => ledger.reserve({ ...reservation(), estimated: 0 })).toThrow();
  });
  it("counts an outstanding hold before another call can reserve funds", async () => {
    const results = await Promise.allSettled(
      [1, 2].map(async () => ledger.reserve(reservation())),
    );
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(ledger.status().held).toBe(100_000);
  });
  it("enforces the individual call ceiling independently of daily funds", () => {
    expect(() => ledger.reserve(reservation(100_001))).toThrow("budget");
    expect(ledger.status().held).toBe(0);
  });
  it("settles the actual cost and refuses a conflicting repeated settlement", () => {
    const { id } = ledger.reserve(reservation());
    ledger.settle({ id, actual: 50_000 });
    ledger.settle({ id, actual: 50_000 });
    expect(ledger.status()).toMatchObject({ held: 0, dailySpent: 50_000 });
    expect(() => ledger.settle({ id, actual: 0 })).toThrow("Conflicting");
    ledger.reserve(reservation());
    expect(() => ledger.reserve(reservation(1))).toThrow("budget");
  });
  it("does not dispatch twice for a repeated reservation identifier", () => {
    const request = reservation();
    ledger.reserve(request);
    expect(() => ledger.reserve(request)).toThrow("already exists");
    expect(ledger.status().held).toBe(100_000);
  });
  it("keeps uncertain holds across restarts and UTC month boundaries", () => {
    ledger.reserve(reservation());
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const restarted = new ResearchLedger(store, readPolicy(config));
    expect(restarted.status()).toMatchObject({
      held: 100_000,
      monthlySpent: 0,
    });
    expect(() => restarted.reserve(reservation())).toThrow("budget");
  });
  it("enforces monthly spend across days", () => {
    const first = ledger.reserve(reservation());
    ledger.settle({ id: first.id, actual: 100_000 });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const second = ledger.reserve(reservation());
    ledger.settle({ id: second.id, actual: 100_000 });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    expect(() => ledger.reserve(reservation(1))).toThrow("budget");
  });
  it("records a provider overrun in full and pauses later research", () => {
    const { id } = ledger.reserve(reservation(10_000));
    ledger.settle({ id, actual: 12_000 });
    expect(ledger.status()).toMatchObject({
      dailySpent: 12_000,
      held: 0,
      paused: true,
    });
    expect(() => ledger.reserve(reservation(1))).toThrow("budget");
  });
  it("does not treat float noise between an estimate and the provider bill as an overrun", () => {
    const { id } = ledger.reserve(
      reservation(usdToMicros(0.012 + 162 * 0.00012)),
    );
    // The literal is what JSON.parse yields from a provider "cost": 0.03144.
    ledger.settle({ id, actual: usdToMicros(0.03144) });
    expect(ledger.status()).toMatchObject({
      paused: false,
      dailySpent: 31_440,
    });
  });
  it("releases a stuck hold at zero so the budget frees up, and refuses a second release", () => {
    const stuck = ledger.reserve(reservation());
    expect(() => ledger.reserve(reservation())).toThrow("budget");
    expect(ledger.listUnsettled()).toMatchObject([
      { id: stuck.id, clientRef: "demo-client", estimated: 100_000 },
    ]);
    ledger.release(stuck.id, "No charge on the provider dashboard", "ops");
    expect(ledger.status()).toMatchObject({ held: 0, dailySpent: 0 });
    expect(ledger.listUnsettled()).toEqual([]);
    ledger.reserve(reservation());
    expect(() => ledger.release(stuck.id, "again", "ops")).toThrow(
      "already settled",
    );
    expect(() => ledger.release(crypto.randomUUID(), "x", "ops")).toThrow(
      "Unknown",
    );
    expect(
      store.query(
        "SELECT kind, reservation_id, actor, reason FROM ledger_events",
      ),
    ).toEqual([
      {
        kind: "release",
        reservation_id: stuck.id,
        actor: "ops",
        reason: "No charge on the provider dashboard",
      },
    ]);
  });
  it("unpauses after an overrun with a recorded reason and refuses when not paused", () => {
    const { id } = ledger.reserve(reservation(10_000));
    ledger.settle({ id, actual: 12_000 });
    expect(() => ledger.reserve(reservation(1))).toThrow("budget");
    ledger.unpause("Price list corrected", "ops");
    expect(ledger.status().paused).toBe(false);
    ledger.reserve(reservation(1));
    expect(() => ledger.unpause("again", "ops")).toThrow("not paused");
    expect(
      store.query(
        "SELECT kind, reservation_id, actor, reason FROM ledger_events",
      ),
    ).toEqual([
      {
        kind: "unpause",
        reservation_id: null,
        actor: "ops",
        reason: "Price list corrected",
      },
    ]);
  });
  it("matches exact client references, domains, and organization scope", () => {
    expect(ledger.bind(mapping)).toMatchObject({ domain: "example.com" });
    expect(ledger.resolve("org", "demo-client").projectId).toBe("project");
    expect(() => ledger.resolve("foreign-org", "demo-client")).toThrow(
      "not mapped",
    );
    expect(() =>
      ledger.bind({ ...mapping, projectId: "other-project" }),
    ).toThrow("conflict");
    expect(() =>
      ledger.bind({
        ...mapping,
        clientRef: "other-client",
        domain: "other.example.com",
      }),
    ).toThrow("conflict");
    expect(() =>
      ledger.reserve({ ...reservation(), domain: "changed.example.com" }),
    ).toThrow("domain changed");
    expect(() => ledger.bind({ ...mapping, clientRef: "invented" })).toThrow(
      "reviewed directory",
    );
  });
  it("refuses a mapping when the canonical directory no longer includes it", () => {
    const changed = new ResearchLedger(
      store,
      readPolicy({
        ...config,
        ORSIN_CLIENT_DIRECTORY: '{"schemaVersion":1,"clients":[]}',
      }),
    );
    expect(() => changed.resolve("org", "demo-client")).toThrow(
      "reviewed directory",
    );
    expect(() => changed.reserve(reservation())).toThrow("reviewed directory");
  });
  it("validates configuration and rounds tiny provider costs upward", () => {
    for (const bad of ["NaN", "-1", "0.0000001", "1e2", "Infinity"])
      expect(() => readPolicy({ ...config, ORSIN_DAILY_USD: bad })).toThrow();
    expect(usdToMicros(0.0000001)).toBe(1);
    expect(() => domainOf("https://example.com@evil.com/")).toThrow();
    expect(() =>
      directorySchema.parse({
        schemaVersion: 1,
        clients: [
          { clientRef: "a", domain: "example.com" },
          { clientRef: "b", domain: "www.example.com" },
        ],
      }),
    ).toThrow();
    expect(pilotPathAllowed("/mcp")).toBe(true);
    expect(pilotPathAllowed("/api/orsin/maintenance")).toBe(true);
    for (const path of [
      "/_server/action",
      "/api/ai-visibility/download",
      "/agents/sam",
      "/mcp/../api",
      "/",
    ])
      expect(pilotPathAllowed(path)).toBe(false);
  });
});
