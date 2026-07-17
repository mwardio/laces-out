import { parseEspnManualImport } from "@fantasy/connector-espn";
import type { LeagueSyncBundle } from "@fantasy/connectors";

import type {
  DrizzleEspnSyncPersistence,
  PersistEspnSyncInput,
  PersistEspnSyncReceipt,
} from "./espn-sync-persistence.js";

export interface EspnManualImportRepository {
  persist(input: PersistEspnSyncInput): Promise<PersistEspnSyncReceipt>;
}

export interface EspnManualImportProvenance {
  readonly mode: "manual-import";
  readonly fetchedAt: string;
  readonly endpoint: null;
  readonly artifactChecksumSha256: string;
  /** Signed age at the moment of this response. Negative values indicate a future timestamp. */
  readonly ageSeconds: number;
}

export interface EspnManualImportPreview {
  readonly valid: true;
  readonly league: {
    readonly externalId: string;
    readonly name: string;
    readonly season: number;
    readonly teamCount: number;
    readonly draftType: "snake" | "auction" | "offline" | "unknown";
  };
  readonly provenance: EspnManualImportProvenance;
  readonly validatedAt: string;
  readonly warnings: readonly string[];
}

export interface EspnManualImportCommitReceipt {
  readonly receiptId: string;
  readonly state: "accepted" | "unchanged";
  readonly league: EspnManualImportPreview["league"] & {
    readonly id: string;
    readonly leagueSeasonId: string;
  };
  readonly provenance: EspnManualImportProvenance;
  readonly committedAt: string;
  readonly recordsWritten: number;
  readonly warnings: readonly string[];
}

export class EspnManualImportRequestError extends Error {
  readonly code: "PREVIEW_MISMATCH";
  readonly statusCode = 409;

  constructor() {
    super("The ESPN snapshot changed after validation; validate the current JSON again");
    this.name = "EspnManualImportRequestError";
    this.code = "PREVIEW_MISMATCH";
  }
}

export class EspnManualImportFreshnessError extends Error {
  readonly code = "FUTURE_SNAPSHOT";
  readonly statusCode = 400;

  constructor() {
    super("The ESPN snapshot timestamp is more than five minutes in the future");
    this.name = "EspnManualImportFreshnessError";
  }
}

const maximumFutureSkewMs = 5 * 60 * 1_000;

function provenance(bundle: LeagueSyncBundle, observedAt: Date): EspnManualImportProvenance {
  const checksum = bundle.provenance.artifactChecksumSha256;
  if (bundle.provenance.mode !== "manual-import" || !checksum) {
    throw new Error("ESPN manual import is missing canonical provenance");
  }
  const fetchedAt = new Date(bundle.provenance.fetchedAt);
  if (fetchedAt.getTime() - observedAt.getTime() > maximumFutureSkewMs) {
    // A future effectiveAt would make this snapshot appear newer than legitimate later syncs.
    throw new EspnManualImportFreshnessError();
  }
  return {
    mode: "manual-import",
    fetchedAt: fetchedAt.toISOString(),
    endpoint: null,
    artifactChecksumSha256: checksum,
    ageSeconds: Math.trunc((observedAt.getTime() - fetchedAt.getTime()) / 1_000),
  };
}

function leagueSummary(bundle: LeagueSyncBundle): EspnManualImportPreview["league"] {
  return {
    externalId: bundle.league.externalId,
    name: bundle.league.name,
    season: bundle.league.season,
    teamCount: bundle.teams.length,
    draftType: bundle.league.settings.draftType,
  };
}

export function previewEspnManualImport(
  snapshot: unknown,
  now: Date = new Date(),
): EspnManualImportPreview {
  const bundle = parseEspnManualImport(snapshot, { now: () => now });
  return {
    valid: true,
    league: leagueSummary(bundle),
    provenance: provenance(bundle, now),
    validatedAt: now.toISOString(),
    warnings: bundle.warnings,
  };
}

export class EspnManualImportService {
  readonly #repository: EspnManualImportRepository;
  readonly #now: () => Date;

  constructor(
    repository: EspnManualImportRepository | DrizzleEspnSyncPersistence,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#now = now;
  }

  preview(snapshot: unknown): EspnManualImportPreview {
    return previewEspnManualImport(snapshot, this.#now());
  }

  async commit(
    actorUserId: string,
    input: { readonly snapshot: unknown; readonly expectedChecksumSha256: string },
  ): Promise<EspnManualImportCommitReceipt> {
    const now = this.#now();
    // Commit always reparses the original strict contract. Preview output is never trusted as
    // persistence input, and the checksum binds the user's confirmation to these exact bytes.
    const bundle = parseEspnManualImport(input.snapshot, { now: () => now });
    const importProvenance = provenance(bundle, now);
    if (importProvenance.artifactChecksumSha256 !== input.expectedChecksumSha256) {
      throw new EspnManualImportRequestError();
    }

    const receipt = await this.#repository.persist({
      authority: { mode: "manual-import", actorUserId },
      bundle,
      checksumSha256: importProvenance.artifactChecksumSha256,
      effectiveAt: new Date(importProvenance.fetchedAt),
      idempotencyKey: `espn-manual:${bundle.league.providerLeagueId}:${bundle.league.season}:${importProvenance.artifactChecksumSha256}`,
      kind: "espn-manual-import",
      now,
    });
    return {
      receiptId: receipt.receiptId,
      state: receipt.state,
      league: {
        ...leagueSummary(bundle),
        id: receipt.leagueId,
        leagueSeasonId: receipt.leagueSeasonId,
      },
      provenance: importProvenance,
      committedAt: now.toISOString(),
      recordsWritten: receipt.recordsWritten,
      warnings: bundle.warnings,
    };
  }
}
