import { readFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  directorySchema,
  clientRefSchema,
  domainOf,
} from "../src/server/selfhost/policy";

// Read only an explicitly selected subset. Never export the derived manifest,
// which also contains account IDs and other service configuration.
export function buildClientDirectory(vault: string, clientRefs: string[]) {
  if (clientRefs.length === 0)
    throw new Error("Select at least one exact client reference.");
  const root = realpathSync(vault);
  const registry = z
    .object({
      schema_version: z.literal(1),
      authority_status: z.literal("canonical"),
      clients: z.array(
        z.object({
          client_ref: clientRefSchema,
          context_ref: z.string(),
          lifecycle: z.string(),
          engagements: z.array(z.string()),
        }),
      ),
    })
    .parse(
      parse(
        readFileSync(
          resolve(root, "clients/_config/client-registry.yaml"),
          "utf8",
        ),
      ),
    );
  const clients = clientRefs.map((ref) => {
    clientRefSchema.parse(ref);
    const matches = registry.clients.filter((row) => row.client_ref === ref);
    if (matches.length !== 1)
      throw new Error("Unknown or duplicate canonical client reference.");
    const client = matches[0];
    if (
      !["active", "internal"].includes(client.lifecycle) ||
      !client.engagements.includes("seo")
    )
      throw new Error("Client does not have an active SEO engagement.");
    if (client.context_ref !== `clients/${ref}/context.md`)
      throw new Error("Context path differs from the canonical client path.");
    const path = realpathSync(resolve(root, client.context_ref));
    const child = relative(root, path);
    if (child.startsWith("..") || isAbsolute(child))
      throw new Error("Context path leaves the vault.");
    const text = readFileSync(path, "utf8");
    const websites = [...text.matchAll(/^\*\*Website:\*\*\s*(.+)$/gm)].map(
      (match) => match[1].trim(),
    );
    if (websites.length !== 1)
      throw new Error("Client context needs exactly one Website field.");
    const website =
      websites[0].match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/)?.[1] ??
      websites[0];
    return { clientRef: ref, domain: domainOf(website) };
  });
  return directorySchema.parse({ schemaVersion: 1, clients });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [vault, ...refs] = process.argv.slice(2);
    if (!vault)
      throw new Error(
        "Usage: tsx scripts/orsin-client-directory.ts VAULT CLIENT_REF [CLIENT_REF ...]",
      );
    console.log(JSON.stringify(buildClientDirectory(vault, refs)));
  } catch {
    console.error(
      "Directory export refused. Check the exact client references, canonical registry, active SEO scope, and Website fields. No private context was exported.",
    );
    process.exitCode = 1;
  }
}
