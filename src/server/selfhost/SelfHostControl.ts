import { DurableObject } from "cloudflare:workers";
import { ResearchLedger } from "./ledger";
import { readPolicy } from "./policy";

export class SelfHostControl extends DurableObject<Env> {
  private ledger: ResearchLedger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new ResearchLedger(
      {
        query: (sql, ...bindings) =>
          this.ctx.storage.sql.exec(sql, ...bindings).toArray(),
        transaction: (callback) => this.ctx.storage.transactionSync(callback),
      },
      readPolicy(env),
    );
  }
  bind(input: unknown) {
    return this.ledger.bind(input);
  }
  resolve(organizationId: string, clientRef: string) {
    return this.ledger.resolve(organizationId, clientRef);
  }
  authorizeProject(organizationId: string, projectId: string, domain: string) {
    return this.ledger.authorizeProject(organizationId, projectId, domain);
  }
  reserve(input: unknown) {
    return this.ledger.reserve(input);
  }
  settle(input: unknown) {
    return this.ledger.settle(input);
  }
  status() {
    return this.ledger.status();
  }
}
