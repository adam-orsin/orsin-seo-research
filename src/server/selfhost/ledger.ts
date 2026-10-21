import {
  clientRefSchema,
  domainOf,
  operationSchema,
  type ResearchPolicy,
} from "./policy";
import { z } from "zod";

type Value = string | number | null;
export interface LedgerStorage {
  query(sql: string, ...bindings: Value[]): Record<string, unknown>[];
  transaction<T>(callback: () => T): T;
}
const identity = {
  organizationId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
};
const bindingSchema = z
  .object({
    ...identity,
    clientRef: clientRefSchema,
    domain: z.string().transform(domainOf),
  })
  .strict();
const reserveSchema = z
  .object({
    ...identity,
    id: z.string().uuid(),
    operation: operationSchema,
    domain: z.string().transform(domainOf),
    estimated: z.number().int().positive().max(1e12),
  })
  .strict();
const settlementSchema = z
  .object({
    id: z.string().uuid(),
    actual: z.number().int().nonnegative().max(1e12),
  })
  .strict();

// One ledger per deployment/provider account. Client mappings and holds are
// normalized SQL rows; no application data is moved out of D1/Postgres.
export class ResearchLedger {
  constructor(
    private store: LedgerStorage,
    private policy: ResearchPolicy,
  ) {
    store.query(`CREATE TABLE IF NOT EXISTS client_mappings (
      organization_id TEXT NOT NULL, client_ref TEXT NOT NULL, project_id TEXT NOT NULL,
      domain TEXT NOT NULL, PRIMARY KEY (organization_id, client_ref), UNIQUE (organization_id, project_id))`);
    store.query(`CREATE TABLE IF NOT EXISTS spend_reservations (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      client_ref TEXT NOT NULL, operation TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
      estimated INTEGER NOT NULL, actual INTEGER, created_at TEXT NOT NULL)`);
    store.query(
      `CREATE INDEX IF NOT EXISTS spend_reservations_period ON spend_reservations(month, day)`,
    );
    store.query(
      `CREATE TABLE IF NOT EXISTS spend_state (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL)`,
    );
    store.query(`INSERT OR IGNORE INTO spend_state(id, paused) VALUES (1, 0)`);
  }

  bind(input: unknown) {
    const value = bindingSchema.parse(input);
    this.requireDirectory(value.clientRef, value.domain);
    return this.store.transaction(() => {
      const rows = this.store.query(
        `SELECT * FROM client_mappings WHERE organization_id = ? AND (client_ref = ? OR project_id = ?)`,
        value.organizationId,
        value.clientRef,
        value.projectId,
      );
      if (
        rows.some(
          (row) =>
            row.client_ref !== value.clientRef ||
            row.project_id !== value.projectId ||
            row.domain !== value.domain,
        )
      ) {
        throw new Error(
          "Mapping conflict. Existing bindings cannot be overwritten by an agent.",
        );
      }
      this.store.query(
        `INSERT OR IGNORE INTO client_mappings (organization_id, client_ref, project_id, domain) VALUES (?, ?, ?, ?)`,
        value.organizationId,
        value.clientRef,
        value.projectId,
        value.domain,
      );
      return value;
    });
  }

  resolve(organizationId: string, clientRef: string) {
    clientRefSchema.parse(clientRef);
    const row = this.store.query(
      `SELECT project_id, domain FROM client_mappings WHERE organization_id = ? AND client_ref = ?`,
      organizationId,
      clientRef,
    )[0];
    if (!row) throw new Error("Client is not mapped in this organization.");
    this.requireDirectory(clientRef, String(row.domain));
    return {
      clientRef,
      projectId: String(row.project_id),
      domain: String(row.domain),
    };
  }

