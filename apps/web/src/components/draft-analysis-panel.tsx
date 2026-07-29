"use client";

import { CircleAlert, Info, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, parseDraftAnalysis, type DraftAnalysisResponse } from "../lib/api-client";
import { LatestRequest } from "../lib/latest-request";
import styles from "./draft-analysis-panel.module.css";

type SnakeTeam = Extract<DraftAnalysisResponse["teams"][number], { mode: "SNAKE" }>;
type AuctionTeam = Extract<DraftAnalysisResponse["teams"][number], { mode: "AUCTION" }>;

type PanelState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly analysis: DraftAnalysisResponse };

export interface DraftAnalysisPanelProps {
  readonly draftId: string;
  readonly sequence: number;
  readonly mode: "SNAKE" | "AUCTION";
  /** False in the browser-local Practice Room, where no server draft exists to analyze. */
  readonly enabled: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // A non-JSON or empty body still deserves the status-aware fallback below.
  }
  return `${fallback} (${response.status})`;
}

function readableMoment(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function signed(value: number, digits = 1): string {
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(digits)}`;
}

function money(value: number): string {
  return `$${Math.round(value)}`;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/**
 * The engine's sign convention reads backwards to most managers: a positive `pickVsAdp` means the
 * player went *later* than the market expected. Spell the direction out rather than leaving a
 * bare signed number to be misread.
 */
function pickVsAdpLabel(value: number): string {
  if (value === 0) return "0.0 at ADP";
  return `${signed(value)} ${value > 0 ? "after ADP" : "before ADP"}`;
}

const snakeGradeLabel: Record<string, string> = {
  VALUE: "Value",
  AT_MARKET: "At market",
  REACH: "Reach",
  UNAVAILABLE: "No ADP",
};

const auctionGradeLabel: Record<string, string> = {
  VALUE: "Value",
  AT_MARKET: "At market",
  OVERPAY: "Overpay",
  UNAVAILABLE: "No baseline",
};

function gradeClass(classification: string): string {
  if (classification === "VALUE") return `${styles.chip} ${styles.chipValue}`;
  if (classification === "REACH" || classification === "OVERPAY") {
    return `${styles.chip} ${styles.chipCaution}`;
  }
  if (classification === "UNAVAILABLE") return `${styles.chip} ${styles.chipMuted}`;
  return `${styles.chip}`;
}

function warningText(warnings: readonly { readonly code: string; readonly message: string }[]) {
  return warnings.map((warning) => warning.message).join(" ");
}

function RosterRow({ team }: { readonly team: SnakeTeam | AuctionTeam }) {
  return (
    <div className={styles.rosterRow}>
      <dl className={styles.facts}>
        <div>
          <dt>Starters covered</dt>
          <dd>
            {team.roster.coveredStarterSlots} of {team.roster.starterSlots}
          </dd>
        </div>
        <div>
          <dt>Slots open</dt>
          <dd>
            {team.roster.openRosterSlots} of {team.roster.totalRosterSlots}
          </dd>
        </div>
        <div>
          <dt>Rostered</dt>
          <dd>{team.roster.rosteredPlayers}</dd>
        </div>
      </dl>
      {team.roster.openStarterSlots.length > 0 ? (
        <p className={styles.chipRow}>
          <span className={styles.chipLabel}>Uncovered starters</span>
          {team.roster.openStarterSlots.map((slot) => (
            <span className={`${styles.chip} ${styles.chipMuted}`} key={slot.slotId}>
              {slot.type}
            </span>
          ))}
        </p>
      ) : null}
      {team.roster.primaryPositionCounts.length > 0 ? (
        <p className={styles.chipRow}>
          <span className={styles.chipLabel}>Roster shape</span>
          {team.roster.primaryPositionCounts.map((row) => (
            <span className={styles.chip} key={row.position}>
              {row.position} {row.count}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function TeamStrength({ team }: { readonly team: SnakeTeam | AuctionTeam }) {
  if (team.teamStrength.status === "AVAILABLE") {
    return (
      <p className={styles.strength}>
        <ShieldCheck size={13} aria-hidden="true" />
        Projected starters {team.teamStrength.projectedStarterPoints.toFixed(1)} · league rank{" "}
        {team.teamStrength.leagueRank} of {team.teamStrength.rankedTeamCount}
      </p>
    );
  }
  return (
    <p className={`${styles.strength} ${styles.strengthMuted}`}>
      <Info size={13} aria-hidden="true" />
      Team strength withheld: {team.teamStrength.message}
    </p>
  );
}

function SnakeTeamCard({ team }: { readonly team: SnakeTeam }) {
  const headingId = `draft-analysis-team-${team.teamId}`;
  return (
    <section className={styles.team} aria-labelledby={headingId}>
      <div className={styles.teamHead}>
        <h3 id={headingId}>{team.name}</h3>
        <p className={styles.teamSummary}>
          {team.marketSummary.status === "UNAVAILABLE" ? (
            <span>No ADP coverage for these picks</span>
          ) : (
            <>
              <span>{team.marketSummary.values} value</span>
              <span aria-hidden="true">·</span>
              <span>{team.marketSummary.reaches} reach</span>
              <span aria-hidden="true">·</span>
              <span>
                {team.marketSummary.averagePickVsAdp === null
                  ? "No average"
                  : `avg ${pickVsAdpLabel(team.marketSummary.averagePickVsAdp)}`}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {team.marketSummary.coveredSelections} of {team.marketSummary.totalSelections}{" "}
                graded
              </span>
            </>
          )}
        </p>
      </div>
      <RosterRow team={team} />
      <TeamStrength team={team} />
      {team.selections.length === 0 ? (
        <p className={styles.empty}>No picks recorded for this team yet.</p>
      ) : (
        // A scrollable region needs to be reachable by keyboard, not only by pointer.
        <div
          className={styles.tableScroll}
          role="region"
          aria-label={`${team.name} selections`}
          tabIndex={0}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Pick</th>
                <th scope="col">Player</th>
                <th scope="col">ADP</th>
                <th scope="col">Vs ADP</th>
                <th scope="col">Grade</th>
                <th scope="col">Starter need</th>
                <th scope="col">Best alternative passed</th>
              </tr>
            </thead>
            <tbody>
              {team.selections.map((selection) => {
                const alternative = selection.missedAlternatives[0];
                return (
                  <tr key={selection.eventId}>
                    <td>{selection.overallPick}</td>
                    <th scope="row">{selection.playerName}</th>
                    <td>{selection.market.adp === null ? "—" : selection.market.adp.toFixed(1)}</td>
                    <td>
                      {selection.market.pickVsAdp === null
                        ? "—"
                        : pickVsAdpLabel(selection.market.pickVsAdp)}
                    </td>
                    <td>
                      <span className={gradeClass(selection.market.classification)}>
                        {snakeGradeLabel[selection.market.classification] ?? "—"}
                      </span>
                      {selection.market.classification === "UNAVAILABLE" &&
                      selection.warnings.length > 0 ? (
                        <small className={styles.cellNote}>{warningText(selection.warnings)}</small>
                      ) : null}
                    </td>
                    <td>
                      {selection.rosterNeed.filledOpenStarterSlot
                        ? "Filled a starter slot"
                        : "Depth or bench"}
                    </td>
                    <td>
                      {alternative === undefined
                        ? "—"
                        : `${alternative.name} (ADP ${alternative.adp.toFixed(1)})`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AuctionTeamCard({
  team,
  baselineNote,
}: {
  readonly team: AuctionTeam;
  readonly baselineNote: string | null;
}) {
  const headingId = `draft-analysis-team-${team.teamId}`;
  const pace = team.budget.paceDelta;
  return (
    <section className={`${styles.team} ${styles.teamAuction}`} aria-labelledby={headingId}>
      <div className={styles.teamHead}>
        <h3 id={headingId}>{team.name}</h3>
        <p className={styles.teamSummary}>
          <span>{money(team.budget.remainingBudget)} left</span>
          <span aria-hidden="true">·</span>
          <span>max bid {money(team.budget.maximumLegalBid)}</span>
        </p>
      </div>

      <div className={styles.budgetRail}>
        <dl className={styles.facts}>
          <div>
            <dt>Budget</dt>
            <dd>{money(team.budget.initialBudget)}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>{money(team.budget.spent)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{money(team.budget.remainingBudget)}</dd>
          </div>
          <div>
            <dt>Max legal bid</dt>
            <dd>{money(team.budget.maximumLegalBid)}</dd>
          </div>
        </dl>
        <div className={styles.meter}>
          <p className={styles.meterRow}>
            <span className={styles.meterLabel}>Budget spent</span>
            <span className={styles.meterTrack} aria-hidden="true">
              <span
                className={styles.meterFill}
                style={{ width: percent(team.budget.budgetSpentRate) }}
              />
            </span>
            <span className={styles.meterValue}>{percent(team.budget.budgetSpentRate)}</span>
          </p>
          <p className={styles.meterRow}>
            <span className={styles.meterLabel}>Roster filled</span>
            <span className={styles.meterTrack} aria-hidden="true">
              <span
                className={`${styles.meterFill} ${styles.meterFillAlt}`}
                style={{ width: percent(team.budget.rosterFillRate) }}
              />
            </span>
            <span className={styles.meterValue}>{percent(team.budget.rosterFillRate)}</span>
          </p>
          <p className={styles.paceNote}>
            {pace === 0
              ? "Spending and roster are level."
              : pace > 0
                ? `Spending ahead of roster by ${percent(Math.abs(pace))}.`
                : `Roster ahead of spending by ${percent(Math.abs(pace))}.`}
          </p>
        </div>
      </div>

      <RosterRow team={team} />
      <TeamStrength team={team} />

      {team.marketEfficiency.status === "AVAILABLE" ? (
        <p className={styles.strength}>
          <ShieldCheck size={13} aria-hidden="true" />
          Baseline value acquired {money(team.marketEfficiency.baselineValueAcquired)} against{" "}
          {money(team.marketEfficiency.spent)} spent · surplus{" "}
          {signed(team.marketEfficiency.surplus, 0)}
        </p>
      ) : (
        <p className={`${styles.strength} ${styles.strengthMuted}`}>
          <Info size={13} aria-hidden="true" />
          Market efficiency withheld: {team.marketEfficiency.message}
          {baselineNote === null ? null : ` ${baselineNote}`}
        </p>
      )}

      {team.purchases.length === 0 ? (
        <p className={styles.empty}>No sales recorded for this team yet.</p>
      ) : (
        <div
          className={styles.tableScroll}
          role="region"
          aria-label={`${team.name} purchases`}
          tabIndex={0}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Price</th>
                <th scope="col">Baseline value</th>
                <th scope="col">Surplus</th>
                <th scope="col">Grade</th>
                <th scope="col">Starter need</th>
                <th scope="col">Bid legality</th>
              </tr>
            </thead>
            <tbody>
              {team.purchases.map((purchase) => (
                <tr key={purchase.eventId}>
                  <th scope="row">{purchase.playerName}</th>
                  <td>{money(purchase.price)}</td>
                  <td>
                    {purchase.market.baselineValue === null
                      ? "No admitted baseline"
                      : money(purchase.market.baselineValue)}
                  </td>
                  <td>
                    {purchase.market.surplus === null ? "—" : signed(purchase.market.surplus, 0)}
                  </td>
                  <td>
                    <span className={gradeClass(purchase.market.classification)}>
                      {auctionGradeLabel[purchase.market.classification] ?? "—"}
                    </span>
                  </td>
                  <td>
                    {purchase.rosterNeed.filledOpenStarterSlot
                      ? "Filled a starter slot"
                      : "Depth or bench"}
                  </td>
                  <td>
                    {purchase.legality.withinMaximumBid ? (
                      "Within maximum bid"
                    ) : (
                      <>
                        <span className={`${styles.chip} ${styles.chipCaution}`}>
                          Above recorded maximum
                        </span>
                        <small className={styles.cellNote}>
                          The recorded maximum legal bid at this point was{" "}
                          {money(purchase.legality.maximumLegalBidBeforePurchase)}. This flags the
                          recorded room data, not the manager.
                        </small>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function DraftAnalysisPanel({ draftId, sequence, mode, enabled }: DraftAnalysisPanelProps) {
  const [panel, setPanel] = useState<PanelState>(
    enabled ? { state: "loading" } : { state: "idle" },
  );
  const latest = useRef(new LatestRequest());
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      latest.current.invalidate();
      setPanel({ state: "idle" });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Keyed on the snapshot sequence so a slow report for an earlier pick can never overwrite the
    // current board.
    const identity = latest.current.begin(`${draftId}:${sequence}`);
    setPanel({ state: "loading" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/drafts/${draftId}/analysis`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!latest.current.isCurrent(identity)) return;
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not load the draft report"));
      }
      const payload: unknown = await response.json();
      if (!latest.current.isCurrent(identity)) return;
      const parsed = parseDraftAnalysis(payload);
      if (!parsed) throw new Error("The draft report did not match the expected contract");
      setPanel({ state: "ready", analysis: parsed });
    } catch (error) {
      if (isAbortError(error) || !latest.current.isCurrent(identity)) return;
      setPanel({
        state: "error",
        message: error instanceof Error ? error.message : "Could not load the draft report",
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [draftId, enabled, sequence]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const analysis = panel.state === "ready" ? panel.analysis : null;
  const auctionBaselineNote = useMemo(
    () =>
      analysis?.warnings.find((warning) => warning.code === "AUCTION_BASELINE_UNAVAILABLE")
        ?.message ?? null,
    [analysis],
  );
  const hasRecordedActions = useMemo(
    () =>
      analysis?.teams.some((team) =>
        team.mode === "SNAKE" ? team.selections.length > 0 : team.purchases.length > 0,
      ) ?? false,
    [analysis],
  );

  return (
    <section className={styles.panel} aria-labelledby="draft-analysis-title">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Draft report</p>
          <h2 id="draft-analysis-title">
            {analysis?.draftStatus === "COMPLETE" ? "Final draft report" : "In-progress read"}
          </h2>
          <p className={styles.lede}>
            {analysis?.draftStatus === "COMPLETE"
              ? "Every recorded pick has been graded against the admitted market baseline and roster rules."
              : "Teams may have unequal pick counts while the room is live, so this is a read on the board so far and not a final grade."}
          </p>
        </div>
        {analysis === null ? null : (
          <span className={`${styles.badge} ${styles.badgeMode}`}>
            {analysis.mode === "AUCTION" ? "Auction" : "Snake"}
          </span>
        )}
      </div>

      {panel.state === "idle" ? (
        <p className={styles.empty}>
          The Practice Room runs entirely in this browser, so there is no recorded draft to report
          on. Open a shared draft room to see the report.
        </p>
      ) : null}

      {panel.state === "loading" ? (
        <p className={styles.status} role="status">
          <LoaderCircle className="spin" size={15} aria-hidden="true" />
          Reading the recorded draft…
        </p>
      ) : null}

      {panel.state === "error" ? (
        <p className={styles.error} role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          {panel.message}
        </p>
      ) : null}

      {analysis === null ? null : (
        <>
          <dl className={styles.provenance}>
            <div>
              <dt>Algorithm</dt>
              <dd>{analysis.algorithmVersion}</dd>
            </div>
            <div>
              <dt>Sequence</dt>
              <dd>{analysis.sequence}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{readableMoment(analysis.generatedAt)}</dd>
            </div>
            <div>
              <dt>Input checksum</dt>
              <dd title={analysis.inputChecksum}>{analysis.inputChecksum.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>Market source</dt>
              <dd>
                {analysis.market.state === "available"
                  ? `${analysis.market.source.name} · ${readableMoment(analysis.market.source.sourceAsOf)}`
                  : "Unavailable"}
                {analysis.market.state === "available" && analysis.market.source.stale ? (
                  <span className={`${styles.badge} ${styles.badgeStale}`}>Stale</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Projections</dt>
              <dd>
                {analysis.projections.state === "available"
                  ? `${analysis.projections.source} ${analysis.projections.version}`
                  : "Unavailable"}
              </dd>
            </div>
          </dl>

          {analysis.warnings.length > 0 ? (
            <ul className={styles.warnings}>
              {analysis.warnings.map((warning) => (
                <li key={warning.code}>
                  <TriangleAlert size={13} aria-hidden="true" />
                  <span>{warning.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {hasRecordedActions ? null : (
            <p className={styles.empty}>
              Nothing has been recorded in this room yet. Roster construction below reflects the
              league&rsquo;s slot rules, and grading begins with the first recorded{" "}
              {mode === "AUCTION" ? "sale" : "pick"}.
            </p>
          )}

          <div className={styles.teams}>
            {analysis.teams.map((team) =>
              team.mode === "SNAKE" ? (
                <SnakeTeamCard key={team.teamId} team={team} />
              ) : (
                <AuctionTeamCard key={team.teamId} team={team} baselineNote={auctionBaselineNote} />
              ),
            )}
          </div>
        </>
      )}
    </section>
  );
}
