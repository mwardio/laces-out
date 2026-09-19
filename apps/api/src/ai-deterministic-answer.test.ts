import { expect, it } from "vitest";
import { deterministicFeatureAnswer } from "./ai-deterministic-answer.js";

it("keeps close-call qualifications and statistics cutoff in the deterministic fallback", () => {
  const answer = deterministicFeatureAnswer([
    {
      name: "get_lineup_recommendation",
      resultJson: "{}",
      outcome: {
        state: "ok",
        provenance: {
          algorithmVersion: "test",
          inputChecksum: "a".repeat(64),
          checksumScope: "decision-snapshot-provenance",
          generatedAt: null,
          warnings: [],
        },
        data: {
          projectionFreshness: { label: "Stats through 2026 Week 1" },
          lineup: {
            state: "available",
            feasible: true,
            currentProjectedPoints: 100,
            optimalProjectedPoints: 101,
            notes: ["Forecast disagreement: ESPN favors Player C instead of Player D."],
            changes: [
              {
                slotLabel: "FLEX",
                add: { name: "Player A" },
                remove: { name: "Player B" },
                projectedPointDelta: 1,
                assessment: {
                  strength: "close-call",
                  explanation: "The projected outcome ranges overlap.",
                },
              },
            ],
          },
        },
      },
    },
  ]);
  expect(answer).toContain("Close call: the model leans toward Player A over Player B");
  expect(answer).toContain("ranges overlap");
  expect(answer).toContain("Stats through 2026 Week 1");
  expect(answer).toContain("ESPN favors Player C instead of Player D");
});

function answerForLineup(lineup: unknown): string {
  return deterministicFeatureAnswer([
    {
      name: "get_lineup_recommendation",
      resultJson: "{}",
      outcome: {
        state: "ok",
        provenance: {
          algorithmVersion: "test",
          inputChecksum: "a".repeat(64),
          checksumScope: "decision-snapshot-provenance",
          generatedAt: null,
          warnings: [],
        },
        data: { lineup },
      },
    },
  ]);
}

it.each(["unrated", undefined])(
  "does not turn a %s assessment into a confident start instruction",
  (strength) => {
    const answer = answerForLineup({
      state: "available",
      feasible: true,
      changes: [
        {
          slotLabel: "FLEX",
          add: { name: "Player A" },
          remove: { name: "Player B" },
          projectedPointDelta: -2,
          ...(strength
            ? {
                assessment: {
                  strength,
                  explanation: "This move only makes sense as part of the complete lineup plan.",
                },
              }
            : {}),
        },
      ],
    });
    expect(answer).toContain("Review the proposed move");
    expect(answer).toContain("-2 projected points");
    expect(answer).not.toContain("Start Player A");
    if (strength) expect(answer).toContain("complete lineup plan");
  },
);

it.each([false, undefined])(
  "withholds an optimized-lineup claim when feasibility is %s",
  (feasible) => {
    for (const changes of [
      [],
      [{ slotLabel: "FLEX", add: { name: "Player A" }, projectedPointDelta: 4 }],
    ]) {
      const answer = answerForLineup({ state: "available", feasible, changes });
      expect(answer).toContain("A complete legal starting lineup is unavailable");
      expect(answer).not.toContain("Player A");
      expect(answer).not.toContain("highest total");
    }
  },
);

it.each(["add", "remove"])("preserves an unrated explanation for an %s-only slot move", (side) => {
  const answer = answerForLineup({
    state: "available",
    feasible: true,
    changes: [
      {
        slotLabel: "FLEX",
        [side]: { name: "Player A" },
        assessment: {
          strength: "unrated",
          explanation: "A two-player uncertainty comparison is unavailable for this slot change.",
        },
      },
    ],
  });
  expect(answer).toContain("Proposed");
  expect(answer).toContain("Player A");
  expect(answer).toContain("A two-player uncertainty comparison is unavailable");
  expect(answer).not.toMatch(/- (Start|Bench) /u);
});

it("does not invent an alternative lineup when inputs are unavailable", () => {
  expect(
    deterministicFeatureAnswer([
      {
        name: "get_lineup_recommendation",
        resultJson: "{}",
        outcome: {
          state: "unavailable",
          code: "PROJECTION_COVERAGE_INCOMPLETE",
          message: "Week 1 inputs are missing.",
        },
      },
    ]),
  ).toContain("unavailable: Week 1 inputs are missing");
});
