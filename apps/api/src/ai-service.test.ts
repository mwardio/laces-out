import { parseCredentialKey, type CredentialEnvelopeV1 } from "@fantasy/security";
import { describe, expect, it, vi } from "vitest";

import type { AiCompletionInput, AiProviderAdapter } from "./ai-provider-adapters.js";
import {
  AiService,
  type AiCredentialRecord,
  type AiRepository,
  type AiServiceError,
  type AiUsageRecord,
} from "./ai-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const KEY = parseCredentialKey(`base64:${Buffer.alloc(32, 9).toString("base64")}`, {
  keyId: "ai-test-key",
});

class MemoryAiRepository implements AiRepository {
  credential: AiCredentialRecord | undefined;
  readonly usage: AiUsageRecord[] = [];

  listCredentials(userId: string): Promise<readonly AiCredentialRecord[]> {
    return Promise.resolve(this.credential?.userId === userId ? [this.credential] : []);
  }

  findCredential(userId: string): Promise<AiCredentialRecord | undefined> {
    return Promise.resolve(this.credential?.userId === userId ? this.credential : undefined);
  }

  saveCredential(input: {
    readonly userId: string;
    readonly provider: "openai" | "anthropic" | "gemini" | "openrouter";
    readonly model: string;
    readonly dailyRequestLimit: number;
    readonly maxOutputTokens: number;
    readonly credentialEnvelope: CredentialEnvelopeV1;
    readonly credentialPurpose: string;
    readonly now: Date;
  }): Promise<AiCredentialRecord> {
    this.credential = {
      id: "30000000-0000-4000-8000-000000000001",
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      dailyRequestLimit: input.dailyRequestLimit,
      maxOutputTokens: input.maxOutputTokens,
      credentialEnvelope: input.credentialEnvelope,
      credentialPurpose: input.credentialPurpose,
      status: "active",
      lastValidatedAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: input.now,
    };
    return Promise.resolve(this.credential);
  }

  updateSettings(input: {
    readonly model: string;
    readonly dailyRequestLimit: number;
    readonly maxOutputTokens: number;
    readonly now: Date;
  }): Promise<AiCredentialRecord> {
    if (!this.credential) throw new Error("missing credential");
    this.credential = {
      ...this.credential,
      model: input.model,
      dailyRequestLimit: input.dailyRequestLimit,
      maxOutputTokens: input.maxOutputTokens,
      updatedAt: input.now,
    };
    return Promise.resolve(this.credential);
  }

  deleteCredential(): Promise<boolean> {
    const existed = Boolean(this.credential);
    this.credential = undefined;
    return Promise.resolve(existed);
  }

  countUsageSince(
    userId: string,
    provider: string,
    since: Date,
    credentialId: string | null,
  ): Promise<number> {
    return Promise.resolve(
      this.usage.filter(
        (item) =>
          item.userId === userId &&
          item.provider === provider &&
          item.credentialId === credentialId &&
          item.occurredAt >= since,
      ).length,
    );
  }

  recordUsage(input: AiUsageRecord): Promise<void> {
    this.usage.push(input);
    return Promise.resolve();
  }

  markValidated(_id: string, now: Date): Promise<void> {
    if (this.credential) {
      this.credential = {
        ...this.credential,
        status: "active",
        lastValidatedAt: now,
        lastErrorCode: null,
        lastErrorAt: null,
      };
    }
    return Promise.resolve();
  }

  markError(_id: string, code: string, invalid: boolean, now: Date): Promise<void> {
    if (this.credential) {
      this.credential = {
        ...this.credential,
        status: invalid ? "invalid" : this.credential.status,
        lastErrorCode: code,
        lastErrorAt: now,
      };
    }
    return Promise.resolve();
  }
}

