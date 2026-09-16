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