  authorizeProject(organizationId: string, projectId: string, domain: string) {
    const row = this.store.query(
      `SELECT client_ref, domain FROM client_mappings WHERE organization_id = ? AND project_id = ?`,
      organizationId,
      projectId,
    )[0];
    if (!row || row.domain !== domainOf(domain))
      throw new Error("Project mapping missing or domain changed.");
    this.requireDirectory(String(row.client_ref), String(row.domain));
    return {
      clientRef: String(row.client_ref),
      projectId,
      domain: String(row.domain),
    };
  }

  reserve(input: unknown) {
    const value = reserveSchema.parse(input);
    if (!this.policy.operations.includes(value.operation))
      throw new Error("Research operation is disabled.");
    return this.store.transaction(() => {
      const mapping = this.authorizeProject(
        value.organizationId,
        value.projectId,
        value.domain,
      );
      if (
        this.store.query(
          "SELECT id FROM spend_reservations WHERE id = ?",
          value.id,
        ).length
      )
        throw new Error("Reservation already exists; do not dispatch again.");
      const snapshot = this.status();
      if (
        snapshot.paused ||
        value.estimated > this.policy.maxCall ||
        snapshot.dailySpent + snapshot.held + value.estimated >
          this.policy.daily ||
        snapshot.monthlySpent + snapshot.held + value.estimated >
          this.policy.monthly
      ) {
        throw new Error("Research budget exceeded or disabled.");
      }
      const now = new Date().toISOString();
      this.store.query(
        `INSERT INTO spend_reservations (id, organization_id, project_id, client_ref, operation, day, month, estimated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.id,
        value.organizationId,
        value.projectId,
        mapping.clientRef,
        value.operation,
        now.slice(0, 10),
        now.slice(0, 7),
        value.estimated,
        now,
      );
      return {
        id: value.id,
        clientRef: mapping.clientRef,
        estimated: value.estimated,
      };
    });
  }

  settle(input: unknown) {
    const { id, actual } = settlementSchema.parse(input);
    return this.store.transaction(() => {
      const row = this.store.query(
        "SELECT estimated, actual FROM spend_reservations WHERE id = ?",
        id,
      )[0];
      if (!row) throw new Error("Unknown reservation.");
      if (row.actual !== null) {
        if (row.actual !== actual) throw new Error("Conflicting settlement.");
        return;
      }
      this.store.query(
        "UPDATE spend_reservations SET actual = ? WHERE id = ? AND actual IS NULL",
        actual,
        id,
      );
      // Provider prices are estimates. Record the full real bill and stop
      // later calls if a price exceeds its reservation. Never hide an overrun.
      if (actual > Number(row.estimated))
        this.store.query("UPDATE spend_state SET paused = 1 WHERE id = 1");
    });
  }

  status() {
    const now = new Date().toISOString();
    const row = this.store.query(
      `SELECT
      COALESCE(SUM(CASE WHEN actual IS NULL THEN estimated ELSE 0 END),0) AS held,
      COALESCE(SUM(CASE WHEN day = ? THEN actual ELSE 0 END),0) AS daily_spent,
      COALESCE(SUM(CASE WHEN month = ? THEN actual ELSE 0 END),0) AS monthly_spent
      FROM spend_reservations`,
      now.slice(0, 10),
      now.slice(0, 7),
    )[0];
    return {
      unit: "usd_micros" as const,
      period: "UTC",
      held: Number(row.held),
      dailySpent: Number(row.daily_spent),
      monthlySpent: Number(row.monthly_spent),
      paused: Boolean(
        this.store.query("SELECT paused FROM spend_state WHERE id = 1")[0]
          .paused,
      ),
      limits: {
        maxCall: this.policy.maxCall,
        daily: this.policy.daily,
        monthly: this.policy.monthly,
      },
      operations: this.policy.operations,
    };
  }

  private requireDirectory(clientRef: string, domain: string) {
    if (
      !this.policy.directory.clients.some(
        (client) => client.clientRef === clientRef && client.domain === domain,
      )
    ) {
      throw new Error(
        "Client reference and domain do not match the reviewed directory.",
      );
    }
  }
}
