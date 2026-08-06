import { createHash } from "node:crypto";

import type { AiFeatureName, AiProviderName, AiToolProvenance } from "@laces-out/contracts";

/**
 * The cache key for one AI answer.
 *
 * This module defines and proves the key; it does not build the store. The key exists here so
 * the rule it enforces is testable now rather than asserted later:
 *
 *  - Seven dimensions, all mandatory: user, league, feature, provider, model, prompt version, tool
 *    contract version, and a checksum of the deterministic data behind the answer.
 *  - `userId` is a *key* component, not a namespace convention. Two members of the same league with
 *    byte-identical league state still get different entries, because their contexts differ in ways
 *    the league state does not capture (claimed team, private projection sets).
 *  - The output is a digest. A cache key that contained a readable user or league id would leak
 *    those identifiers into every log, metric label, and store browser that ever sees it.
 */
export interface AiCacheKeyInput {
  readonly userId: string;
  readonly leagueId: string;
  readonly feature: AiFeatureName;
  readonly provider: AiProviderName;
  readonly model: string;
  readonly promptVersion: string;
  readonly toolContractVersion: string;
  readonly dataChecksum: string;
}

/**
 * Length-prefix every component rather than joining on a separator.
 *
 * League names, model ids, and member text all reach this function. Any separator a caller picks is
 * a character an attacker can also type, and `["a|b", "c"]` joining to the same string as
 * `["a", "b|c"]` would let one member's entry be aimed at another's slot. Prefixing each component
 * with its own length makes the boundaries unforgeable.
 */
function field(value: string): string {
  return `${value.length}:${value}`;
}

export function aiCacheKey(input: AiCacheKeyInput): string {
  const canonical = [
    field("ai-cache-v1"),
    field(input.userId),
    field(input.leagueId),
    field(input.feature),
    field(input.provider),
    field(input.model),
    field(input.promptVersion),
    field(input.toolContractVersion),
    field(input.dataChecksum),
  ].join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface AiToolProvenanceEntry {
  readonly name: string;
  readonly provenance: AiToolProvenance;
}

/**
 * The `dataChecksum` dimension, derived from every tool result's ADR 0003 provenance.
 *
 * Sorted by tool name so the order the model happened to call tools in does not fragment the cache,
 * and built from the algorithm version plus the input checksum so a recomputation with new inputs
 * can never be served from an entry computed against the old ones. An empty tool list is its own
 * distinct value rather than colliding with "one tool returned nothing".
 */
export function aiToolDataChecksum(entries: readonly AiToolProvenanceEntry[]): string {
  const canonical = [...entries]
    .map(
      (entry) =>
        `${field(entry.name)}${field(entry.provenance.algorithmVersion)}${field(entry.provenance.checksumScope)}${field(entry.provenance.inputChecksum)}`,
    )
    .toSorted()
    .join("");
  return createHash("sha256")
    .update(`ai-tool-data-v1|${entries.length}|${canonical}`, "utf8")
    .digest("hex");
}
