/**
 * The live ROS scenario-count contract.
 *
 * The engine releases at `FIRST_PARTY_ROS_DEFAULT_SCENARIOS` and diagnoses convergence against
 * `FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS`, while `player_ros_projection_summaries`, its
 * insert trigger, and `buildFirstPartyRosPlayerPersistenceRow` independently restated a 4096 cap.
 * Three copies of one number is what let a releasable 12288-path projection fail during
 * persistence, so these tests assert that every remaining statement of the bound is *derived* from
 * the engine constants — including the two that cannot literally import them (the migration SQL and
 * the generated Drizzle check), which are pinned by textual assertion instead.
 *
 * The end-to-end proof that the real default path persists lives in
 * `first-party-ros-scenario-contract.pg.test.ts`, which runs it against real PostgreSQL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  projectFirstPartyRestOfSeason,
  type FirstPartyRosProjectionInput,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_ROS_LIVE_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_LIVE_RELEASE_SCENARIOS,
  diagnoseBoundedFirstPartyRosConvergence,
} from "./first-party-ros-candidates.js";
import { buildFirstPartyRosPlayerPersistenceRow } from "./first-party-ros-publication.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepositoryFile(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

const scoringProfile: ProjectionScoringProfile = {
  id: "scenario-contract-ppr",
  version: "1",
  rules: [
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
  ],
};

const components = { receptions: 5, receiving_yards: 60, receiving_touchdowns: 0.4 };
const elasticities = {
  receptions: { role: 1, production: 1 },
  receiving_yards: { role: 1, production: 1 },
  receiving_touchdowns: { role: 1, production: 1.2 },
};

function projectionInput(overrides: Partial<FirstPartyRosProjectionInput> = {}) {
  const weeks = Array.from({ length: 4 }, (_, index) => ({
    season: 2026,
    week: 15 + index,
    scheduled: true,
    bye: false,
    contextualComponents: components,
    recencyComponents: components,
    componentElasticities: elasticities,
  }));
  return {
    playerId: "11111111-1111-4111-8111-111111111111",
    position: "WR",
    season: 2026,
    asOfWeek: 14,
    asOfAt: "2026-12-15T18:00:00.000Z",
    windowStartWeek: 15,
    windowEndWeek: 18,
    strategy: "contextual",
    weeks,
    availability: {
      state: "active",
      newAbsenceProbability: 0.05,
      recoveryProbability: 0.5,
      reserveRecoveryProbability: 0.1,
      limitedRoleMultiplier: 0.85,
      returnRoleMultiplier: 0.75,
    },
    role: {
      currentMultiplier: 1,
      persistence: 0.8,
      innovationVolatility: 0.1,
      weeklyProductionVolatility: 0.4,
      minimumMultiplier: 0.2,
      maximumMultiplier: 3,
    },
    scoringProfile,
    inputChecksum: "f".repeat(64),
    weeklyModelVersion: "scenario-contract:contextual:weekly",
    seed: "scenario-contract",
    ...overrides,
  } satisfies FirstPartyRosProjectionInput;
}

describe("the ROS scenario-count contract is stated once", () => {
  it("uses the engine's own release and reference counts on the live rail", () => {
    expect(FIRST_PARTY_ROS_LIVE_RELEASE_SCENARIOS).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    expect(FIRST_PARTY_ROS_LIVE_CONVERGENCE_REFERENCE_SCENARIOS).toBe(
      FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    );
    // The whole point of Task 9.0: what the rail releases is what the store must accept.
    expect(FIRST_PARTY_ROS_DEFAULT_SCENARIOS).toBeLessThanOrEqual(
      FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
    );
    expect(FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS).toBeLessThanOrEqual(
      FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
    );
  });

  it("keeps the Drizzle summary check derived from the engine bounds", () => {
    const schema = readRepositoryFile("packages/db/src/schema.ts");
    expect(schema).toContain(
      "sql`${table.scenarioCount} between ${sql.raw(String(FIRST_PARTY_ROS_MINIMUM_SCENARIOS))} and ${sql.raw(String(FIRST_PARTY_ROS_MAXIMUM_SCENARIOS))}`",
    );
    // A bare numeric cap in this constraint is the exact defect Task 9.0 removed.
    expect(schema).not.toContain("${table.scenarioCount} between 128 and 4096");
  });

  it("pins migration 0025's SQL literals to the engine bounds", () => {
    // SQL cannot import a TypeScript constant, so the literals are asserted instead. If the engine
    // ever moves its path counts, this fails and the migration must be followed by a new one.
    const migration = readRepositoryFile("packages/db/migrations/0025_ros_scenario_contract.sql");
    expect(migration).toContain(
      `CHECK ("player_ros_projection_summaries"."scenario_count" between ${FIRST_PARTY_ROS_MINIMUM_SCENARIOS} and ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS})`,
    );
    expect(migration).toContain(
      `OR (convergence_diagnostic->>'referenceScenarioCount')::integer > ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
    );
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "enforce_player_ros_projection_scope"');
    // Forward-only and widening-only: no retained evidence is rewritten or dropped.
    expect(migration).not.toMatch(/\bDROP TABLE\b|\bDELETE FROM\b|\bTRUNCATE\b|\bDROP TRIGGER\b/u);
  });

  it("retains every interval and calibration check the 0016 trigger enforced", () => {
    const original = readRepositoryFile("packages/db/migrations/0016_familiar_firebrand.sql");
    const migration = readRepositoryFile("packages/db/migrations/0025_ros_scenario_contract.sql");
    const originalBody = original.slice(
      original.indexOf('CREATE FUNCTION "enforce_player_ros_projection_scope"'),
    );
    const replacedBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION "enforce_player_ros_projection_scope"'),
    );
    const normalize = (body: string) =>
      body
        .slice(0, body.indexOf("$$;") + 3)
        .replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION")
        .replace(
          `OR (convergence_diagnostic->>'referenceScenarioCount')::integer > ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
          "OR (convergence_diagnostic->>'referenceScenarioCount')::integer > 4096",
        );
    // Byte-identical apart from the widened reference bound: the derived interval-calibration
    // evidence, availability reconciliation, and totals checks are all carried over unchanged.
    expect(normalize(replacedBody)).toBe(normalize(originalBody));
  });
});

describe("buildFirstPartyRosPlayerPersistenceRow scenario bounds", () => {
  function releasedPlayer(scenarioCount: number) {
    const projection = projectFirstPartyRestOfSeason(projectionInput({ scenarioCount }));
    return {
      playerId: "11111111-1111-4111-8111-111111111111",
      bucket: "one-to-four" as const,
      strategy: "contextual" as const,
      projection,
    };
  }

  it("persists the engine's standard release path count", () => {
    const row = buildFirstPartyRosPlayerPersistenceRow(
      releasedPlayer(FIRST_PARTY_ROS_DEFAULT_SCENARIOS),
    );
    expect(row.summary.scenarioCount).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    expect(row.summary.scenarioCount).toBe(12_288);
  });

  it("persists a run made at the convergence reference count", () => {
    const row = buildFirstPartyRosPlayerPersistenceRow(
      releasedPlayer(FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS),
    );
    expect(row.summary.scenarioCount).toBe(FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS);
  });

  it("fails closed on an out-of-contract scenario count", () => {
    const belowFloor = releasedPlayer(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    const spoofed = {
      ...belowFloor,
      projection: {
        ...belowFloor.projection,
        provenance: {
          ...belowFloor.projection.provenance,
          scenarioCount: FIRST_PARTY_ROS_MAXIMUM_SCENARIOS + 2,
        },
      },
    };
    expect(() => buildFirstPartyRosPlayerPersistenceRow(spoofed)).toThrow(RangeError);
    expect(() =>
      buildFirstPartyRosPlayerPersistenceRow({
        ...belowFloor,
        projection: {
          ...belowFloor.projection,
          provenance: {
            ...belowFloor.projection.provenance,
            scenarioCount: FIRST_PARTY_ROS_MINIMUM_SCENARIOS - 2,
          },
        },
      }),
    ).toThrow(RangeError);
  });
});

describe("diagnoseBoundedFirstPartyRosConvergence", () => {
  // Small counts keep this suite fast; the real 12288-vs-16384 comparison is exercised end to end
  // by the PostgreSQL suite.
  const releaseScenarioCount = 256;
  const referenceScenarioCount = 512;

  it("reuses an already-computed release run instead of simulating it twice", () => {
    const input = projectionInput();
    const release = projectFirstPartyRestOfSeason({
      ...input,
      scenarioCount: releaseScenarioCount,
    });
    const recomputed = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: input,
      releaseScenarioCount,
      referenceScenarioCount,
    });
    const reused = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: input,
      releaseScenarioCount,
      referenceScenarioCount,
      releaseProjection: release,
    });
    // Reuse is byte-equivalent: the release paths are a seeded prefix either way.
    expect(reused).toEqual(recomputed);
  });

  it("defaults to the engine's release and reference counts", () => {
    const diagnostic = diagnoseBoundedFirstPartyRosConvergence({
      projectionInput: projectionInput(),
      releaseProjection: projectFirstPartyRestOfSeason(projectionInput()),
    });
    expect(diagnostic.lowerScenarioCount).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    expect(diagnostic.referenceScenarioCount).toBe(FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS);
  });

  it("rejects a reused run that is not the run it would have computed", () => {
    const input = projectionInput();
    const wrongCount = projectFirstPartyRestOfSeason({ ...input, scenarioCount: 512 });
    expect(() =>
      diagnoseBoundedFirstPartyRosConvergence({
        projectionInput: input,
        releaseScenarioCount,
        referenceScenarioCount,
        releaseProjection: wrongCount,
      }),
    ).toThrow(RangeError);

    const wrongInput = projectFirstPartyRestOfSeason({
      ...input,
      inputChecksum: "a".repeat(64),
      scenarioCount: releaseScenarioCount,
    });
    expect(() =>
      diagnoseBoundedFirstPartyRosConvergence({
        projectionInput: input,
        releaseScenarioCount,
        referenceScenarioCount,
        releaseProjection: wrongInput,
      }),
    ).toThrow(RangeError);
  });

  it("fails closed on an out-of-contract scenario count", () => {
    expect(() =>
      diagnoseBoundedFirstPartyRosConvergence({
        projectionInput: projectionInput(),
        releaseScenarioCount: FIRST_PARTY_ROS_MINIMUM_SCENARIOS - 2,
      }),
    ).toThrow(RangeError);
    expect(() =>
      diagnoseBoundedFirstPartyRosConvergence({
        projectionInput: projectionInput(),
        referenceScenarioCount: FIRST_PARTY_ROS_MAXIMUM_SCENARIOS + 2,
      }),
    ).toThrow(RangeError);
    // A reference no larger than the release run cannot diagnose anything.
    expect(() =>
      diagnoseBoundedFirstPartyRosConvergence({
        projectionInput: projectionInput(),
        releaseScenarioCount: 512,
        referenceScenarioCount: 256,
      }),
    ).toThrow(RangeError);
  });
});