function serviceFixture(
  adapter: AiProviderAdapter,
  repository = new MemoryAiRepository(),
  managedGemini?: {
    readonly apiKey: string;
    readonly dailyRequestLimit: number;
    readonly maxOutputTokens: number;
  },
  decisions: unknown = { lineup: { state: "available", moves: ["Start Reed"] } },
) {
  const adapters = {
    openai: adapter,
    anthropic: adapter,
    gemini: adapter,
    openrouter: adapter,
  };
  return {
    repository,
    service: new AiService({
      repository,
      credentialKey: KEY,
      adapters,
      leagueDashboard: {
        getDashboard: () =>
          Promise.resolve({ league: { id: LEAGUE_ID, name: "Wide Right League" }, roster: [] }),
      },
      decisions: {
        getSnapshot: () => Promise.resolve(decisions),
      },
      analytics: {
        getSnapshot: () =>
          Promise.resolve({ power: { state: "available", rank: 4 }, opponentScout: {} }),
      },
      ...(managedGemini ? { managedGemini } : {}),
      now: () => new Date(NOW),
    }),
  };
}

describe("AI service", () => {
  it("encrypts a write-only key, tests it, and grounds analysis in all three league sources", async () => {
    const complete = vi.fn((input: AiCompletionInput) =>
      Promise.resolve({
        text: input.prompt.includes("<league_data>") ? "Start Reed. [Decision Desk]" : "Ready",
        requestId: `request-${complete.mock.calls.length}`,
        inputTokens: 120,
        outputTokens: 22,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    const { service, repository } = serviceFixture({ complete });

    const saved = await service.saveProvider(USER_ID, "openai", {
      apiKey: "sk-private-secret",
      model: "gpt-current",
      dailyRequestLimit: 3,
      maxOutputTokens: 700,
    });

    expect(saved).toMatchObject({ configured: true, model: "gpt-current", requestsToday: 0 });
    expect(JSON.stringify(saved)).not.toContain("sk-private-secret");
    expect(JSON.stringify(repository.credential?.credentialEnvelope)).not.toContain(
      "sk-private-secret",
    );

    await expect(service.testProvider(USER_ID, "openai")).resolves.toMatchObject({ ok: true });
    const analysis = await service.analyzeLeague({
      userId: USER_ID,
      provider: "openai",
      leagueId: LEAGUE_ID,
      question: "Who should I start?",
    });

    expect(analysis).toMatchObject({
      accessMode: "byok",
      answer: "Start Reed.",
      league: { id: LEAGUE_ID, name: "Wide Right League" },
      sources: ["League overview", "Decision Desk", "League analytics"],
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "sk-private-secret",
      maxOutputTokens: 32,
    });
    expect(complete.mock.calls[1]?.[0].prompt).toContain('"Decision Desk"');
    expect(complete.mock.calls[1]?.[0].prompt).toContain('"League analytics"');
    expect(complete.mock.calls[1]?.[0].system).toContain("Never claim that you changed");
    expect(complete.mock.calls[1]?.[0].system).toContain("Do not include bracketed source tags");
    expect(repository.usage).toHaveLength(2);
    expect(repository.usage[1]?.metadata).toEqual({
      accessMode: "byok",
      leagueId: LEAGUE_ID,
    });
  });

  it("offers managed Gemini by default and lets a member BYOK override it", async () => {
    const complete = vi.fn((input: AiCompletionInput) =>
      Promise.resolve({
        text: `Used ${input.model}`,
        requestId: `request-${complete.mock.calls.length}`,
        inputTokens: 30,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    const { service, repository } = serviceFixture({ complete }, new MemoryAiRepository(), {
      apiKey: "managed-gemini-secret",
      dailyRequestLimit: 50,
      maxOutputTokens: 2000,
    });

    const initial = await service.listProviders(USER_ID);
    expect(initial.providers.find((provider) => provider.provider === "gemini")).toMatchObject({
      available: true,
      configured: false,
      accessMode: "managed",
      modelEditable: false,
      model: "gemini-3.5-flash",
      dailyRequestLimit: 50,
    });

    const included = await service.analyzeLeague({
      userId: USER_ID,
      leagueId: LEAGUE_ID,
      question: "What matters this week?",
    });
    expect(included).toMatchObject({
      provider: "gemini",
      accessMode: "managed",
      model: "gemini-3.5-flash",
    });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "managed-gemini-secret",
      model: "gemini-3.5-flash",
      maxOutputTokens: 2000,
    });
    expect(repository.usage[0]).toMatchObject({
      credentialId: null,
      metadata: { accessMode: "managed", leagueId: LEAGUE_ID },
    });

    await service.saveProvider(USER_ID, "gemini", {
      apiKey: "member-gemini-secret",
      model: "gemini-member-choice",
      dailyRequestLimit: 4,
      maxOutputTokens: 700,
    });
    const overridden = await service.analyzeLeague({
      userId: USER_ID,
      provider: "gemini",
      leagueId: LEAGUE_ID,
      question: "Use my model",
    });
    expect(overridden).toMatchObject({ accessMode: "byok", model: "gemini-member-choice" });
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      apiKey: "member-gemini-secret",
      model: "gemini-member-choice",
    });

    await service.deleteProvider(USER_ID, "gemini");
    expect((await service.listProviders(USER_ID)).providers[2]).toMatchObject({
      accessMode: "managed",
      modelEditable: false,
    });
  });

  it("enforces the per-user daily safety limit before calling a provider", async () => {
    const complete = vi.fn((input: AiCompletionInput) => {
      void input;
      return Promise.resolve({
        text: "Ready",
        requestId: null,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
    const { service } = serviceFixture({ complete });
    await service.saveProvider(USER_ID, "openai", {
      apiKey: "sk-private-secret",
      model: "gpt-current",
      dailyRequestLimit: 1,
      maxOutputTokens: 700,
    });
    await service.testProvider(USER_ID, "openai");

    await expect(service.testProvider(USER_ID, "openai")).rejects.toMatchObject({
      code: "DAILY_LIMIT",
      statusCode: 429,
    } satisfies Partial<AiServiceError>);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not spend a model call when no waiver move clears replacement value", async () => {
    const complete = vi.fn(() =>
      Promise.resolve({
        text: "This should not run",
        requestId: null,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    const { service, repository } = serviceFixture(
      { complete },
      new MemoryAiRepository(),
      { apiKey: "managed-gemini-secret", dailyRequestLimit: 50, maxOutputTokens: 2000 },
      {
        lineup: { state: "available", changes: [] },
        waivers: { state: "available", recommendations: [] },
        trades: { state: "available", bestForMe: [], fairest: [] },
      },
    );

    const response = await service.generateFeature({
      userId: USER_ID,
      leagueId: LEAGUE_ID,
      feature: "waiver-scan",
    });

    expect(response).toMatchObject({
      outcome: "no-action",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(response.answer).toContain("no worthwhile waiver targets");
    expect(complete).not.toHaveBeenCalled();
    expect(repository.usage).toHaveLength(0);
  });

  it("uses feature-specific instructions and records the selected job", async () => {
    const complete = vi.fn((input: AiCompletionInput) => {
      void input;
      return Promise.resolve({
        text: "### Forecast\n\n1. Fourth & Long — 10–4\n\n### Sources\n[League analytics]",
        requestId: "feature-request",
        inputTokens: 140,
        outputTokens: 35,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
    const { service, repository } = serviceFixture({ complete }, new MemoryAiRepository(), {
      apiKey: "managed-gemini-secret",
      dailyRequestLimit: 50,
      maxOutputTokens: 2000,
    });

    const response = await service.generateFeature({
      userId: USER_ID,
      leagueId: LEAGUE_ID,
      feature: "standings-prediction",
      instructions: "Weight all-play results heavily.",
    });

    expect(response).toMatchObject({ feature: "standings-prediction", outcome: "generated" });
    expect(response.answer).toBe("### Forecast\n\n1. Fourth & Long — 10–4");
    expect(complete.mock.calls[0]?.[0].prompt).toContain("plausible final record for every team");
    expect(complete.mock.calls[0]?.[0].prompt).toContain("Weight all-play results heavily.");
    expect(complete.mock.calls[0]?.[0].system).toContain("Use concise Markdown");
    expect(repository.usage[0]).toMatchObject({
      operation: "league-feature",
      metadata: {
        accessMode: "managed",
        leagueId: LEAGUE_ID,
        feature: "standings-prediction",
      },
    });
  });
});
