import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  runDraftReadProvisioner,
  writeNewPrivateDraftReadFile,
  type DraftReadProvisioningInput,
} from "./draft-read-provisioner.js";
import { verifyDraftReadToken } from "./draft-read.js";

const SECRET = "provisioner-secret-material-".repeat(2);
const USER_ID = "10000000-0000-4000-8000-000000000001";
const SCOPE_JSON = JSON.stringify([{ leagueId: "1234567", season: 2026 }]);
const TOKEN_FILE = "/private/draft-read-token";
const NOW = new Date("2026-08-24T18:05:00.000Z");

function input(overrides: Partial<DraftReadProvisioningInput> = {}): DraftReadProvisioningInput {
  return {
    sessionSecret: SECRET,
    userId: USER_ID,
    leagueScopesJson: SCOPE_JSON,
    lifetimeSeconds: "3600",
    tokenFile: TOKEN_FILE,
    ...overrides,
  };
}

function outputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe("DraftRead provisioner", () => {
  it("writes the credential through the private seam and reports only its expiry", async () => {
    const captured = outputCapture();
    let writtenToken = "";
    const membershipIsActive = vi.fn(() => Promise.resolve(true));
    const status = await runDraftReadProvisioner(
      input(),
      {
        membershipIsActive,
        writeCredentialFile: (path, token) => {
          expect(path).toBe(TOKEN_FILE);
          writtenToken = token;
          return Promise.resolve();
        },
        now: NOW,
      },
      captured.io,
    );

    expect(status).toBe(0);
    expect(membershipIsActive).toHaveBeenCalledWith(USER_ID, {
      leagueId: "1234567",
      season: 2026,
    });
    expect(verifyDraftReadToken(SECRET, writtenToken, NOW)).toBeDefined();
    expect(captured.stdout).toEqual([
      "DraftRead capability written; expires 2026-08-24T19:05:00.000Z.\n",
    ]);
    expect(captured.stderr).toEqual([]);
    const output = captured.stdout.join("");
    for (const sensitive of [writtenToken, SECRET, USER_ID, "1234567", TOKEN_FILE]) {
      expect(output).not.toContain(sensitive);
    }
  });

  it("derives an omitted user only when one active member spans every requested scope", async () => {
    const captured = outputCapture();
    const resolveUniqueUserForScopes = vi.fn(() => Promise.resolve(USER_ID));
    const membershipIsActive = vi.fn(() => Promise.resolve(true));
    const status = await runDraftReadProvisioner(
      input({
        userId: undefined,
        leagueScopesJson: JSON.stringify([
          { leagueId: "1234567", season: 2026 },
          { leagueId: "7654321", season: 2026 },
        ]),
      }),
      {
        resolveUniqueUserForScopes,
        membershipIsActive,
        writeCredentialFile: () => Promise.resolve(),
        now: NOW,
      },
      captured.io,
    );
    expect(status).toBe(0);
    expect(resolveUniqueUserForScopes).toHaveBeenCalledWith([
      { leagueId: "1234567", season: 2026 },
      { leagueId: "7654321", season: 2026 },
    ]);
    expect(membershipIsActive).toHaveBeenCalledTimes(2);
    expect(membershipIsActive).toHaveBeenNthCalledWith(1, USER_ID, {
      leagueId: "1234567",
      season: 2026,
    });

    const ambiguous = outputCapture();
    const ambiguousStatus = await runDraftReadProvisioner(
      input({ userId: undefined }),
      {
        resolveUniqueUserForScopes: () => Promise.resolve(undefined),
        membershipIsActive,
        writeCredentialFile: () => Promise.resolve(),
        now: NOW,
      },
      ambiguous.io,
    );
    expect(ambiguousStatus).toBe(1);
    expect(ambiguous.stdout).toEqual([]);
    expect(ambiguous.stderr).toEqual(["DraftRead capability provisioning failed.\n"]);
  });

  it("redacts invalid input and dependency failures from both output streams", async () => {
    for (const testCase of [
      {
        candidate: input({ userId: "sensitive-invalid-user" }),
        writeCredentialFile: () => Promise.resolve(),
      },
      {
        candidate: input(),
        writeCredentialFile: () =>
          Promise.reject(new Error(`EEXIST ${TOKEN_FILE} ${SECRET} ${USER_ID} 1234567`)),
      },
    ]) {
      const captured = outputCapture();
      const status = await runDraftReadProvisioner(
        testCase.candidate,
        {
          membershipIsActive: () => Promise.resolve(true),
          writeCredentialFile: testCase.writeCredentialFile,
          now: NOW,
        },
        captured.io,
      );
      expect(status).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toEqual(["DraftRead capability provisioning failed.\n"]);
      const output = `${captured.stdout.join("")} ${captured.stderr.join("")}`;
      for (const sensitive of [SECRET, USER_ID, "1234567", TOKEN_FILE, "sensitive-invalid-user"]) {
        expect(output).not.toContain(sensitive);
      }
    }
  });

  it("fails before writing when any requested current membership is absent", async () => {
    const captured = outputCapture();
    const writeCredentialFile = vi.fn(() => Promise.resolve());
    const status = await runDraftReadProvisioner(
      input(),
      {
        membershipIsActive: () => Promise.resolve(false),
        writeCredentialFile,
        now: NOW,
      },
      captured.io,
    );
    expect(status).toBe(1);
    expect(writeCredentialFile).not.toHaveBeenCalled();
    expect(captured.stderr).toEqual(["DraftRead capability provisioning failed.\n"]);
  });

  it("creates mode-0600 files exclusively and never overwrites existing material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "laces-out-draft-read-"));
    const target = join(directory, "capability.token");
    try {
      await writeNewPrivateDraftReadFile(target, "first-token");
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(await readFile(target, "utf8")).toBe("first-token\n");
      await expect(writeNewPrivateDraftReadFile(target, "replacement-token")).rejects.toThrow(
        "DraftRead capability provisioning failed",
      );
      expect(await readFile(target, "utf8")).toBe("first-token\n");
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
