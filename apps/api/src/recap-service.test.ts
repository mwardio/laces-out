import { describe, expect, it, vi } from "vitest";

import {
  RECAP_COOLDOWN_SECONDS,
  RecapService,
  type AcquireGenerationResult,
  type GenerationAvailability,
  type RecapAiPort,
  type RecapCardRow,
  type RecapGeneration,
  type RecapMembershipRow,
  type RecapRepository,
  type SaveCardInput,
  type SaveRecapInput,
  type StoredRecapRow,
} from "./recap-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_TEAM_ID = "40000000-0000-4000-8000-000000000002";
const LEASE_TOKEN = "50000000-0000-4000-8000-000000000001";

const AWARDS_AVAILABLE = {
  weeklyAwards: { state: "available", week: 5, awards: [], withheld: [], definitions: [] },
};
const AWARDS_UNAVAILABLE = {
  weeklyAwards: {
    state: "unavailable",
    reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE", message: "No completed week yet." }],
  },
};

class FakeRepository implements RecapRepository {
  membership: RecapMembershipRow | undefined = { role: "member", claimedFantasyTeamId: TEAM_ID };
  season: { id: string } | undefined = { id: SEASON_ID };
  teams = [
    { id: TEAM_ID, name: "Budget Ballers" },
    { id: OTHER_TEAM_ID, name: "Waiver Theory" },
  ];
  cards: RecapCardRow[] = [];
  storedRecap: StoredRecapRow | undefined = undefined;
  spiceLevel: "mild" | "medium" | "scorched" | undefined = "medium";
  savedCards: SaveCardInput[] = [];
  deletedCards: { leagueSeasonId: string; fantasyTeamId: string }[] = [];
  savedRecaps: SaveRecapInput[] = [];
  savedSpice: ("mild" | "medium" | "scorched")[] = [];
  abandoned: { week: number; leaseToken: string }[] = [];
  generationAvailability: GenerationAvailability = { state: "available" };
  /** Set to make the guard behave like the real single-writer lease under concurrency. */
  exclusiveLease = false;

  findMembership() {
    return Promise.resolve(this.membership);
  }
  findLatestSeason() {
    return Promise.resolve(this.season);
  }
  listTeams() {
    return Promise.resolve(this.teams);
  }
  listCards() {
    return Promise.resolve(this.cards);
  }
  saveCard(input: SaveCardInput) {
    this.savedCards.push(input);
    const row: RecapCardRow = {
      fantasyTeamId: input.fantasyTeamId,
      teamName:
        this.teams.find((team) => team.id === input.fantasyTeamId)?.name ?? "Budget Ballers",
      body: input.body,
      updatedAt: new Date("2026-10-07T16:20:00.000Z"),
      updatedByDisplayName: "League Guru",
    };
    return Promise.resolve(row);
  }
  deleteCard(leagueSeasonId: string, fantasyTeamId: string) {
    this.deletedCards.push({ leagueSeasonId, fantasyTeamId });
    const before = this.cards.length;
    this.cards = this.cards.filter((card) => card.fantasyTeamId !== fantasyTeamId);
    return Promise.resolve(this.cards.length < before);
  }
  findRecap() {
    return Promise.resolve(this.storedRecap);
  }
  saveRecapAndCompleteGeneration(input: SaveRecapInput, _leaseToken: string, _completedAt: Date) {
    void _leaseToken;
    void _completedAt;
    this.savedRecaps.push(input);
    const row: StoredRecapRow = {
      week: input.week,
      body: input.body,
      provider: input.provider,
      model: input.model,
      spiceLevel: input.spiceLevel,
      generatedByDisplayName: "League Guru",
      generatedAt: new Date("2026-10-07T16:20:00.000Z"),
    };
    this.storedRecap = row;
    this.generationAvailability = {
      state: "cooldown",
      retryAfterSeconds: RECAP_COOLDOWN_SECONDS,
    };
    return Promise.resolve(row);
  }
  getGenerationAvailability() {
    return Promise.resolve(this.generationAvailability);
  }
  acquireGeneration(): Promise<AcquireGenerationResult> {
    if (this.generationAvailability.state !== "available") {
      return Promise.resolve(this.generationAvailability);
    }
    // The real guard is a single atomic upsert; the fake takes the lease the same way so a second
    // caller in the same tick sees in-progress rather than a second lease.
    if (this.exclusiveLease) {
      this.generationAvailability = { state: "in-progress", retryAfterSeconds: 30 };
    }
    return Promise.resolve({ state: "acquired" as const, leaseToken: LEASE_TOKEN });
  }
  abandonGeneration(_leagueSeasonId: string, week: number, leaseToken: string) {
    void _leagueSeasonId;
    this.abandoned.push({ week, leaseToken });
    this.generationAvailability = { state: "available" };
    return Promise.resolve();
  }
  getSpiceLevel() {
    return Promise.resolve(this.spiceLevel);
  }
  saveSpiceLevel(_leagueId: string, spiceLevel: "mild" | "medium" | "scorched") {
    void _leagueId;
    this.savedSpice.push(spiceLevel);
    this.spiceLevel = spiceLevel;
    return Promise.resolve();
  }
}

