import type { Database } from "@fantasy/db";
import { describe, expect, it, vi } from "vitest";

import { DrizzleAccountDataRepository } from "./account-data.js";

const input = {
  userId: "10000000-0000-4000-8000-0000000000f8",
  currentPassword: "a valid account password",
  correlationId: "account-delete-deadlock-retry",
  deletedAt: new Date("2031-11-08T14:30:00.000Z"),
} as const;

const receipt = {
  deleted: true,
  transferredLeagueCount: 1,
  deletedSoleMemberLeagueCount: 0,
  preservedSharedProjectionSetCount: 0,
} as const;

function deadlock(): Error & { readonly code: "40P01" } {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" as const });
}

describe("DrizzleAccountDataRepository deadlock retry", () => {
  it("retries an aborted account-deletion transaction from the beginning", async () => {
    const transaction = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce(receipt);
    const repository = new DrizzleAccountDataRepository({ transaction } as unknown as Database);

    await expect(repository.deleteAccount(input)).resolves.toEqual(receipt);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps the retry bounded and surfaces a persistent deadlock", async () => {
    const error = deadlock();
    const transaction = vi.fn().mockRejectedValue(error);
    const repository = new DrizzleAccountDataRepository({ transaction } as unknown as Database);

    await expect(repository.deleteAccount(input)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
