"use client";

import {
  MAX_TRADE_BUILDER_PLAYERS_PER_SIDE,
  type DecisionPlayer,
  type InSeasonDecisionSnapshot,
  type LeagueDashboard,
  type TradeEvaluationResponse,
} from "@laces-out/contracts";
import {
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Scale,
  ShieldAlert,
  UserRoundPlus,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  apiBaseUrl,
  parseInSeasonDecisionSnapshot,
  parseLeagueDashboard,
  parseLeagueListResponse,
  parseTradeEvaluationResponse,
  type LeagueListResponse,
} from "../lib/api-client";
import { compactDate, CONNECT_LEAGUE_FIRST, providerLabel } from "../lib/copy";
import { projectionSourceAsOfText } from "../lib/projection-import-form";
import { leagueIsUnclaimed } from "../lib/team-claim";
import { useDefaultLeague } from "../lib/use-default-league";
import {
  DEMO_LEAGUE_ID,
  demoDecisionSnapshot,
  demoLeaguePortfolio,
} from "../lib/demo-contract-data";
import { AiCoachPanel } from "./ai-coach-panel";
import {
  providerForSelectedLeague,
  useFantasyProviderAttribution,
} from "./fantasy-provider-attribution";
import { TeamClaimCallout } from "./team-claim-callout";
import { TourBanner } from "./tour-banner";
import styles from "./decision-workbench.module.css";

type PortfolioState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly portfolio: LeagueListResponse };

type DecisionState =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly snapshot: InSeasonDecisionSnapshot };

type AvailableTradeSection = Extract<InSeasonDecisionSnapshot["trades"], { state: "available" }>;
type TradeCardData = AvailableTradeSection["bestForMe"][number];
type Execution = Extract<InSeasonDecisionSnapshot["lineup"], { state: "available" }>["execution"];

const points = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const projectedPoints = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * The per-card execution affordance. It carries the shield and the section's own call to action,
 * but not the read-only disclaimer: the page states that once, in the provider-verification
 * section above. Repeating it under every card meant a member read the same sentence three times
 * on one screen without learning anything new the second or third time.
 */
function ExecutionLink({ execution }: { readonly execution: Execution }) {
  if (!execution.url) return null;
  return (
    <a className={styles.executionLink} href={execution.url} target="_blank" rel="noreferrer">
      {execution.label}
      <ArrowUpRight size={15} aria-hidden="true" />
    </a>
  );
}