type GenerateFeatureInput = Parameters<RecapAiPort["generateFeature"]>[0];

/** A spy that still satisfies `RecapAiPort`, so the fixture never has to cast. */
function fakeAi(
  implementation: (input: GenerateFeatureInput) => Promise<RecapGeneration> = (input) =>
    Promise.resolve({
      answer: "### Week 5 got weird",
      provider: input.provider ?? "gemini",
      model: "gemini-3.6-flash",
    }),
) {
  return { generateFeature: vi.fn(implementation) };
}

function fixture(input?: {
  repository?: FakeRepository;
  snapshot?: unknown;
  ai?: ReturnType<typeof fakeAi>;
}) {
  const repository = input?.repository ?? new FakeRepository();
  const ai = input?.ai ?? fakeAi();
  const analyticsSnapshot = vi.fn(
    (userId: string, leagueId: string, options?: { readonly weeklyAwardsWeek?: number }) => {
      void userId;
      void leagueId;
      void options;
      return Promise.resolve(input?.snapshot ?? AWARDS_AVAILABLE);
    },
  );
  const service = new RecapService({
    repository,
    analytics: { getSnapshot: analyticsSnapshot },
    ai,
  });
  return { repository, ai, analyticsSnapshot, service };
}

describe("recap read", () => {
  it("hides the league from non-members", async () => {
    const repository = new FakeRepository();
    repository.membership = undefined;
    const { service } = fixture({ repository });

    await expect(service.getRecap(USER_ID, LEAGUE_ID, 5)).resolves.toBeUndefined();
  });

  it("returns the stored recap with the league spice level", async () => {
    const repository = new FakeRepository();
    repository.spiceLevel = "scorched";
    repository.storedRecap = {
      week: 5,
      body: "The recap",
      provider: "gemini",
      model: "gemini-3.6-flash",
      spiceLevel: "mild",
      generatedByDisplayName: "League Guru",
      generatedAt: new Date("2026-10-07T16:20:00.000Z"),
    };
    const { service } = fixture({ repository });

    const response = await service.getRecap(USER_ID, LEAGUE_ID, 5);

    // The configured dial and the level the stored recap was written at are reported separately.
    expect(response).toEqual({
      leagueId: LEAGUE_ID,
      week: 5,
      configuredSpiceLevel: "scorched",
      generation: { state: "available" },
      recap: {
        week: 5,
        body: "The recap",
        provider: "gemini",
        model: "gemini-3.6-flash",
        spiceLevel: "mild",
        generatedByDisplayName: "League Guru",
        generatedAt: "2026-10-07T16:20:00.000Z",
      },
    });
  });

  it("returns a null recap when none is stored", async () => {
    const { service } = fixture();

    const response = await service.getRecap(USER_ID, LEAGUE_ID, 5);

    expect(response?.recap).toBeNull();
    expect(response?.configuredSpiceLevel).toBe("medium");
  });

  it("reports the awards reason when the requested week cannot be generated", async () => {
    const { service } = fixture({ snapshot: AWARDS_UNAVAILABLE });

    const response = await service.getRecap(USER_ID, LEAGUE_ID, 5);

    expect(response?.generation).toEqual({
      state: "unavailable",
      reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE", message: "No completed week yet." }],
    });
  });

  it("reads the requested week's awards rather than the latest", async () => {
    const { service, analyticsSnapshot } = fixture();

    await service.getRecap(USER_ID, LEAGUE_ID, 3);

    expect(analyticsSnapshot).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, { weeklyAwardsWeek: 3 });
  });

  it("surfaces an active cooldown without hiding the stored recap", async () => {
    const repository = new FakeRepository();
    repository.generationAvailability = { state: "cooldown", retryAfterSeconds: 30 };
    repository.storedRecap = {
      week: 5,
      body: "The recap",
      provider: "gemini",
      model: "gemini-3.6-flash",
      spiceLevel: "medium",
      generatedByDisplayName: null,
      generatedAt: new Date("2026-10-07T16:20:00.000Z"),
    };
    const { service } = fixture({ repository });

    const response = await service.getRecap(USER_ID, LEAGUE_ID, 5);

    expect(response?.generation).toEqual({ state: "cooldown", retryAfterSeconds: 30 });
    expect(response?.recap?.body).toBe("The recap");
  });

  it("explains an unsynchronized league without reading awards", async () => {
    const repository = new FakeRepository();
    repository.season = undefined;
    const { service, analyticsSnapshot } = fixture({ repository });

    const response = await service.getRecap(USER_ID, LEAGUE_ID, 5);

    expect(response?.generation).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "LEAGUE_SEASON_UNAVAILABLE" }],
    });
    expect(response?.recap).toBeNull();
    expect(analyticsSnapshot).not.toHaveBeenCalled();
  });
});

