import { describe, expect, it } from "vitest";

import {
  EspnManualImportRequestError,
  EspnManualImportService,
  type EspnManualImportRepository,
} from "./espn-import.js";
import {
  EspnSyncPersistenceError,
  type PersistEspnSyncInput,
  type PersistEspnSyncReceipt,
} from "./espn-sync-persistence.js";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const COMMISSIONER_ID = "10000000-0000-4000-8000-000000000002";
const MANAGER_ID = "10000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const RECEIPT_ID = "40000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-10T12:00:00.000Z");

function snapshot(name = "Friends League") {
  return {
    schemaVersion: 1,
    provider: "espn",
    importedAt: "2026-09-10T11:45:00.000Z",
    league: {
      id: "12345",
      season: 2026,
      name,
      currentWeek: 2,
      settings: {
        teamCount: 2,
        draftType: "auction",
        auctionBudget: 200,
        waiverType: "faab",
        faabBudget: 100,
        playoffTeamCount: 2,
        rosterSlots: [{ position: "QB", count: 1, starting: true }],
        scoringRules: [],
      },
    },
    teams: [
      {
        id: "1",
        name: "Laces High",
        abbreviation: "LH",
        logoUrl: null,
        isCurrentUser: true,
        managers: [],
        roster: [],
      },
      {
        id: "2",
        name: "Wide Right",
        abbreviation: "WR",
        logoUrl: null,
        isCurrentUser: false,
        managers: [],
        roster: [],
      },
    ],
  };
}

class FakeAtomicRepository implements EspnManualImportRepository {
  readonly roles = new Map<string, "owner" | "commissioner" | "manager">();
  readonly receipts = new Map<string, PersistEspnSyncReceipt>();
  stored: { readonly checksum: string; readonly name: string } | undefined;
  failNext = false;

  async persist(input: PersistEspnSyncInput): Promise<PersistEspnSyncReceipt> {
    if (input.authority.mode !== "manual-import") throw new Error("manual test expected");
    const actorUserId = input.authority.actorUserId;
    if (this.stored) {
      const role = this.roles.get(actorUserId);
      if (role !== "owner" && role !== "commissioner") throw new EspnSyncPersistenceError();
    }
    const prior = this.receipts.get(input.idempotencyKey);
    if (prior) return { ...prior, state: "unchanged" };

    // Prepare all mutations on a draft. Throwing before assignment models the repository's
    // all-or-nothing transaction and lets the service tests assert last-good preservation.
    const draft = {
      checksum: input.checksumSha256,
      name: input.bundle.league.name,
    };
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated database constraint failure");
    }
    this.stored = draft;
    this.roles.set(actorUserId, this.stored && this.roles.size === 0 ? "owner" : "commissioner");
    const receipt: PersistEspnSyncReceipt = {
      receiptId: RECEIPT_ID,
      leagueId: LEAGUE_ID,
      leagueSeasonId: SEASON_ID,
      recordsWritten: 6,
      state: "accepted",
    };
    this.receipts.set(input.idempotencyKey, receipt);
    return receipt;
  }
}

describe("EspnManualImportService", () => {
  it("previews the strict canonical snapshot with exact freshness and provenance", () => {
    const service = new EspnManualImportService(new FakeAtomicRepository(), () => NOW);
    const preview = service.preview(snapshot());

    expect(preview).toMatchObject({
      valid: true,
      league: { name: "Friends League", season: 2026, teamCount: 2, draftType: "auction" },
      provenance: {
        mode: "manual-import",
        fetchedAt: "2026-09-10T11:45:00.000Z",
        ageSeconds: 900,
      },
      validatedAt: NOW.toISOString(),
    });
    expect(preview.provenance.artifactChecksumSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a far-future snapshot before it can outrank later canonical data", async () => {
    const repository = new FakeAtomicRepository();
    const service = new EspnManualImportService(repository, () => NOW);
    const future = {
      ...snapshot(),
      importedAt: "2099-01-01T00:00:00.000Z",
    };

    expect(() => service.preview(future)).toThrow("more than five minutes in the future");
    await expect(
      service.commit(OWNER_ID, {
        snapshot: future,
        expectedChecksumSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "FUTURE_SNAPSHOT" });
    expect(repository.stored).toBeUndefined();
  });

  it("reparses on commit and rejects confirmation for different JSON", async () => {
    const repository = new FakeAtomicRepository();
    const service = new EspnManualImportService(repository, () => NOW);
    const preview = service.preview(snapshot());

    await expect(
      service.commit(OWNER_ID, {
        snapshot: snapshot("Changed after preview"),
        expectedChecksumSha256: preview.provenance.artifactChecksumSha256,
      }),
    ).rejects.toBeInstanceOf(EspnManualImportRequestError);
    expect(repository.stored).toBeUndefined();
  });

  it("is checksum-idempotent and checks authorization before revealing a replay", async () => {
    const repository = new FakeAtomicRepository();
    const service = new EspnManualImportService(repository, () => NOW);
    const input = snapshot();
    const checksum = service.preview(input).provenance.artifactChecksumSha256;

    const accepted = await service.commit(OWNER_ID, {
      snapshot: input,
      expectedChecksumSha256: checksum,
    });
    const replay = await service.commit(OWNER_ID, {
      snapshot: input,
      expectedChecksumSha256: checksum,
    });
    await expect(
      service.commit(MANAGER_ID, { snapshot: input, expectedChecksumSha256: checksum }),
    ).rejects.toMatchObject({ statusCode: 404, code: "IMPORT_SCOPE_NOT_FOUND" });

    expect(accepted.state).toBe("accepted");
    expect(replay).toMatchObject({ state: "unchanged", receiptId: accepted.receiptId });
    expect(repository.stored?.checksum).toBe(checksum);
  });

  it("allows a commissioner, blocks a manager, and preserves last-good state on failure", async () => {
    const repository = new FakeAtomicRepository();
    const service = new EspnManualImportService(repository, () => NOW);
    const first = snapshot();
    const firstChecksum = service.preview(first).provenance.artifactChecksumSha256;
    await service.commit(OWNER_ID, { snapshot: first, expectedChecksumSha256: firstChecksum });
    repository.roles.set(COMMISSIONER_ID, "commissioner");
    repository.roles.set(MANAGER_ID, "manager");

    const replacement = snapshot("Commissioner's update");
    const replacementChecksum = service.preview(replacement).provenance.artifactChecksumSha256;
    await expect(
      service.commit(MANAGER_ID, {
        snapshot: replacement,
        expectedChecksumSha256: replacementChecksum,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    repository.failNext = true;
    await expect(
      service.commit(COMMISSIONER_ID, {
        snapshot: replacement,
        expectedChecksumSha256: replacementChecksum,
      }),
    ).rejects.toThrow("simulated database constraint failure");
    expect(repository.stored).toEqual({ checksum: firstChecksum, name: "Friends League" });

    await expect(
      service.commit(COMMISSIONER_ID, {
        snapshot: replacement,
        expectedChecksumSha256: replacementChecksum,
      }),
    ).resolves.toMatchObject({ state: "accepted", league: { name: "Commissioner's update" } });
  });
});