function UnavailablePanel({
  title,
  reasons,
}: {
  readonly title: string;
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
}) {
  return (
    <div className={styles.unavailable} role="status">
      <ShieldAlert size={19} aria-hidden="true" />
      <div>
        <strong>{title} is waiting for real data</strong>
        <ul>
          {reasons.map((item) => (
            <li key={`${item.code}:${item.message}`}>{item.message}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function LineupSection({ snapshot }: { readonly snapshot: InSeasonDecisionSnapshot }) {
  const section = snapshot.lineup;
  return (
    <section className={styles.section} id="decision-lineup" aria-labelledby="lineup-title">
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>
          <ClipboardCheck size={18} aria-hidden="true" />
        </span>
        <div>
          <p className={styles.kicker}>Start / sit</p>
          <h2 id="lineup-title">Lineup check</h2>
        </div>
        <span className={styles.sectionTag}>Roster-rule optimum</span>
      </header>
      {section.state === "unavailable" ? (
        <UnavailablePanel title="Lineup analysis" reasons={section.reasons} />
      ) : (
        <>
          <div className={styles.metricGrid}>
            <div>
              <span>Current</span>
              <strong>{projectedPoints.format(section.currentProjectedPoints)}</strong>
            </div>
            <div>
              <span>Optimized</span>
              <strong>{projectedPoints.format(section.optimalProjectedPoints)}</strong>
            </div>
            <div className={section.projectedGain > 0 ? styles.positiveMetric : undefined}>
              <span>Available edge</span>
              <strong>{points.format(section.projectedGain)}</strong>
            </div>
          </div>

          <div className={styles.twoColumn}>
            <div>
              <h3>Recommended changes</h3>
              {section.changes.length === 0 ? (
                <div className={styles.clearState}>
                  <CheckCircle2 size={17} aria-hidden="true" />
                  <span>Lineup is already optimal.</span>
                </div>
              ) : (
                <div className={styles.changeList}>
                  {section.changes.map((change) => (
                    <article className={styles.changeRow} key={change.slotId}>
                      <span className={styles.slot}>{change.slotLabel}</span>
                      <div>
                        <small>Bench</small>
                        <strong>{change.remove?.name ?? "Open slot"}</strong>
                      </div>
                      <ArrowUpRight size={15} aria-hidden="true" />
                      <div>
                        <small>Start</small>
                        <strong>{change.add?.name ?? "No eligible player"}</strong>
                      </div>
                      <span className={styles.gain}>
                        {points.format(change.projectedPointDelta)}
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3>Optimal starters</h3>
              <div className={styles.lineupList}>
                {section.assignments.map((assignment) => (
                  <div key={assignment.slotId}>
                    <span className={styles.slot}>{assignment.slotLabel}</span>
                    <strong>{assignment.player.name}</strong>
                    <small>
                      {assignment.player.positions.join("/")} ·{" "}
                      {projectedPoints.format(assignment.player.projectedPoints)}
                      {assignment.locked ? " · locked" : ""}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <ExecutionLink execution={section.execution} />
        </>
      )}
    </section>
  );
}

function WaiverSection({ snapshot }: { readonly snapshot: InSeasonDecisionSnapshot }) {
  const section = snapshot.waivers;
  return (
    <section className={styles.section} id="decision-waivers" aria-labelledby="waivers-title">
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>
          <UserRoundPlus size={18} aria-hidden="true" />
        </span>
        <div>
          <p className={styles.kicker}>Add / drop</p>
          <h2 id="waivers-title">Waiver wire</h2>
        </div>
        <span className={styles.sectionTag}>Bounded pool</span>
      </header>
      {section.state === "unavailable" ? (
        <UnavailablePanel title="Waiver analysis" reasons={section.reasons} />
      ) : (
        <>
          <div className={styles.sectionSummary}>
            <span>
              <strong>{section.candidateCount}</strong> candidates
            </span>
            <span>
              <strong>{section.evaluatedMoveCount}</strong> roster-rule-valid moves modeled
            </span>
          </div>
          {section.recommendations.length === 0 ? (
            <div className={styles.clearState}>
              <CheckCircle2 size={17} aria-hidden="true" />
              <span>No worthwhile add/drop move.</span>
            </div>
          ) : (
            <div className={styles.waiverList}>
              {section.recommendations.map((move) => (
                <article
                  className={styles.waiverRow}
                  key={`${move.add.id}:${move.drop?.id ?? "open"}`}
                >
                  <div className={styles.playerMove}>
                    <span>Add</span>
                    <strong>{move.add.name}</strong>
                    <small>
                      {move.add.positions.join("/")} ·{" "}
                      {projectedPoints.format(move.add.projectedPoints)}
                    </small>
                  </div>
                  <div className={styles.playerMove}>
                    <span>Drop</span>
                    <strong>{move.drop?.name ?? "Open roster spot"}</strong>
                    <small>
                      {move.drop
                        ? `${move.drop.positions.join("/")} · ${projectedPoints.format(move.drop.projectedPoints)}`
                        : "No corresponding drop"}
                    </small>
                  </div>
                  <div className={styles.moveValue}>
                    <span>Roster gain</span>
                    <strong>{points.format(move.weightedGain)}</strong>
                    <small>Lineup {points.format(move.lineupGain)}</small>
                  </div>
                  <div className={styles.moveValue}>
                    <span>FAAB</span>
                    <strong>{move.faab ? `$${move.faab.recommended}` : "—"}</strong>
                    <small>
                      {move.faab ? `$${move.faab.low}–$${move.faab.high}` : "Budget unavailable"}
                      {move.market
                        ? ` · ${move.market.addCount} adds/${move.market.lookbackHours}h`
                        : ""}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className={styles.methodNote}>{section.notes.join(" ")}</p>
          <ExecutionLink execution={section.execution} />
        </>
      )}
    </section>
  );
}

function TradeCard({ trade }: { readonly trade: TradeCardData }) {
  return (
    <article className={styles.tradeCard}>
      <header>
        <div>
          <span>{trade.partner.name}</span>
          <strong>{trade.shape}</strong>
        </div>
        {trade.mutuallyBeneficial ? <span className={styles.mutual}>Mutual gain</span> : null}
      </header>
      <div className={styles.tradeSides}>
        <div>
          <small>You send</small>
          {trade.send.map((player) => (
            <strong key={player.id}>{player.name}</strong>
          ))}
        </div>
        <ArrowUpRight size={17} aria-hidden="true" />
        <div>
          <small>You receive</small>
          {trade.receive.map((player) => (
            <strong key={player.id}>{player.name}</strong>
          ))}
        </div>
      </div>
      <dl className={styles.tradeMetrics}>
        <div>
          <dt>Your gain</dt>
          <dd>{points.format(trade.userGain)}</dd>
        </div>
        <div>
          <dt>Their gain</dt>
          <dd>{points.format(trade.partnerGain)}</dd>
        </div>
        <div>
          <dt>Fairness gap</dt>
          <dd>{points.format(trade.fairnessGap)}</dd>
        </div>
      </dl>
    </article>
  );
}

interface BuilderPlayerOption {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

interface BuilderPartner {
  readonly id: string;
  readonly name: string;
  readonly players: readonly BuilderPlayerOption[];
}

interface BuilderRosters {
  readonly user: readonly BuilderPlayerOption[];
  readonly partners: readonly BuilderPartner[];
}

function decisionPlayerOption(player: DecisionPlayer): BuilderPlayerOption {
  return {
    id: player.id,
    name: player.name,
    detail: `${player.positions.join("/")} · ${projectedPoints.format(player.projectedPoints)}`,
  };
}

/**
 * Roster options come from the dashboard read the member can already perform; the builder route
 * exposes no roster fact beyond it.
 */
function dashboardBuilderRosters(dashboard: LeagueDashboard): BuilderRosters {
  const claimed = dashboard.teams.find((team) => team.claimStatus === "current-user");
  const option = (player: {
    readonly id: string;
    readonly name: string;
    readonly position: string;
    readonly nflTeam: string | null;
  }): BuilderPlayerOption => ({
    id: player.id,
    name: player.name,
    detail: player.nflTeam ? `${player.position} · ${player.nflTeam}` : player.position,
  });
  return {
    user: (claimed?.latestRoster?.players ?? []).map(option),
    partners: dashboard.teams.flatMap((team) => {
      const players = team.latestRoster?.players ?? [];
      if (team.id === claimed?.id || players.length === 0) return [];
      return [{ id: team.id, name: team.name, players: players.map(option) }];
    }),
  };
}

/** Tour mode derives its options from the sample snapshot so the builder renders without sign-in. */
function demoBuilderRosters(snapshot: InSeasonDecisionSnapshot): BuilderRosters {
  const user = new Map<string, BuilderPlayerOption>();
  const partners = new Map<string, { name: string; players: Map<string, BuilderPlayerOption> }>();
  const collect = (
    target: Map<string, BuilderPlayerOption>,
    players: readonly DecisionPlayer[],
  ) => {
    for (const player of players) target.set(player.id, decisionPlayerOption(player));
  };
  if (snapshot.lineup.state === "available") {
    collect(
      user,
      snapshot.lineup.assignments.map((assignment) => assignment.player),
    );
    collect(
      user,
      snapshot.lineup.changes.flatMap((change) => (change.remove ? [change.remove] : [])),
    );
  }
  if (snapshot.waivers.state === "available") {
    collect(
      user,
      snapshot.waivers.recommendations.flatMap((move) => (move.drop ? [move.drop] : [])),
    );
  }
  if (snapshot.trades.state === "available") {
    for (const trade of [...snapshot.trades.bestForMe, ...snapshot.trades.fairest]) {
      collect(user, [...trade.send, ...trade.forcedDropsForUser]);
      const partner = partners.get(trade.partner.id) ?? {
        name: trade.partner.name,
        players: new Map<string, BuilderPlayerOption>(),
      };
      collect(partner.players, [...trade.receive, ...trade.forcedDropsForPartner]);
      partners.set(trade.partner.id, partner);
    }
  }
  return {
    user: [...user.values()],
    partners: [...partners].map(([id, partner]) => ({
      id,
      name: partner.name,
      players: [...partner.players.values()],
    })),
  };
}

type BuilderResult =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "error" | "rejected"; readonly message: string }
  | { readonly state: "ready"; readonly response: TradeEvaluationResponse };

function BuilderCheckboxGroup({
  legend,
  name,
  options,
  selected,
  onToggle,
  disabled,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly BuilderPlayerOption[];
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled: boolean;
}) {
  const atCap = selected.length >= MAX_TRADE_BUILDER_PLAYERS_PER_SIDE;
  return (
    <fieldset className={styles.builderFieldset} disabled={disabled}>
      <legend>
        {legend}
        <span className={styles.builderCount} aria-live="polite">
          {selected.length} of {MAX_TRADE_BUILDER_PLAYERS_PER_SIDE} selected
          {atCap ? " · maximum reached, clear one to swap" : ""}
        </span>
      </legend>
      {options.length === 0 ? (
        <p className={styles.emptyText}>No stored roster is available for this side.</p>
      ) : (
        <div className={styles.builderOptions}>
          {options.map((option) => {
            const checked = selected.includes(option.id);
            return (
              <label className={styles.builderOption} key={option.id}>
                <input
                  type="checkbox"
                  name={name}
                  value={option.id}
                  checked={checked}
                  disabled={!checked && atCap}
                  onChange={() => onToggle(option.id)}
                />
                <span>
                  <strong>{option.name}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function BuilderProvenance({
  response,
}: {
  readonly response: Extract<TradeEvaluationResponse, { state: "available" }>;
}) {
  const set = response.provenance.projectionSet;
  return (
    <p className={styles.methodNote}>
      {response.algorithmVersion} · input checksum {response.inputChecksum.slice(0, 12)} ·{" "}
      {set ? `${set.source} · ${set.version}` : "No compatible projection set"} ·{" "}
      {response.provenance.projectionFreshness.label}
    </p>
  );
}

function TradeBuilderPanel({
  leagueId,
  rosters,
  demo,
}: {
  readonly leagueId: string;
  readonly rosters: BuilderRosters | null;
  readonly demo: boolean;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [sends, setSends] = useState<readonly string[]>([]);
  const [receives, setReceives] = useState<readonly string[]>([]);
  const [result, setResult] = useState<BuilderResult>({ state: "idle" });

  const partner = rosters?.partners.find((team) => team.id === partnerId) ?? null;
  const toggle =
    (setter: (updater: (current: readonly string[]) => readonly string[]) => void) =>
    (id: string) =>
      setter((current) =>
        current.includes(id)
          ? current.filter((value) => value !== id)
          : current.length >= MAX_TRADE_BUILDER_PLAYERS_PER_SIDE
            ? current
            : [...current, id],
      );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (demo || !partner) return;
    setResult({ state: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueId)}/trade-evaluations`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            opponentTeamId: partner.id,
            sendsPlayerIds: [...sends],
            receivesPlayerIds: [...receives],
          }),
        },
      );
      if (response.status === 404) {
        setResult({ state: "error", message: "This league is no longer available." });
        return;
      }
      if (response.status === 400) {
        const problem: unknown = await response.json();
        const detail =
          typeof problem === "object" && problem !== null && "detail" in problem
            ? (problem as { detail?: unknown }).detail
            : undefined;
        setResult({
          state: "rejected",
          message:
            typeof detail === "string" ? detail : "This package could not be evaluated as built.",
        });
        return;
      }
      if (!response.ok) throw new Error("This package could not be evaluated.");
      const parsed = parseTradeEvaluationResponse(await response.json());
      if (!parsed) throw new Error("The evaluation response failed validation.");
      setResult({ state: "ready", response: parsed });
    } catch (error) {
      setResult({
        state: "error",
        message: error instanceof Error ? error.message : "This package could not be evaluated.",
      });
    }
  };

  if (!rosters || rosters.user.length === 0 || rosters.partners.length === 0) {
    return (
      <div className={styles.tradeBuilder}>
        <h3>Build your own package</h3>
        <p className={styles.emptyText}>
          A stored roster snapshot for your team and at least one other team is required before a
          package can be built.
        </p>
      </div>
    );
  }

  const submittable = !demo && partner !== null && sends.length > 0 && receives.length > 0;
  return (
    <div className={styles.tradeBuilder}>
      <h3>Build your own package</h3>
      <p className={styles.emptyText}>
        Score any package you have in mind against the same engine, roster rules, and projection
        set. Up to {MAX_TRADE_BUILDER_PLAYERS_PER_SIDE} players per side.
      </p>
      <form className={styles.builderForm} onSubmit={(event) => void submit(event)}>
        <div className={styles.builderPartner}>
          <label htmlFor="trade-builder-partner">Trade partner</label>
          <select
            id="trade-builder-partner"
            value={partnerId}
            onChange={(event) => {
              setPartnerId(event.target.value);
              setReceives([]);
              setResult({ state: "idle" });
            }}
          >
            <option value="">Select a team</option>
            {rosters.partners.map((team) => (
              <option value={team.id} key={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.builderSides}>
          <BuilderCheckboxGroup
            legend="You send"
            name="trade-builder-send"
            options={rosters.user}
            selected={sends}
            onToggle={toggle(setSends)}
            disabled={result.state === "loading"}
          />
          <BuilderCheckboxGroup
            legend="You receive"
            name="trade-builder-receive"
            options={partner?.players ?? []}
            selected={receives}
            onToggle={toggle(setReceives)}
            disabled={result.state === "loading" || partner === null}
          />
        </div>
        <div className={styles.builderActions}>
          <button
            type="submit"
            disabled={!submittable || result.state === "loading"}
            title={demo ? "Sign in to evaluate a package against your own league" : undefined}
          >
            Evaluate package
          </button>
          {demo ? (
            <span className={styles.emptyText}>
              Tour mode shows the builder controls only. Sign in with a synced league to score a
              package; Laces Out will not invent an evaluation for sample data.
            </span>
          ) : null}
        </div>
      </form>

      {result.state === "loading" ? (
        <div className={styles.analysisLoading} role="status">
          <LoaderCircle className={styles.spin} size={17} aria-hidden="true" />
          <span>Scoring both rosters after the exchange.</span>
        </div>
      ) : null}
      {result.state === "error" ? (
        <div className={styles.analysisError} role="alert">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>{result.message}</span>
        </div>
      ) : null}
      {result.state === "rejected" ? (
        <div className={styles.analysisError} role="alert">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>{result.message}</span>
        </div>
      ) : null}
      {result.state === "ready" ? (
        <div className={styles.builderResult} role="status">
          {result.response.state === "unavailable" ? (
            <UnavailablePanel title="Package evaluation" reasons={result.response.reasons} />
          ) : (
            <>
              {result.response.legal && result.response.package ? (
                <div className={styles.tradeGrid}>
                  <TradeCard trade={result.response.package} />
                </div>
              ) : (
                <div className={styles.unavailable}>
                  <ShieldAlert size={19} aria-hidden="true" />
                  <div>
                    <strong>This package is not roster-legal</strong>
                    <ul>
                      {result.response.diagnostics.map((diagnostic) => (
                        <li key={`${diagnostic.code}:${diagnostic.message}`}>
                          {diagnostic.message}
                        </li>
                      ))}
                    </ul>
                    <span>
                      Both rosters must stay within their slot rules after the exchange. A player
                      recorded as locked cannot be dropped to make room.
                    </span>
                  </div>
                </div>
              )}
              {result.response.rosUnavailable ? (
                <p className={styles.methodNote}>{result.response.rosUnavailable.message}</p>
              ) : null}
              <p className={styles.methodNote}>{result.response.notes.join(" ")}</p>
              <BuilderProvenance response={result.response} />
              <ExecutionLink execution={result.response.execution} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TradeGroup({
  title,
  trades,
}: {
  readonly title: string;
  readonly trades: readonly TradeCardData[];
}) {
  return (
    <div className={styles.tradeGroup}>
      <h3>{title}</h3>
      {trades.length === 0 ? (
        <p className={styles.emptyText}>No qualifying trade.</p>
      ) : (
        <div className={styles.tradeGrid}>
          {trades.map((trade) => (
            <TradeCard trade={trade} key={trade.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function TradeSection({
  snapshot,
  leagueId,
  rosters,
  demo,
}: {
  readonly snapshot: InSeasonDecisionSnapshot;
  readonly leagueId: string;
  readonly rosters: BuilderRosters | null;
  readonly demo: boolean;
}) {
  const section = snapshot.trades;
  return (
    <section className={styles.section} id="decision-trades" aria-labelledby="trades-title">
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>
          <Scale size={18} aria-hidden="true" />
        </span>
        <div>
          <p className={styles.kicker}>Team-to-team</p>
          <h2 id="trades-title">Trade market</h2>
        </div>
        <span className={styles.sectionTag}>Both sides scored</span>
      </header>
      {section.state === "unavailable" ? (
        <UnavailablePanel title="Trade analysis" reasons={section.reasons} />
      ) : (
        <>
          <div className={styles.sectionSummary}>
            <span>
              <strong>{section.eligibleOpponentCount}</strong> modeled opponents
            </span>
            <span>
              <strong>{section.evaluatedPackageCount}</strong> roster-rule-valid packages
            </span>
          </div>
          <div className={styles.tradeColumns}>
            <TradeGroup title="Best for my roster" trades={section.bestForMe} />
            <TradeGroup title="Fairest market fits" trades={section.fairest} />
          </div>
          <TradeBuilderPanel leagueId={leagueId} rosters={rosters} demo={demo} />
          <p className={styles.methodNote}>{section.notes.join(" ")}</p>
          <ExecutionLink execution={section.execution} />
        </>
      )}
    </section>
  );
}

function DecisionQuickBoard({ snapshot }: { readonly snapshot: InSeasonDecisionSnapshot }) {
  const lineup = snapshot.lineup;
  const waivers = snapshot.waivers;
  const trades = snapshot.trades;
  const lineupGain = lineup.state === "available" ? lineup.projectedGain : null;
  const waiverCount = waivers.state === "available" ? waivers.recommendations.length : null;
  const tradeCount =
    trades.state === "available" ? Math.max(trades.bestForMe.length, trades.fairest.length) : null;

  return (
    <nav className={styles.quickBoard} aria-label="Jump to this week's decision results">
      <div className={styles.quickBoardHeader}>
        <span>Today&apos;s board</span>
      </div>
      <a href="#decision-lineup">
        <span className={styles.quickBoardIcon}>
          <ClipboardCheck size={16} aria-hidden="true" />
        </span>
        <span>
          <small>Lineup</small>
          <strong>
            {lineupGain === null
              ? "Waiting"
              : lineupGain > 0
                ? `${points.format(lineupGain)} pts`
                : "Already set"}
          </strong>
        </span>
      </a>
      <a href="#decision-waivers">
        <span className={styles.quickBoardIcon}>
          <UserRoundPlus size={16} aria-hidden="true" />
        </span>
        <span>
          <small>Waivers</small>
          <strong>
            {waiverCount === null
              ? "Waiting"
              : waiverCount > 0
                ? `${waiverCount} worthwhile ${waiverCount === 1 ? "add" : "adds"}`
                : "Hold your roster"}
          </strong>
        </span>
      </a>
      <a href="#decision-trades">
        <span className={styles.quickBoardIcon}>
          <Scale size={16} aria-hidden="true" />
        </span>
        <span>
          <small>Trades</small>
          <strong>
            {tradeCount === null
              ? "Waiting"
              : tradeCount > 0
                ? `${tradeCount} modeled ${tradeCount === 1 ? "fit" : "fits"}`
                : "No fit yet"}
          </strong>
        </span>
      </a>
      <a href="#decision-ai">
        <span className={styles.quickBoardIcon}>
          <BrainCircuit size={16} aria-hidden="true" />
        </span>
        <span>
          <small>AI review</small>
          <strong>Explain the close calls</strong>
        </span>
      </a>
    </nav>
  );
}

export function DecisionWorkbench() {
  const [portfolio, setPortfolio] = useState<PortfolioState>({ state: "loading" });
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const [decision, setDecision] = useState<DecisionState>({ state: "idle" });
  const [isDemo, setIsDemo] = useState(false);
  const [rosters, setRosters] = useState<BuilderRosters | null>(null);
  const [liveDashboard, setLiveDashboard] = useState<LeagueDashboard | null>(null);
  const decisionRequest = useRef<AbortController | null>(null);
  const dashboardRequest = useRef<AbortController | null>(null);
  const { defaultLeagueId, loaded: preferenceLoaded } = useDefaultLeague();
  useFantasyProviderAttribution(
    portfolio.state === "ready"
      ? providerForSelectedLeague(portfolio.portfolio.leagues, selectedLeagueId)
      : null,
  );

  useEffect(() => {
    // Wait for the stored default so the first league read is the one the member wants.
    if (!preferenceLoaded) return;
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/leagues`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          setIsDemo(true);
          setPortfolio({ state: "ready", portfolio: demoLeaguePortfolio });
          setSelectedLeagueId(DEMO_LEAGUE_ID);
          setDecision({ state: "ready", snapshot: demoDecisionSnapshot });
          return;
        }
        if (!response.ok) throw new Error("Your synchronized leagues could not be loaded.");
        const parsed = parseLeagueListResponse(await response.json());
        if (!parsed) throw new Error("The league response failed validation.");
        setPortfolio({ state: "ready", portfolio: parsed });
        const requestedLeagueId = new URLSearchParams(window.location.search).get("league");
        const requested =
          requestedLeagueId && parsed.leagues.some((league) => league.id === requestedLeagueId)
            ? requestedLeagueId
            : null;
        const preferred =
          defaultLeagueId && parsed.leagues.some((league) => league.id === defaultLeagueId)
            ? defaultLeagueId
            : null;
        setSelectedLeagueId(
          (current) => current || requested || preferred || parsed.leagues[0]?.id || "",
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPortfolio({
            state: "error",
            message: error instanceof Error ? error.message : "Leagues could not be loaded.",
          });
        }
      });
    return () => controller.abort();
  }, [defaultLeagueId, preferenceLoaded]);

  const loadDecisions = useCallback(async () => {
    decisionRequest.current?.abort();
    if (isDemo) {
      decisionRequest.current = null;
      setDecision({ state: "ready", snapshot: demoDecisionSnapshot });
      return;
    }
    if (!selectedLeagueId) {
      decisionRequest.current = null;
      setDecision({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    decisionRequest.current = controller;
    setDecision({ state: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/decisions`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("Decision analysis could not be loaded for this league.");
      const parsed = parseInSeasonDecisionSnapshot(await response.json());
      if (!parsed) throw new Error("The decision response failed validation.");
      if (parsed.league.id !== selectedLeagueId) {
        throw new Error("The decision response did not match the selected league.");
      }
      if (controller.signal.aborted) return;
      setDecision({ state: "ready", snapshot: parsed });
    } catch (error) {
      if (controller.signal.aborted) return;
      setDecision({
        state: "error",
        message: error instanceof Error ? error.message : "Decision analysis could not be loaded.",
      });
    } finally {
      if (decisionRequest.current === controller) decisionRequest.current = null;
    }
  }, [isDemo, selectedLeagueId]);

  useEffect(() => {
    void loadDecisions();
    return () => decisionRequest.current?.abort();
  }, [loadDecisions]);

  // Builder roster options (and the live dashboard behind them) come from the dashboard read the
  // member can already perform. A failure here only empties the builder; the decision read above
  // owns the surfaced error state.
  const loadLiveDashboard = useCallback(async () => {
    dashboardRequest.current?.abort();
    if (!selectedLeagueId) {
      dashboardRequest.current = null;
      setRosters(null);
      setLiveDashboard(null);
      return;
    }
    const controller = new AbortController();
    dashboardRequest.current = controller;
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/dashboard`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok || controller.signal.aborted) return;
      const parsed = parseLeagueDashboard(await response.json());
      if (!parsed || controller.signal.aborted) return;
      setRosters(dashboardBuilderRosters(parsed));
      setLiveDashboard(parsed);
    } catch {
      // Swallowed: the decision read above owns the surfaced error state for this league.
    } finally {
      if (dashboardRequest.current === controller) dashboardRequest.current = null;
    }
  }, [selectedLeagueId]);

  useEffect(() => {
    if (isDemo) {
      setRosters(demoBuilderRosters(demoDecisionSnapshot));
      setLiveDashboard(null);
      return;
    }
    setRosters(null);
    setLiveDashboard(null);
    void loadLiveDashboard();
    return () => dashboardRequest.current?.abort();
  }, [isDemo, loadLiveDashboard]);

  if (portfolio.state === "loading") {
    return (
      <div className={styles.gate} role="status">
        <LoaderCircle className={styles.spin} size={21} aria-hidden="true" />
        <div>
          <strong>Loading decision desk</strong>
        </div>
      </div>
    );
  }
  if (portfolio.state === "signed-out") {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={21} aria-hidden="true" />
        <div>
          <strong>Sign in to use the decision desk</strong>
          <Link className={styles.primaryLink} href="/login">
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  if (portfolio.state === "error") {
    return (
      <div className={styles.gate} role="alert">
        <ShieldAlert size={21} aria-hidden="true" />
        <div>
          <strong>Decision desk unavailable</strong>
        </div>
      </div>
    );
  }
  if (portfolio.portfolio.leagues.length === 0) {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={21} aria-hidden="true" />
        <div>
          <strong>{CONNECT_LEAGUE_FIRST}</strong>
          <Link className={styles.primaryLink} href="/connections">
            Open League Sync
          </Link>
        </div>
      </div>
    );
  }

  const snapshot =
    decision.state === "ready" && decision.snapshot.league.id === selectedLeagueId
      ? decision.snapshot
      : null;
  return (
    <div className={styles.page}>
      {isDemo ? <TourBanner /> : null}
      <header className={styles.hero}>
        <div>
          <h1>Decision Desk</h1>
        </div>
        <div className={styles.controls}>
          <label htmlFor="decision-league">League</label>
          <select
            id="decision-league"
            value={selectedLeagueId}
            onChange={(event) => {
              decisionRequest.current?.abort();
              setDecision({ state: "loading" });
              setSelectedLeagueId(event.target.value);
              const url = new URL(window.location.href);
              url.searchParams.set("league", event.target.value);
              window.history.replaceState(window.history.state, "", url);
            }}
          >
            {portfolio.portfolio.leagues.map((league) => (
              <option value={league.id} key={league.id}>
                {league.name}
              </option>
            ))}
          </select>
          {/* In tour mode this re-set the identical snapshot, so pressing it
              produced no spinner, no change, nothing — reading as a broken app. */}
          <button
            type="button"
            onClick={() => void loadDecisions()}
            disabled={isDemo || decision.state === "loading"}
            title={isDemo ? "Sign in to recalculate against your own league" : undefined}
          >
            <RefreshCw
              className={decision.state === "loading" ? styles.spin : undefined}
              size={15}
              aria-hidden="true"
            />
            Recalculate
          </button>
        </div>
      </header>

      {!isDemo && liveDashboard && leagueIsUnclaimed(liveDashboard) ? (
        <TeamClaimCallout leagueId={selectedLeagueId} dashboard={liveDashboard} />
      ) : null}

      {decision.state === "loading" || decision.state === "idle" ? (
        <div className={styles.analysisLoading} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          <span>Loading…</span>
        </div>
      ) : decision.state === "error" ? (
        <div className={styles.analysisError} role="alert">
          <ShieldAlert size={18} aria-hidden="true" />
          <span>{decision.message}</span>
        </div>
      ) : snapshot ? (
        <>
          <DecisionQuickBoard snapshot={snapshot} />

          <section className={styles.provenance} aria-label="Recommendation provenance">
            <div>
              <Gauge size={16} aria-hidden="true" />
              <span>
                <small>Source as of</small>
                <strong>
                  {snapshot.provenance.projectionSet
                    ? `${projectionSourceAsOfText(snapshot.provenance.projectionSet, compactDate)}${
                        snapshot.provenance.projectionSet.sourceObservedAtStatus === "verified"
                          ? ` · ${snapshot.provenance.projectionFreshness.label}`
                          : ""
                      }`
                    : snapshot.provenance.projectionFreshness.label}
                </strong>
              </span>
            </div>
            <div>
              <Database size={16} aria-hidden="true" />
              <span>
                <small>Imported at</small>
                <strong>
                  {compactDate(snapshot.provenance.projectionSet?.importedAt ?? null)}
                </strong>
              </span>
            </div>
            <div>
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                <small>Provider</small>
                <strong>{providerLabel(snapshot.league.provider)}</strong>
              </span>
            </div>
          </section>

          <section className={styles.providerWarning} aria-label="Provider verification required">
            <ShieldAlert size={19} aria-hidden="true" />
            <div>
              <strong>Verify every lineup, waiver, and trade action at the provider</strong>
              <p>{snapshot.providerVerification.actionWarning}</p>
              <details>
                <summary>Lock coverage</summary>
                <span>
                  Complete coverage unavailable · stored locks honored:{" "}
                  {snapshot.providerVerification.storedLockedPlayerCount}
                </span>
              </details>
            </div>
          </section>

          <div className={styles.sourceLine}>
            <span>
              League sync <strong>{compactDate(snapshot.provenance.leagueLastSyncedAt)}</strong>
            </span>
            <span>
              Roster captured <strong>{compactDate(snapshot.provenance.rosterEffectiveAt)}</strong>
            </span>
            <span>
              Week <strong>{snapshot.league.week ?? "not set"}</strong>
            </span>
            <span>
              Roster coverage{" "}
              <strong>
                {snapshot.coverage.claimedRosterProjected}/{snapshot.coverage.claimedRosterPlayers}{" "}
                projected
              </strong>
            </span>
            <Link className={styles.scheduleLink} href={`/schedule?league=${selectedLeagueId}`}>
              Add matchup context
              <ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          </div>

          <LineupSection snapshot={snapshot} />
          <WaiverSection snapshot={snapshot} />
          <TradeSection
            snapshot={snapshot}
            leagueId={selectedLeagueId}
            rosters={rosters}
            demo={isDemo}
          />

          <div className={styles.aiAnchor} id="decision-ai">
            <AiCoachPanel
              leagueId={selectedLeagueId}
              features={["start-sit", "waiver-scan", "trade-builder"]}
              demo={isDemo}
              eyebrow="AI decision review"
              title="Review the board"
              description="Explain the lineup, waiver, and trade calls."
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