describe("recap generation", () => {
  it("hides the league from non-members", async () => {
    const repository = new FakeRepository();
    repository.membership = undefined;
    const { service } = fixture({ repository });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toBeUndefined();
  });

  it("reports unconfigured when no AI service is wired", async () => {
    const repository = new FakeRepository();
    const service = new RecapService({
      repository,
      analytics: { getSnapshot: () => Promise.resolve(AWARDS_AVAILABLE) },
    });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toEqual({
      state: "unconfigured",
    });
  });

  it("refuses when the awards section is unavailable and never takes a lease", async () => {
    const { service, ai, repository } = fixture({ snapshot: AWARDS_UNAVAILABLE });

    const result = await service.generate(USER_ID, LEAGUE_ID, { week: 5 });

    expect(result).toMatchObject({ state: "unavailable" });
    expect(ai.generateFeature).not.toHaveBeenCalled();
    expect(repository.savedRecaps).toEqual([]);
    expect(repository.generationAvailability).toEqual({ state: "available" });
  });

  it("passes a requested completed historical week through to analytics and AI", async () => {
    const historical = {
      weeklyAwards: {
        state: "available",
        week: 4,
        awards: [],
        withheld: [],
        definitions: [],
      },
    };
    const { service, ai, analyticsSnapshot } = fixture({ snapshot: historical });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 4 })).resolves.toMatchObject({
      state: "generated",
      response: { week: 4 },
    });
    expect(analyticsSnapshot).toHaveBeenCalledWith(USER_ID, LEAGUE_ID, { weeklyAwardsWeek: 4 });
    expect(ai.generateFeature).toHaveBeenCalledWith(
      expect.objectContaining({ weeklyAwardsWeek: 4, useIncludedProvider: true }),
    );
  });

  it("uses the spice-aware included route only when no personal provider is selected", async () => {
    const { service, ai } = fixture();

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toMatchObject({
      state: "generated",
    });
    expect(ai.generateFeature).toHaveBeenCalledWith({
      userId: USER_ID,
      feature: "weekly-recap",
      leagueId: LEAGUE_ID,
      weeklyAwardsWeek: 5,
      recapSpiceLevel: "medium",
      useIncludedProvider: true,
    });
  });

  it("generates through the AI port and persists the answer", async () => {
    const { service, ai, repository } = fixture();

    const result = await service.generate(USER_ID, LEAGUE_ID, { week: 5, provider: "openai" });

    expect(ai.generateFeature).toHaveBeenCalledWith({
      userId: USER_ID,
      feature: "weekly-recap",
      leagueId: LEAGUE_ID,
      provider: "openai",
      weeklyAwardsWeek: 5,
      recapSpiceLevel: "medium",
    });
    expect(repository.savedRecaps).toEqual([
      {
        leagueSeasonId: SEASON_ID,
        week: 5,
        body: "### Week 5 got weird",
        provider: "openai",
        model: "gemini-3.6-flash",
        spiceLevel: "medium",
        generatedByUserId: USER_ID,
      },
    ]);
    expect(result).toMatchObject({
      state: "generated",
      response: {
        week: 5,
        generation: { state: "cooldown", retryAfterSeconds: RECAP_COOLDOWN_SECONDS },
        recap: { body: "### Week 5 got weird", spiceLevel: "medium" },
      },
    });
  });

  it("binds a consented native request to the expected Mild tone", async () => {
    const repository = new FakeRepository();
    repository.spiceLevel = "mild";
    const { service, ai } = fixture({ repository });

    await expect(
      service.generate(USER_ID, LEAGUE_ID, {
        week: 5,
        provider: "gemini",
        expectedSpiceLevel: "mild",
      }),
    ).resolves.toMatchObject({
      state: "generated",
      response: {
        configuredSpiceLevel: "mild",
        recap: { provider: "gemini", spiceLevel: "mild" },
      },
    });
    expect(ai.generateFeature).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini", recapSpiceLevel: "mild" }),
    );
  });

  it("rejects a consented request when the league tone changed before generation", async () => {
    const repository = new FakeRepository();
    repository.spiceLevel = "medium";
    const { service, ai } = fixture({ repository });

    await expect(
      service.generate(USER_ID, LEAGUE_ID, {
        week: 5,
        provider: "gemini",
        expectedSpiceLevel: "mild",
      }),
    ).resolves.toEqual({ state: "configuration-changed" });
    expect(ai.generateFeature).not.toHaveBeenCalled();
    expect(repository.savedRecaps).toEqual([]);
    expect(repository.generationAvailability).toEqual({ state: "available" });
  });

  it("abandons generation if the AI port returns a provider other than the consented one", async () => {
    const repository = new FakeRepository();
    const ai = fakeAi(() =>
      Promise.resolve({
        answer: "Wrong provider",
        provider: "gemini",
        model: "gemini-3.6-flash",
      }),
    );
    const { service } = fixture({ repository, ai });

    await expect(
      service.generate(USER_ID, LEAGUE_ID, { week: 5, provider: "openai" }),
    ).rejects.toThrow(/did not match/u);
    expect(repository.savedRecaps).toEqual([]);
    expect(repository.abandoned).toEqual([{ week: 5, leaseToken: LEASE_TOKEN }]);
  });

  it("records the spice level in force at generation time", async () => {
    const repository = new FakeRepository();
    repository.spiceLevel = "scorched";
    const { service } = fixture({ repository });

    await service.generate(USER_ID, LEAGUE_ID, { week: 5 });
    // The dial moves afterwards; the stored recap keeps the level it was written at.
    await repository.saveSpiceLevel(LEAGUE_ID, "mild");

    expect(repository.savedRecaps[0]?.spiceLevel).toBe("scorched");
    expect(repository.storedRecap?.spiceLevel).toBe("scorched");
  });

  it("returns in-progress without calling the AI when another member holds the lease", async () => {
    const repository = new FakeRepository();
    repository.generationAvailability = { state: "in-progress", retryAfterSeconds: 20 };
    const { service, ai } = fixture({ repository });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toEqual({
      state: "in-progress",
      retryAfterSeconds: 20,
    });
    expect(ai.generateFeature).not.toHaveBeenCalled();
  });

  it("returns cooldown without calling the AI during the post-success window", async () => {
    const repository = new FakeRepository();
    repository.generationAvailability = { state: "cooldown", retryAfterSeconds: 12 };
    const { service, ai } = fixture({ repository });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toEqual({
      state: "cooldown",
      retryAfterSeconds: 12,
    });
    expect(ai.generateFeature).not.toHaveBeenCalled();
  });

  it("releases the lease on a provider failure without replacing the stored recap", async () => {
    const repository = new FakeRepository();
    repository.storedRecap = {
      week: 5,
      body: "The previous recap",
      provider: "gemini",
      model: "gemini-3.6-flash",
      spiceLevel: "medium",
      generatedByDisplayName: "League Guru",
      generatedAt: new Date("2026-10-07T16:20:00.000Z"),
    };
    const ai = fakeAi(() => Promise.reject(new Error("provider refused")));
    const { service } = fixture({ repository, ai });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).rejects.toThrow(
      /provider refused/u,
    );
    expect(repository.savedRecaps).toEqual([]);
    expect(repository.storedRecap.body).toBe("The previous recap");
    expect(repository.abandoned).toEqual([{ week: 5, leaseToken: LEASE_TOKEN }]);
    // A failed generation starts no cooldown, so the next member may retry immediately.
    expect(repository.generationAvailability).toEqual({ state: "available" });
  });

  it("lets exactly one of two concurrent rerolls reach the provider", async () => {
    const repository = new FakeRepository();
    repository.exclusiveLease = true;
    const { service, ai } = fixture({ repository });

    const results = await Promise.all([
      service.generate(USER_ID, LEAGUE_ID, { week: 5 }),
      service.generate(USER_ID, LEAGUE_ID, { week: 5 }),
    ]);

    expect(ai.generateFeature).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result?.state === "generated")).toHaveLength(1);
    expect(results.filter((result) => result?.state === "in-progress")).toHaveLength(1);
  });

  it("refuses when the league has no synchronized season", async () => {
    const repository = new FakeRepository();
    repository.season = undefined;
    const { service, ai } = fixture({ repository });

    await expect(service.generate(USER_ID, LEAGUE_ID, { week: 5 })).resolves.toMatchObject({
      state: "unavailable",
    });
    expect(ai.generateFeature).not.toHaveBeenCalled();
  });
});

