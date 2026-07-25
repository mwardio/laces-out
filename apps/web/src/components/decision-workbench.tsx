"use client";

import type { InSeasonDecisionSnapshot } from "@fantasy/contracts";
import {
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Database,
  Gauge,
  Info,
  LoaderCircle,
  RefreshCw,
  Scale,
  ShieldAlert,
  UserRoundPlus,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseInSeasonDecisionSnapshot,
  parseLeagueListResponse,
  type LeagueListResponse,
} from "../lib/api-client";
import { projectionSourceAsOfText } from "../lib/projection-import-form";
import { useDefaultLeague } from "../lib/use-default-league";
import {
  DEMO_LEAGUE_ID,
  demoDecisionSnapshot,
  demoLeaguePortfolio,
} from "../lib/demo-contract-data";
import { AiCoachPanel } from "./ai-coach-panel";
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

function providerLabel(provider: string | null): string {
  if (provider === "espn") return "ESPN";
  if (provider === "yahoo") return "Yahoo";
  return "League host";
}

function compactDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ExecutionLink({ execution }: { readonly execution: Execution }) {
  if (!execution.url) {
    return (
      <div className={styles.readOnlyNote}>
        <ShieldAlert size={15} aria-hidden="true" />
        <span>{execution.label}. No roster changes are made on your behalf.</span>
      </div>
    );
  }
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
                  <span>
                    Your roster-rule and position-eligibility-valid lineup is already optimized for
                    the selected projection set. Provider locks still require verification.
                  </span>
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
              <span>No bounded add/drop pairing improves projected roster value.</span>
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
        <p className={styles.emptyText}>No package cleared the modeled roster and value filters.</p>
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

function TradeSection({ snapshot }: { readonly snapshot: InSeasonDecisionSnapshot }) {
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
        <small>Tap any read to jump straight there</small>
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
  const decisionRequest = useRef<AbortController | null>(null);
  const { defaultLeagueId, loaded: preferenceLoaded } = useDefaultLeague();

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
        const preferred =
          defaultLeagueId && parsed.leagues.some((league) => league.id === defaultLeagueId)
            ? defaultLeagueId
            : null;
        setSelectedLeagueId((current) => current || preferred || parsed.leagues[0]?.id || "");
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

  if (portfolio.state === "loading") {
    return (
      <div className={styles.gate} role="status">
        <LoaderCircle className={styles.spin} size={21} aria-hidden="true" />
        <div>
          <strong>Loading decision desk</strong>
          <span>Checking membership and synchronized league data.</span>
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
          <span>Recommendations are isolated to leagues where you are a member.</span>
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
          <span>{portfolio.message}</span>
        </div>
      </div>
    );
  }
  if (portfolio.portfolio.leagues.length === 0) {
    return (
      <div className={styles.gate}>
        <ShieldAlert size={21} aria-hidden="true" />
        <div>
          <strong>Connect a league first</strong>
          <span>Real roster and league settings are required before any recommendation runs.</span>
          <Link className={styles.primaryLink} href="/connections">
            Open connections
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
      {isDemo ? (
        <div className={styles.demoNotice} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Locker room tour</strong>
            Illustrative week-six recommendations. No live account data is shown.
          </span>
        </div>
      ) : null}
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Game-week decisions</p>
          <h1>Decision Desk</h1>
          <p>
            One clean read on lineups, waivers, and trades, calculated from your latest stored
            league facts and a named projection set. Missing inputs stop the model; they never
            become guesses.
          </p>
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
            }}
          >
            {portfolio.portfolio.leagues.map((league) => (
              <option value={league.id} key={league.id}>
                {league.name}
                {league.season ? ` · ${league.season.season}` : ""}
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

      {decision.state === "loading" || decision.state === "idle" ? (
        <div className={styles.analysisLoading} role="status">
          <LoaderCircle className={styles.spin} size={19} aria-hidden="true" />
          <span>Reading the latest roster, rules, and projection provenance.</span>
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
              <Clock3 size={16} aria-hidden="true" />
              <span>
                <small>Projection source</small>
                <strong>
                  {snapshot.provenance.projectionSet
                    ? `${snapshot.provenance.projectionSet.source} · ${snapshot.provenance.projectionSet.version}`
                    : "No compatible set"}
                </strong>
              </span>
            </div>
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
                <small>Execution</small>
                <strong>Read-only · apply on {providerLabel(snapshot.league.provider)}</strong>
              </span>
            </div>
          </section>

          <section className={styles.providerWarning} aria-label="Provider verification required">
            <ShieldAlert size={19} aria-hidden="true" />
            <div>
              <strong>Verify every lineup, waiver, and trade action at the provider</strong>
              <p>{snapshot.providerVerification.actionWarning}</p>
              <span>
                Complete lock coverage: unavailable · stored true-lock records honored:{" "}
                {snapshot.providerVerification.storedLockedPlayerCount}
              </span>
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
          </div>

          <LineupSection snapshot={snapshot} />
          <WaiverSection snapshot={snapshot} />
          <TradeSection snapshot={snapshot} />

          {/* Follows the board it reviews — "Pressure-test the board" above the
              board offered a second opinion before the first one existed. */}
          <div className={styles.aiAnchor} id="decision-ai">
            <AiCoachPanel
              leagueId={selectedLeagueId}
              features={["start-sit", "waiver-scan", "trade-builder"]}
              demo={isDemo}
              eyebrow="AI decision review"
              title="Pressure-test the board"
              description="Get a plain-language second read without letting the model invent a lineup, waiver target, or trade package."
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
