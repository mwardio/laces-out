import type { Database } from "@fantasy/db";
import { RANKING_SCHEMA_VERSION, createRankingVersion } from "@fantasy/rankings";
import { describe, expect, it, vi } from "vitest";

import { DrizzleRankingRepository } from "./ranking-repository.js";
import type { CommitRankingImportInput } from "./ranking-service.js";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const LIST_ID = "20000000-0000-4000-8000-000000000001";
const RUN_ID = "30000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000001";
const SOURCE_CHECKSUM = "a".repeat(64);
const NOW = new Date("2026-07-16T12:00:00.000Z");

describe("DrizzleRankingRepository", () => {
  it("returns the winning version when an identical import succeeds while waiting for its lock", async () => {
    const execute = vi.fn(() => Promise.resolve());
    const transaction = {
      execute,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: RUN_ID,
                  userId: OWNER_ID,
                  rankingListId: LIST_ID,
                  sourceFormat: "csv",
                  sourceChecksumSha256: SOURCE_CHECKSUM,
                  state: "succeeded",
                },
              ]),
          }),
        }),
      }),
    };
    const database = {
      transaction: (operation: (value: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    } as unknown as Database;
    const repository = new DrizzleRankingRepository(database);
    const version = createRankingVersion({
      schemaVersion: RANKING_SCHEMA_VERSION,
      id: VERSION_ID,
      listId: LIST_ID,
      versionNumber: 1,
      parentVersionId: null,
      state: "draft",
      authorUserId: OWNER_ID,
      createdAt: NOW.toISOString(),
      publishedAt: null,
      changeNote: null,
      entries: [],
      provenance: { operation: "import", sources: [], note: null },
    });
    const committedLookup = vi
      .spyOn(repository, "getVersionByImportRunId")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(version);
    const input: CommitRankingImportInput = {
      actorUserId: OWNER_ID,
      listId: LIST_ID,
      expectedCurrentVersionId: null,
      state: "draft",
      entries: [],
      provenance: { operation: "import", sources: [], note: null },
      changeNote: null,
      createdAt: NOW,
      importRunId: RUN_ID,
      sourceFormat: "csv",
      sourceChecksumSha256: SOURCE_CHECKSUM,
      previewChecksumSha256: "b".repeat(64),
      columnMapping: { playerName: "name" },
      rowsRead: 0,
      rowsAccepted: 0,
      rowsRejected: 0,
      acceptedRowNumbers: [],
      validationSummary: {},
      diagnostics: [],
    };

    await expect(repository.commitImport(input)).resolves.toEqual({ status: "saved", version });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(committedLookup).toHaveBeenCalledTimes(2);
  });
});
