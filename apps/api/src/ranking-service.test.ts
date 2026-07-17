import {
  RANKING_SCHEMA_VERSION,
  createRankingVersion,
  rankingListSchema,
  type RankingList,
  type RankingVersion,
} from "@fantasy/rankings";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deriveRankingShareKeyring,
  RankingService,
  RankingServiceError,
  type AppendRankingVersionInput,
  type CommitRankingImportInput,
  type CreatedRankingShareRecord,
  type RankingImportRecord,
  type RankingMutationResult,
  type RankingPlayerIdentity,
  type RankingRepository,
  type RankingShareAuthorization,
  type StartRankingImportResult,
} from "./ranking-service.js";

const OWNER = "10000000-0000-4000-8000-000000000001";
const FRIEND = "10000000-0000-4000-8000-000000000002";
const OUTSIDER = "10000000-0000-4000-8000-000000000003";
const LEAGUE_A = "20000000-0000-4000-8000-000000000001";
const LEAGUE_B = "20000000-0000-4000-8000-000000000002";
const PLAYER_A = "30000000-0000-4000-8000-000000000001";
const PLAYER_B = "30000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-16T12:00:00.000Z");

function generatedId(sequence: number): string {
  return `90000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

interface MemoryShare {
  readonly id: string;
  readonly listId: string;
  readonly tokenHash: string;
  readonly allowCopy: boolean;
  readonly expiresAt: Date | null;
  readonly maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
}

interface MemoryImport {
  readonly id: string;
  state: RankingImportRecord["state"];
  readonly listId: string;
  readonly sourceFormat: RankingImportRecord["sourceFormat"];
  readonly sourceChecksumSha256: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  versionId: string | null;
}

class MemoryRankingRepository implements RankingRepository {
  readonly lists = new Map<string, RankingList>();
  readonly versions = new Map<string, RankingVersion>();
  readonly memberships = new Map<string, Set<string>>();
  readonly imports = new Map<string, MemoryImport>();
  readonly sharesByHash = new Map<string, MemoryShare>();
  readonly players: readonly RankingPlayerIdentity[] = [
    { id: PLAYER_A, fullName: "Alpha Arm", position: "QB" },
    { id: PLAYER_B, fullName: "Beta Back", position: "RB" },
  ];
  #sequence = 100;

  addMembership(userId: string, leagueId: string): void {
    const leagues = this.memberships.get(userId) ?? new Set<string>();
    leagues.add(leagueId);
    this.memberships.set(userId, leagues);
  }

  async createList(list: RankingList): Promise<void> {
    this.lists.set(list.id, list);
  }

  async listAccessibleLists(
    userId: string,
    includeArchived: boolean,
  ): Promise<readonly RankingList[]> {
    const memberships = this.memberships.get(userId) ?? new Set<string>();
    return [...this.lists.values()]
      .filter((list) => includeArchived || list.archivedAt === null)
      .filter(
        (list) =>
          list.ownerUserId === userId ||
          (list.visibility.scope === "league" &&
            list.visibility.leagueIds.some((leagueId) => memberships.has(leagueId))),
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async getList(listId: string): Promise<RankingList | undefined> {
    return this.lists.get(listId);
  }

  async updateList(
    actorUserId: string,
    list: RankingList,
  ): Promise<"saved" | "not_found" | "forbidden"> {
    const existing = this.lists.get(list.id);
    if (!existing) return "not_found";
    if (existing.ownerUserId !== actorUserId) return "forbidden";
    this.lists.set(
      list.id,
      rankingListSchema.parse({
        ...list,
        currentVersionId: existing.currentVersionId,
        latestPublishedVersionId: existing.latestPublishedVersionId,
      }),
    );
    return "saved";
  }

  async hasEveryLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean> {
    const memberships = this.memberships.get(userId) ?? new Set<string>();
    return leagueIds.every((leagueId) => memberships.has(leagueId));
  }

  async hasAnyLeagueMembership(userId: string, leagueIds: readonly string[]): Promise<boolean> {
    const memberships = this.memberships.get(userId) ?? new Set<string>();
    return leagueIds.some((leagueId) => memberships.has(leagueId));
  }

  async getVersion(versionId: string): Promise<RankingVersion | undefined> {
    return this.versions.get(versionId);
  }

  async appendVersion(input: AppendRankingVersionInput): Promise<RankingMutationResult> {
    const list = this.lists.get(input.listId);
    if (!list) return { status: "not_found" };
    if (list.ownerUserId !== input.actorUserId) return { status: "forbidden" };
    if (list.currentVersionId !== input.expectedCurrentVersionId) return { status: "conflict" };
    const playerIds = new Set(this.players.map((player) => player.id));
    const missing = input.entries
      .map((entry) => entry.playerId)
      .filter((playerId) => !playerIds.has(playerId));
    if (missing.length > 0) return { status: "unknown_players", playerIds: missing };
    this.#sequence += 1;
    const existingVersions = [...this.versions.values()].filter(
      (version) => version.listId === list.id,
    );
    const version = createRankingVersion({
      schemaVersion: RANKING_SCHEMA_VERSION,
      id: generatedId(this.#sequence),
      listId: list.id,
      versionNumber: existingVersions.length + 1,
      parentVersionId: input.expectedCurrentVersionId,
      state: input.state,
      authorUserId: input.actorUserId,
      createdAt: input.createdAt.toISOString(),
      publishedAt: input.state === "published" ? input.createdAt.toISOString() : null,
      changeNote: input.changeNote,
      entries: input.entries,
      provenance: input.provenance,
    });
    this.versions.set(version.id, version);
    this.lists.set(
      list.id,
      rankingListSchema.parse({
        ...list,
        currentVersionId: version.id,
        latestPublishedVersionId:
          version.state === "published" ? version.id : list.latestPublishedVersionId,
        updatedAt: input.createdAt.toISOString(),
      }),
    );
    if (input.importRunId) {
      const run = [...this.imports.values()].find(
        (candidate) => candidate.id === input.importRunId,
      );
      if (run) run.versionId = version.id;
    }
    return { status: "saved", version };
  }

  async listPlayerIdentities(): Promise<readonly RankingPlayerIdentity[]> {
    return this.players;
  }

  async getPlayerIdentities(
    playerIds: readonly string[],
  ): Promise<readonly RankingPlayerIdentity[]> {
    const selected = new Set(playerIds);
    return this.players.filter((player) => selected.has(player.id));
  }

  async startImport(input: {
    readonly actorUserId: string;
    readonly listId: string;
    readonly idempotencyKey: string;
    readonly sourceFormat: "csv" | "json";
    readonly sourceChecksumSha256: string;
  }): Promise<StartRankingImportResult> {
    const key = `${input.actorUserId}:${input.idempotencyKey}`;
    const existing = this.imports.get(key);
    if (existing) {
      if (
        existing.listId !== input.listId ||
        existing.sourceFormat !== input.sourceFormat ||
        existing.sourceChecksumSha256 !== input.sourceChecksumSha256
      ) {
        return { status: "conflict" };
      }
      return { status: "ready", record: existing };
    }
    this.#sequence += 1;
    const record: MemoryImport = {
      id: generatedId(this.#sequence),
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      state: "processing",
      listId: input.listId,
      sourceFormat: input.sourceFormat,
      sourceChecksumSha256: input.sourceChecksumSha256,
      versionId: null,
    };
    this.imports.set(key, record);
    return { status: "ready", record };
  }

  async getVersionByImportRunId(importRunId: string): Promise<RankingVersion | undefined> {
    const run = [...this.imports.values()].find((candidate) => candidate.id === importRunId);
    return run?.versionId ? this.versions.get(run.versionId) : undefined;
  }

  async commitImport(input: CommitRankingImportInput): Promise<RankingMutationResult> {
    const run = [...this.imports.values()].find((candidate) => candidate.id === input.importRunId);
    if (
      !run ||
      run.actorUserId !== input.actorUserId ||
      run.listId !== input.listId ||
      run.sourceFormat !== input.sourceFormat ||
      run.sourceChecksumSha256 !== input.sourceChecksumSha256
    ) {
      return { status: "conflict" };
    }
    if (run.versionId) {
      const version = this.versions.get(run.versionId);
      return version ? { status: "saved", version } : { status: "conflict" };
    }
    const result = await this.appendVersion(input);
    if (result.status === "saved") {
      run.state = "succeeded";
      run.versionId = result.version.id;
    }
    return result;
  }

  async failImport(importRunId: string): Promise<void> {
    const run = [...this.imports.values()].find((candidate) => candidate.id === importRunId);
    if (run) run.state = "failed";
  }

  async createShare(input: {
    readonly id: string;
    readonly actorUserId: string;
    readonly listId: string;
    readonly tokenHash: string;
    readonly allowCopy: boolean;
    readonly expiresAt: Date | null;
    readonly maxUses: number | null;
    readonly now: Date;
  }): Promise<CreatedRankingShareRecord | undefined> {
    const list = this.lists.get(input.listId);
    if (!list?.currentVersionId || list.ownerUserId !== input.actorUserId) return undefined;
    for (const share of this.sharesByHash.values()) {
      if (share.listId === input.listId && !share.revokedAt) share.revokedAt = input.now;
    }
    const share: MemoryShare = {
      id: input.id,
      listId: input.listId,
      tokenHash: input.tokenHash,
      allowCopy: input.allowCopy,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      useCount: 0,
      revokedAt: null,
    };
    this.sharesByHash.set(input.tokenHash, share);
    const updated = rankingListSchema.parse({
      ...list,
      visibility: {
        scope: "shared-link",
        shareLinkId: share.id,
        allowClone: share.allowCopy,
        expiresAt: share.expiresAt?.toISOString() ?? null,
        revokedAt: null,
      },
      updatedAt: input.now.toISOString(),
    });
    this.lists.set(list.id, updated);
    return { id: share.id, list: updated };
  }

  async consumeShare(tokenHash: string, now: Date): Promise<RankingShareAuthorization | undefined> {
    const share = this.sharesByHash.get(tokenHash);
    const list = share ? this.lists.get(share.listId) : undefined;
    if (
      !share ||
      !list ||
      share.revokedAt ||
      (share.expiresAt && share.expiresAt <= now) ||
      (share.maxUses !== null && share.useCount >= share.maxUses) ||
      list.visibility.scope !== "shared-link" ||
      list.visibility.shareLinkId !== share.id ||
      list.visibility.revokedAt !== null
    ) {
      return undefined;
    }
    share.useCount += 1;
    return { listId: share.listId, allowCopy: share.allowCopy };
  }

  async revokeShare(
    actorUserId: string,
    shareId: string,
    now: Date,
  ): Promise<"revoked" | "not_found" | "forbidden"> {
    const share = [...this.sharesByHash.values()].find((candidate) => candidate.id === shareId);
    if (!share || share.revokedAt) return "not_found";
    const list = this.lists.get(share.listId);
    if (list?.ownerUserId !== actorUserId) return "forbidden";
    share.revokedAt = now;
    if (list.visibility.scope === "shared-link" && list.visibility.shareLinkId === share.id) {
      this.lists.set(
        list.id,
        rankingListSchema.parse({
          ...list,
          visibility: { ...list.visibility, revokedAt: now.toISOString() },
          updatedAt: now.toISOString(),
        }),
      );
    }
    return "revoked";
  }
}

describe("RankingService", () => {
  let repository: MemoryRankingRepository;
  let service: RankingService;
  let idSequence: number;

  beforeEach(() => {
    repository = new MemoryRankingRepository();
    repository.addMembership(OWNER, LEAGUE_A);
    repository.addMembership(FRIEND, LEAGUE_A);
    idSequence = 1;
    service = new RankingService(repository, deriveRankingShareKeyring(Buffer.alloc(32, 31)), {
      now: () => NOW,
      id: () => generatedId(idSequence++),
    });
  });

  async function privateList(name = "My board"): Promise<RankingList> {
    return service.createList(OWNER, {
      name,
      season: 2026,
      kind: "cheat-sheet",
      scoringContext: {
        format: "PPR",
        leagueId: null,
        settingsChecksumSha256: null,
        label: "PPR",
      },
    });
  }

  async function firstDraft(list: RankingList): Promise<RankingVersion> {
    return service.replaceWithManualDraft({
      actorUserId: OWNER,
      listId: list.id,
      expectedCurrentVersionId: null,
      entries: [
        { playerId: PLAYER_A, position: "QB", overallRank: 1, aav: 22, notes: "QB1" },
        { playerId: PLAYER_B, position: "RB", overallRank: 2, aav: 35 },
      ],
      changeNote: "Initial board",
    });
  }

  it("enforces owner edits and membership-aware league visibility", async () => {
    const list = await service.createList(OWNER, {
      name: "League board",
      season: 2026,
      kind: "rankings",
      scoringContext: {
        format: "CUSTOM",
        leagueId: LEAGUE_A,
        settingsChecksumSha256: "a".repeat(64),
        label: "League scoring",
      },
      visibility: { scope: "league", leagueIds: [LEAGUE_A], allowClone: true },
    });

    await expect(service.getList(FRIEND, list.id)).resolves.toMatchObject({ id: list.id });
    await expect(service.getList(OUTSIDER, list.id)).rejects.toMatchObject({
      code: "RANKING_FORBIDDEN",
    });
    await expect(service.editList(FRIEND, list.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "RANKING_FORBIDDEN",
    });
    await expect(
      service.editList(OWNER, list.id, {
        visibility: {
          scope: "league",
          leagueIds: [LEAGUE_A, LEAGUE_B],
          allowClone: true,
        },
      }),
    ).rejects.toMatchObject({ code: "RANKING_FORBIDDEN" });

    repository.addMembership(OWNER, LEAGUE_B);
    const updated = await service.editList(OWNER, list.id, {
      name: "League board v2",
      visibility: {
        scope: "league",
        leagueIds: [LEAGUE_A, LEAGUE_B],
        allowClone: false,
      },
    });
    expect(updated.name).toBe("League board v2");
    await expect(service.getList(FRIEND, list.id)).resolves.toBeDefined();
  });

  it("lists only owned and membership-visible boards while hiding archives by default", async () => {
    const privateRanking = await privateList("Owner private");
    const leagueRanking = await service.createList(OWNER, {
      name: "League board",
      season: 2026,
      kind: "rankings",
      scoringContext: {
        format: "PPR",
        leagueId: LEAGUE_A,
        settingsChecksumSha256: "d".repeat(64),
        label: "League PPR",
      },
      visibility: { scope: "league", leagueIds: [LEAGUE_A], allowClone: true },
    });
    await service.editList(OWNER, privateRanking.id, { archived: true });

    await expect(service.listLists(FRIEND)).resolves.toEqual([
      expect.objectContaining({ id: leagueRanking.id }),
    ]);
    await expect(service.listLists(OUTSIDER)).resolves.toEqual([]);
    await expect(service.listLists(OWNER, { includeArchived: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: privateRanking.id }),
        expect.objectContaining({ id: leagueRanking.id }),
      ]),
    );
  });

  it("creates immutable child drafts and a separate published snapshot", async () => {
    const list = await privateList();
    const first = await firstDraft(list);
    const overlaid = await service.applyUserOverlay({
      actorUserId: OWNER,
      listId: list.id,
      baseVersionId: first.id,
      patches: [{ playerId: PLAYER_A, aav: 27, notes: "Aggressive target", target: true }],
      changeNote: "Auction adjustments",
    });

    expect(first.entries[0]?.aav?.value).toBe(22);
    expect(overlaid.entries[0]?.aav).toMatchObject({
      value: 27,
      kind: "user",
      authorUserId: OWNER,
    });
    expect(overlaid.parentVersionId).toBe(first.id);
    await expect(
      service.applyUserOverlay({
        actorUserId: OWNER,
        listId: list.id,
        baseVersionId: first.id,
        patches: [{ playerId: PLAYER_A, tier: 1 }],
      }),
    ).rejects.toMatchObject({ code: "RANKING_VERSION_CONFLICT" });

    const published = await service.publish({
      actorUserId: OWNER,
      listId: list.id,
      expectedCurrentVersionId: overlaid.id,
      changeNote: "Draft day release",
    });
    expect(published.state).toBe("published");
    expect(published.parentVersionId).toBe(overlaid.id);
    expect(repository.versions.get(overlaid.id)?.state).toBe("draft");
    expect(repository.lists.get(list.id)?.latestPublishedVersionId).toBe(published.id);
  });

  it("previews and idempotently imports custom CSV with user and source provenance", async () => {
    const list = await privateList();
    const source = "name,pos,rank,aav\nAlpha Arm,QB,1,15.5\nBeta Back,RB,2,32\n";
    const mapping = {
      playerName: "name",
      position: "pos",
      overallRank: "rank",
      aav: "aav",
    } as const;
    const preview = await service.previewCsv({
      actorUserId: OWNER,
      listId: list.id,
      source,
      mapping,
    });
    expect(preview.canCommitAll).toBe(true);
    const imported = await service.importCsv({
      actorUserId: OWNER,
      listId: list.id,
      expectedCurrentVersionId: null,
      idempotencyKey: "csv-import-001",
      source,
      sourceFileName: "friends-board.csv",
      mapping,
      decision: { mode: "all-valid", previewChecksumSha256: preview.previewChecksumSha256 },
    });
    expect(imported.provenance).toMatchObject({
      operation: "import",
      sources: [{ kind: "csv-import", label: "friends-board.csv" }],
    });
    expect(imported.entries[0]?.overallRank).toMatchObject({
      value: 1,
      kind: "user",
      authorUserId: OWNER,
    });

    const replay = await service.importCsv({
      actorUserId: OWNER,
      listId: list.id,
      expectedCurrentVersionId: null,
      idempotencyKey: "csv-import-001",
      source,
      sourceFileName: "friends-board.csv",
      mapping,
      decision: { mode: "all-valid", previewChecksumSha256: preview.previewChecksumSha256 },
    });
    expect(replay.id).toBe(imported.id);
    expect([...repository.versions.values()]).toHaveLength(1);
  });

  it("rejects invalid CSV decisions and idempotency-key content changes", async () => {
    const list = await privateList();
    const mapping = { playerName: "name", overallRank: "rank" } as const;
    const source = "name,rank\nAlpha Arm,1\n";
    const preview = await service.previewCsv({
      actorUserId: OWNER,
      listId: list.id,
      source,
      mapping,
    });
    await service.importCsv({
      actorUserId: OWNER,
      listId: list.id,
      expectedCurrentVersionId: null,
      idempotencyKey: "same-key-0001",
      source,
      mapping,
      decision: { mode: "all-valid", previewChecksumSha256: preview.previewChecksumSha256 },
    });

    const changedSource = "name,rank\nBeta Back,1\n";
    const changedPreview = await service.previewCsv({
      actorUserId: OWNER,
      listId: list.id,
      source: changedSource,
      mapping,
    });
    await expect(
      service.importCsv({
        actorUserId: OWNER,
        listId: list.id,
        expectedCurrentVersionId: repository.lists.get(list.id)?.currentVersionId ?? null,
        idempotencyKey: "same-key-0001",
        source: changedSource,
        mapping,
        decision: {
          mode: "all-valid",
          previewChecksumSha256: changedPreview.previewChecksumSha256,
        },
      }),
    ).rejects.toMatchObject({ code: "RANKING_IMPORT_CONFLICT" });

    await expect(
      service.importCsv({
        actorUserId: OWNER,
        listId: list.id,
        expectedCurrentVersionId: repository.lists.get(list.id)?.currentVersionId ?? null,
        idempotencyKey: "bad-preview-01",
        source,
        mapping,
        decision: { mode: "all-valid", previewChecksumSha256: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "RANKING_IMPORT_INVALID" });
  });

  it("round-trips JSON exports into a new list while recording import provenance", async () => {
    const sourceList = await privateList("Source board");
    const sourceVersion = await firstDraft(sourceList);
    const exported = await service.export({
      actorUserId: OWNER,
      listId: sourceList.id,
      format: "json",
    });
    const targetList = await privateList("Imported board");
    const imported = await service.importJson({
      actorUserId: OWNER,
      listId: targetList.id,
      expectedCurrentVersionId: null,
      idempotencyKey: "json-import-01",
      source: exported,
      sourceFileName: "source-board.json",
    });

    expect(imported.listId).toBe(targetList.id);
    expect(imported.entries).toEqual(sourceVersion.entries);
    expect(imported.provenance.sources[0]).toMatchObject({
      kind: "json-import",
      versionId: sourceVersion.id,
      label: "Source board",
    });
  });

  it("authorizes exports through private, league, and bounded share-link scopes", async () => {
    const privateRanking = await privateList();
    await firstDraft(privateRanking);
    await expect(
      service.export({ actorUserId: FRIEND, listId: privateRanking.id, format: "csv" }),
    ).rejects.toMatchObject({ code: "RANKING_FORBIDDEN" });

    const leagueRanking = await service.createList(OWNER, {
      name: "League ranks",
      season: 2026,
      kind: "rankings",
      scoringContext: {
        format: "PPR",
        leagueId: LEAGUE_A,
        settingsChecksumSha256: "c".repeat(64),
        label: "League PPR",
      },
      visibility: { scope: "league", leagueIds: [LEAGUE_A], allowClone: true },
    });
    await firstDraft(leagueRanking);
    await expect(
      service.export({ actorUserId: FRIEND, listId: leagueRanking.id, format: "csv" }),
    ).resolves.toContain("player_id,position");

    const shared = await service.createShare({
      actorUserId: OWNER,
      listId: privateRanking.id,
      allowCopy: true,
      maxUses: 1,
    });
    expect(shared.token).toMatch(/^frs_/u);
    expect(repository.sharesByHash.has(shared.token)).toBe(false);
    await expect(service.openShare(shared.token)).resolves.toMatchObject({ allowCopy: true });
    await expect(service.openShare(shared.token)).rejects.toMatchObject({
      code: "RANKING_SHARE_UNAVAILABLE",
    });
    await expect(service.openShare("frs_invalid")).rejects.toBeInstanceOf(RankingServiceError);
  });

  it("keeps view-only share capabilities from exporting the board", async () => {
    const list = await privateList();
    await firstDraft(list);
    const viewOnly = await service.createShare({
      actorUserId: OWNER,
      listId: list.id,
      allowCopy: false,
    });

    await expect(service.exportShare(viewOnly.token, "csv")).rejects.toMatchObject({
      code: "RANKING_SHARE_UNAVAILABLE",
    });

    const copyable = await service.createShare({
      actorUserId: OWNER,
      listId: list.id,
      allowCopy: true,
    });
    await expect(service.exportShare(copyable.token, "csv")).resolves.toContain(
      "player_id,position",
    );
  });

  it("revokes active shares and prevents callers from forging shared-link metadata", async () => {
    const list = await privateList();
    await firstDraft(list);
    await expect(
      service.editList(OWNER, list.id, {
        visibility: {
          scope: "shared-link",
          shareLinkId: generatedId(999),
          allowClone: true,
          expiresAt: null,
          revokedAt: null,
        },
      }),
    ).rejects.toMatchObject({ code: "RANKING_INVALID_INPUT" });

    const shared = await service.createShare({ actorUserId: OWNER, listId: list.id });
    await service.revokeShare(OWNER, shared.id);
    await expect(service.openShare(shared.token)).rejects.toMatchObject({
      code: "RANKING_SHARE_UNAVAILABLE",
    });
  });
});
