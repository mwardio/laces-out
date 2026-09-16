import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  runFirstPartyProjectionBacktest,
  type FirstPartyProjectionBacktest,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import {
  auditLineupChallenger,
  LINEUP_CHALLENGERS,
} from "../../../packages/projections/src/lineup-model-audit.js";

const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: tsx apps/worker/scripts/audit-lineup-challengers.ts HISTORY.json [BACKTEST-CACHE.json]",
  );
const raw = await readFile(path, "utf8");
const history = JSON.parse(raw) as FirstPartyWeeklyStatLine[];
if (
  !Array.isArray(history) ||
  history.some(
    (row) =>
      !row.playerId ||
      !Number.isInteger(row.season) ||
      !Number.isInteger(row.week) ||
      !row.components,
  )
)
  throw new Error("Invalid normalized history");
const historySha256 = createHash("sha256").update(raw).digest("hex");
const cachePath = process.argv[3];
type AuditBacktest = Pick<FirstPartyProjectionBacktest, "predictions" | "evaluation">;
let backtest: AuditBacktest | undefined;
if (cachePath) {
  let cachedRaw: string | undefined;
  try {
    cachedRaw = await readFile(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as AuditBacktest & {
      historySha256: string;
      modelVersion: string;
    };
    if (
      cached.historySha256 !== historySha256 ||
      cached.modelVersion !== FIRST_PARTY_PROJECTION_MODEL_VERSION ||
      !Array.isArray(cached.predictions) ||
      !cached.evaluation
    )
      throw new Error("Backtest cache does not match the history, model, and audit contract");
    backtest = cached;
  }
}
if (!backtest) {
  console.error("Running locked historical backtest...");
  backtest = runFirstPartyProjectionBacktest(history);
  if (cachePath)
    await writeFile(
      cachePath,
      JSON.stringify({
        historySha256,
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        predictions: backtest.predictions,
        evaluation: backtest.evaluation,
      }),
    );
}
const profiles: ProjectionScoringProfile[] = [0, 1].map((ppr) => ({
  id: ppr ? "ppr" : "standard",
  rules: [
    { statId: "receptions", points: ppr },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "rushing_touchdowns", points: 6 },
    { statId: "fumbles_lost", points: -2 },
  ],
}));
const results = [];
for (const profile of profiles)
  for (const variant of LINEUP_CHALLENGERS) {
    console.error(`Evaluating ${variant} under ${profile.id} scoring...`);
    results.push(
      auditLineupChallenger({ history, predictions: backtest.predictions, profile, variant }),
    );
  }
console.log(
  JSON.stringify(
    {
      historySha256,
      historyRows: history.length,
      evaluation: backtest.evaluation,
      note: "Fixed offline ablations against recency-only. Cohort errors and pair regret use raw component centers. Separate rolling champion/point-calibration results use prior observations; final-policy calibration is a diagnostic with a policy selected over the full window. No production promotion. Includes prior-relevant DNP outcomes. Pair regret is an all-pairs FLEX benchmark, not a roster replay.",
      results,
    },
    null,
    2,
  ),
);