describe("persona cards", () => {
  it("hides the league from non-members", async () => {
    const repository = new FakeRepository();
    repository.membership = undefined;
    const { service } = fixture({ repository });

    await expect(service.listPersonaCards(USER_ID, LEAGUE_ID)).resolves.toBeUndefined();
  });

  it("keeps League Intel private from members", async () => {
    const { service } = fixture();

    await expect(service.listPersonaCards(USER_ID, LEAGUE_ID)).resolves.toEqual({
      state: "forbidden",
    });
  });

  it("lists one entry per team with null bodies for cardless teams", async () => {
    const repository = new FakeRepository();
    repository.membership = { role: "owner", claimedFantasyTeamId: TEAM_ID };
    repository.cards = [
      {
        fantasyTeamId: TEAM_ID,
        teamName: "Budget Ballers",
        body: "Fears kickers.",
        updatedAt: new Date("2026-10-01T12:00:00.000Z"),
        updatedByDisplayName: "League Guru",
      },
    ];
    const { service } = fixture({ repository });

    const list = await service.listPersonaCards(USER_ID, LEAGUE_ID);

    expect(list?.state).toBe("listed");
    expect(list?.state === "listed" ? list.list.cards : undefined).toEqual([
      {
        teamId: TEAM_ID,
        teamName: "Budget Ballers",
        body: "Fears kickers.",
        updatedAt: "2026-10-01T12:00:00.000Z",
        updatedByDisplayName: "League Guru",
      },
      {
        teamId: OTHER_TEAM_ID,
        teamName: "Waiver Theory",
        body: null,
        updatedAt: null,
        updatedByDisplayName: null,
      },
    ]);
  });

  it("keeps League Intel writes private from members", async () => {
    const { service, repository } = fixture();

    await expect(
      service.savePersonaCard(USER_ID, LEAGUE_ID, TEAM_ID, "Fears kickers."),
    ).resolves.toEqual({ state: "forbidden" });
    await expect(
      service.savePersonaCard(USER_ID, LEAGUE_ID, OTHER_TEAM_ID, "Nope."),
    ).resolves.toEqual({ state: "forbidden" });
    expect(repository.savedCards).toHaveLength(0);
  });

  it("reports the updater the repository read back rather than a browser guess", async () => {
    const repository = new FakeRepository();
    repository.membership = { role: "owner", claimedFantasyTeamId: TEAM_ID };
    const { service } = fixture({ repository });

    const saved = await service.savePersonaCard(USER_ID, LEAGUE_ID, TEAM_ID, "Fears kickers.");

    expect(saved).toEqual({
      state: "saved",
      card: {
        teamId: TEAM_ID,
        teamName: "Budget Ballers",
        body: "Fears kickers.",
        updatedAt: "2026-10-07T16:20:00.000Z",
        updatedByDisplayName: "League Guru",
      },
    });
  });

  it("lets a commissioner edit any card and flags unknown teams", async () => {
    const repository = new FakeRepository();
    repository.membership = { role: "commissioner", claimedFantasyTeamId: null };
    const { service } = fixture({ repository });

    await expect(
      service.savePersonaCard(USER_ID, LEAGUE_ID, OTHER_TEAM_ID, "Roast the process."),
    ).resolves.toMatchObject({ state: "saved" });
    await expect(
      service.savePersonaCard(USER_ID, LEAGUE_ID, "40000000-0000-4000-8000-000000000099", "x"),
    ).resolves.toEqual({ state: "unknown-team" });
  });

  it("lets an owner clear any card and refuses a member", async () => {
    const repository = new FakeRepository();
    repository.cards = [
      {
        fantasyTeamId: OTHER_TEAM_ID,
        teamName: "Waiver Theory",
        body: "Calls everyone champ.",
        updatedAt: new Date("2026-10-01T12:00:00.000Z"),
        updatedByDisplayName: "M. Lewis",
      },
    ];
    const { service } = fixture({ repository });

    await expect(service.deletePersonaCard(USER_ID, LEAGUE_ID, OTHER_TEAM_ID)).resolves.toEqual({
      state: "forbidden",
    });
    expect(repository.deletedCards).toEqual([]);

    repository.membership = { role: "owner", claimedFantasyTeamId: null };
    await expect(service.deletePersonaCard(USER_ID, LEAGUE_ID, OTHER_TEAM_ID)).resolves.toEqual({
      state: "deleted",
    });
    expect(repository.deletedCards).toEqual([
      { leagueSeasonId: SEASON_ID, fantasyTeamId: OTHER_TEAM_ID },
    ]);
    expect(repository.cards).toEqual([]);
  });

  it("flags an unknown team on delete rather than reporting a phantom clear", async () => {
    const repository = new FakeRepository();
    repository.membership = { role: "commissioner", claimedFantasyTeamId: null };
    const { service } = fixture({ repository });

    await expect(
      service.deletePersonaCard(USER_ID, LEAGUE_ID, "40000000-0000-4000-8000-000000000099"),
    ).resolves.toEqual({ state: "unknown-team" });
    expect(repository.deletedCards).toEqual([]);
  });
});

describe("recap settings", () => {
  it("restricts the spice dial to owner and commissioner roles", async () => {
    const { service, repository } = fixture();

    await expect(service.saveSettings(USER_ID, LEAGUE_ID, "scorched")).resolves.toEqual({
      state: "forbidden",
    });
    repository.membership = { role: "owner", claimedFantasyTeamId: null };
    await expect(service.saveSettings(USER_ID, LEAGUE_ID, "scorched")).resolves.toEqual({
      state: "saved",
      settings: { leagueId: LEAGUE_ID, spiceLevel: "scorched" },
    });
    expect(repository.savedSpice).toEqual(["scorched"]);
  });

  it("hides the league from non-members", async () => {
    const repository = new FakeRepository();
    repository.membership = undefined;
    const { service } = fixture({ repository });

    await expect(service.saveSettings(USER_ID, LEAGUE_ID, "mild")).resolves.toBeUndefined();
  });
});
