import { loadEnvironment } from "@fantasy/config";
import type {
  AiAnalysisResponse,
  AiFeatureResponse,
  AiProviderConfiguration,
} from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AiServicePort } from "./ai-routes.js";
import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "f".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const NOW = "2026-09-18T12:00:00.000Z";

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "guru@example.com",
          displayName: "League Guru",
          role: "admin",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

function configuration(provider: AiProviderConfiguration["provider"]): AiProviderConfiguration {
  return {
    provider,
    available: provider === "openai" || provider === "gemini",
    configured: provider === "openai",
    accessMode: provider === "openai" ? "byok" : provider === "gemini" ? "managed" : "unavailable",
    modelEditable: provider === "openai",
    model: provider === "openai" ? "gpt-current" : `default-${provider}`,
    status: provider === "openai" ? "active" : null,
    dailyRequestLimit: 25,
    maxOutputTokens: 2000,
    requestsToday: 0,
    requestsRemaining: 25,
    lastValidatedAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: provider === "openai" ? NOW : null,
  };
}

describe("AI routes", () => {
  it("requires a session, keeps keys write-only, and scopes analysis to the current user", async () => {
    const providers = ["openai", "anthropic", "gemini", "openrouter"].map((provider) =>
      configuration(provider as AiProviderConfiguration["provider"]),
    );
    const saveProvider = vi.fn(() => Promise.resolve(configuration("openai")));
    const analyzeLeague = vi.fn((): Promise<AiAnalysisResponse> =>
      Promise.resolve({
        provider: "openai" as const,
        accessMode: "byok" as const,
        model: "gpt-current",
        league: { id: LEAGUE_ID, name: "North Loop Auction" },
        answer: "Start Reed. [Decision Desk]",
        generatedAt: NOW,
        usage: { inputTokens: 100, outputTokens: 20 },
        sources: ["League overview", "Decision Desk", "League analytics"],
      }),
    );
    const generateFeature = vi.fn((): Promise<AiFeatureResponse> =>
      Promise.resolve({
        feature: "waiver-scan",
        outcome: "generated",
        provider: "gemini",
        accessMode: "managed",
        model: "gemini-3.6-flash",
        league: { id: LEAGUE_ID, name: "North Loop Auction" },
        title: "Waiver wire scan",
        answer: "Hold this week. [Decision Desk]",
        generatedAt: NOW,
        usage: { inputTokens: 120, outputTokens: 24 },
        sources: ["Decision Desk", "League overview"],
      }),
    );
    const ai: AiServicePort = {
      listProviders: () => Promise.resolve({ generatedAt: NOW, providers }),
      saveProvider,
      deleteProvider: () => Promise.resolve(true),
      testProvider: () =>
        Promise.resolve({
          provider: "openai",
          model: "gpt-current",
          ok: true,
          validatedAt: NOW,
          latencyMs: 25,
        }),
      analyzeLeague,
      generateFeature,
    };
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      ai,
    });

    const denied = await app.inject({ method: "GET", url: "/v1/ai/providers" });
    expect(denied.statusCode).toBe(401);

    const saved = await app.inject({
      method: "PUT",
      url: "/v1/ai/providers/openai",
      headers: { cookie: COOKIE },
      payload: {
        apiKey: "sk-top-secret",
        model: "gpt-current",
        dailyRequestLimit: 25,
        maxOutputTokens: 2000,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("sk-top-secret");
    expect(saveProvider).toHaveBeenCalledWith(
      USER_ID,
      "openai",
      expect.objectContaining({ apiKey: "sk-top-secret" }),
    );

    const analyzed = await app.inject({
      method: "POST",
      url: "/v1/ai/analyze",
      headers: { cookie: COOKIE },
      payload: { provider: "openai", leagueId: LEAGUE_ID, question: "Who should I start?" },
    });
    expect(analyzed.statusCode).toBe(200);
    expect(analyzed.json()).toMatchObject({ answer: "Start Reed. [Decision Desk]" });
    expect(analyzeLeague).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: "openai",
      leagueId: LEAGUE_ID,
      question: "Who should I start?",
    });

    const feature = await app.inject({
      method: "POST",
      url: "/v1/ai/features/waiver-scan",
      headers: { cookie: COOKIE },
      payload: {
        provider: "gemini",
        leagueId: LEAGUE_ID,
        instructions: "Prefer rest-of-season depth.",
      },
    });
    expect(feature.statusCode).toBe(200);
    expect(feature.json()).toMatchObject({
      feature: "waiver-scan",
      answer: "Hold this week. [Decision Desk]",
    });
    expect(generateFeature).toHaveBeenCalledWith({
      userId: USER_ID,
      feature: "waiver-scan",
      provider: "gemini",
      leagueId: LEAGUE_ID,
      instructions: "Prefer rest-of-season depth.",
    });
    await app.close();
  });
});
