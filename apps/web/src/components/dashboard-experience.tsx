"use client";

import {
  Activity,
  ArrowRight,
  Cable,
  CheckCircle2,
  CircleAlert,
  Database,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trophy,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseJobAccepted,
  parseLeagueDashboard,
  parseLeagueListResponse,
  type LeagueDashboard,
  type LeagueListResponse,
} from "../lib/api-client";
import { LatestRequest } from "../lib/latest-request";
import { yahooDeveloperAccessPending } from "../lib/public-site";
import { DEMO_LEAGUE_ID } from "../lib/demo-contract-data";
import { AiCoachPanel } from "./ai-coach-panel";
import { PortfolioDashboard } from "./portfolio-dashboard";

type PortfolioState =
  | { readonly status: "loading" }
  | {
      readonly status: "demo";
      readonly reason: "signed-out" | "api-unavailable" | "invalid-response";
    }
  | { readonly status: "live"; readonly portfolio: LeagueListResponse };

type DashboardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly dashboard: LeagueDashboard }
  | { readonly status: "error"; readonly message: string };

function providerLabel(provider: string): string {
  if (provider === "espn") return "ESPN";
  if (provider === "yahoo") return "Yahoo";
  return "Manual";
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function scoreLabel(score: number | null): string {
  if (score === null) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(score);
}

function recordLabel(wins: number | null, losses: number | null, ties: number | null): string {
  if (wins === null || losses === null || ties === null) return "Record unavailable";
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function matchupStatusLabel(status: "scheduled" | "in-progress" | "final"): string {
  if (status === "in-progress") return "In progress";
  return status === "final" ? "Final" : "Scheduled";
}

function memberScoreStateLabel(state: LeagueDashboard["memberWeek"]["scoreState"]): string {
  if (!state) return "Score state unavailable";
  const labels = {
    "not-started": "Not started",
    leading: "You’re leading",
    trailing: "You’re trailing",
    tied: "Tied",
    won: "You won",
    lost: "You lost",
  } as const;
  return labels[state];
}

function FreshnessDot({ state }: { state: "fresh" | "aging" | "stale" | "missing" }) {
  return <span className={`live-freshness-dot live-freshness-dot--${state}`} aria-hidden="true" />;
}

function LoadingDashboard() {
  return (
    <div className="dashboard-page live-dashboard-loading" role="status">
      <LoaderCircle className="spin" size={22} />
      <div>
        <strong>Loading your leagues</strong>
        <span>Checking your session and synchronized data…</span>
      </div>
    </div>
  );
}

function DemoFallback({
  reason,
}: {
  reason: Extract<PortfolioState, { status: "demo" }>["reason"];
}) {
  const message =
    reason === "signed-out"
      ? "You are signed out. The locker room below uses sample league data."
      : reason === "api-unavailable"
        ? "The live API could not be reached, so the locker room is showing its sample data."
        : "The API response failed validation. Live data was withheld and sample data is shown.";
  return (
    <>
      <div className="dashboard-mode-notice dashboard-mode-notice--demo" role="status">
        <CircleAlert size={16} />
        <span>{message}</span>
      </div>
      <PortfolioDashboard />
      <div className="dashboard-page">
        <AiCoachPanel
          leagueId={DEMO_LEAGUE_ID}
          features={[
            "weekly-brief",
            "start-sit",
            "waiver-scan",
            "trade-builder",
            "standings-prediction",
          ]}
          demo
          eyebrow="AI coaching tour"
          title="See how the second read works"
          description="Every sample starts with the league engine's board, then uses Gemini to explain what is worth doing—and what is not."
        />
      </div>
    </>
  );
}

function EmptyLivePortfolio() {
  return (
    <div className="dashboard-page">
      <section className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">League overview</p>
          <h1>Connect your first league.</h1>
          <p className="page-subtitle">
            Your account is ready, but it does not have any synchronized leagues yet.
          </p>
        </div>
      </section>
      <section className="panel live-empty-panel">
        <span className="overview-stat__icon overview-stat__icon--blue">
          <Cable size={22} />
        </span>
        <div>
          <h2>{yahooDeveloperAccessPending ? "Connect ESPN" : "Connect Yahoo or ESPN"}</h2>
          <p>
            {yahooDeveloperAccessPending
              ? "ESPN sync is available now. Yahoo league sync is coming soon."
              : "Once a sync succeeds, this page will use the stored league, team, and roster data."}
          </p>
        </div>
        <Link className="button button--dark" href="/connections">
          Open connections <ArrowRight size={15} />
        </Link>
      </section>
    </div>
  );
}

interface LivePortfolioProps {
  readonly portfolio: LeagueListResponse;
  readonly reloadPortfolio: () => Promise<void>;
}

function LivePortfolio({ portfolio, reloadPortfolio }: LivePortfolioProps) {
  const [selectedLeagueId, setSelectedLeagueId] = useState(portfolio.leagues[0]?.id ?? "");
  const [dashboardState, setDashboardState] = useState<DashboardState>({ status: "loading" });
  const [claimChoice, setClaimChoice] = useState("");
  const [claimState, setClaimState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [claimMessage, setClaimMessage] = useState("");
  const [sourceRefreshState, setSourceRefreshState] = useState<
    "idle" | "working" | "queued" | "deduplicated" | "error"
  >("idle");
  const dashboardRequest = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!selectedLeagueId) return;
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    setDashboardState({ status: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/dashboard`,
        {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("The live league dashboard could not be loaded.");
      const dashboard = parseLeagueDashboard(await response.json());
      if (!dashboard) throw new Error("The live dashboard response was invalid.");
      if (controller.signal.aborted || dashboardRequest.current !== controller) return;
      setDashboardState({ status: "ready", dashboard });
      setClaimChoice(
        dashboard.membership.claimedFantasyTeamId ??
          (dashboard.teamClaim.mode === "provider-mapped"
            ? dashboard.teamClaim.claimableTeamId
            : null) ??
          dashboard.teams.find((team) => team.claimStatus === "available")?.id ??
          "",
      );
    } catch (error) {
      if (controller.signal.aborted || dashboardRequest.current !== controller) return;
      setDashboardState({
        status: "error",
        message: error instanceof Error ? error.message : "The live dashboard could not be loaded.",
      });
    }
  }, [selectedLeagueId]);

  useEffect(() => {
    void loadDashboard();
    return () => dashboardRequest.current?.abort();
  }, [loadDashboard]);

  const selectedSummary = portfolio.leagues.find((league) => league.id === selectedLeagueId);
  const currentDashboard = dashboardState.status === "ready" ? dashboardState.dashboard : undefined;
  const freshLeagues = portfolio.leagues.filter(
    (league) => league.season?.providerFreshness.state === "fresh",
  ).length;
  const claimedLeagues = portfolio.leagues.filter(
    (league) => league.membership.claimedFantasyTeamId !== null,
  ).length;
  const providers = new Set(
    portfolio.leagues.flatMap((league) => (league.season ? [league.season.provider] : [])),
  );

  async function claimTeam() {
    if (!claimChoice || !currentDashboard) return;
    setClaimState("saving");
    setClaimMessage("");
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(currentDashboard.league.id)}/team-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ teamId: claimChoice }),
        },
      );
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(
          typeof problem?.detail === "string" ? problem.detail : "That team could not be claimed.",
        );
      }
      setClaimState("saved");
      setClaimMessage("Team claim saved.");
      await Promise.all([loadDashboard(), reloadPortfolio()]);
    } catch (error) {
      setClaimState("error");
      setClaimMessage(error instanceof Error ? error.message : "That team could not be claimed.");
    }
  }

  async function checkPlayerCatalog() {
    if (sourceRefreshState === "working") return;
    setSourceRefreshState("working");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/refreshes`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "player-data" }),
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new Error("Player-catalog check could not be queued.");
      const body = parseJobAccepted(await response.json());
      if (!body) throw new Error("Player-catalog queue response was invalid.");
      setSourceRefreshState(body.state === "deduplicated" ? "deduplicated" : "queued");
      await reloadPortfolio();
    } catch {
      setSourceRefreshState("error");
    }
  }

  if (portfolio.leagues.length === 0) return <EmptyLivePortfolio />;

  return (
    <div className="dashboard-page live-dashboard-page">
      <section className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">Your league overview</p>
          <h1>{portfolio.leagues.length} connected leagues in one view.</h1>
          <p className="page-subtitle">
            This view uses the latest saved data from your connected leagues. Recommendations appear
            only after real projection inputs are available. The catalog control checks shared
            nflverse player identities only; provider league sync and projection imports use their
            own controls.
          </p>
        </div>
        <div className="heading-actions">
          <span className="freshness-label">
            <span className="freshness-dot" />
            Updated {new Date(portfolio.generatedAt).toLocaleTimeString()}
          </span>
          <button
            className="button button--outline"
            type="button"
            onClick={() => void Promise.all([reloadPortfolio(), loadDashboard()])}
          >
            <RefreshCw size={16} /> Reload saved data
          </button>
          <button
            className="button button--dark"
            type="button"
            onClick={() => void checkPlayerCatalog()}
            disabled={sourceRefreshState === "working"}
            title="Request an immediate nflverse player-catalog check"
          >
            {sourceRefreshState === "working" ? (
              <LoaderCircle className="spin" size={16} />
            ) : sourceRefreshState === "queued" || sourceRefreshState === "deduplicated" ? (
              <CheckCircle2 size={16} />
            ) : sourceRefreshState === "error" ? (
              <CircleAlert size={16} />
            ) : (
              <Database size={16} />
            )}
            {sourceRefreshState === "working"
              ? "Requesting…"
              : sourceRefreshState === "queued"
                ? "Catalog check queued"
                : sourceRefreshState === "deduplicated"
                  ? "Catalog check already queued"
                  : sourceRefreshState === "error"
                    ? "Retry catalog check"
                    : "Check player catalog"}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {sourceRefreshState === "queued"
              ? "NFL player-catalog check queued."
              : sourceRefreshState === "deduplicated"
                ? "A recent player-catalog check is already queued."
                : sourceRefreshState === "error"
                  ? "Player-catalog check could not be queued."
                  : ""}
          </span>
        </div>
      </section>

      <section className="dashboard-mode-notice dashboard-mode-notice--live">
        <ShieldCheck size={16} />
        <span>
          <strong>Live data active.</strong> Access is limited to leagues where your account has a
          membership.
        </span>
        <Link href="/decisions">
          Open decision desk <ArrowRight size={14} />
        </Link>
      </section>

      <section className="overview-strip" aria-label="Live portfolio overview">
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--ink">
            <UsersRound size={18} />
          </span>
          <div>
            <span>Accessible leagues</span>
            <strong>{portfolio.leagues.length}</strong>
            <small>Visible only to this account</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--lime">
            <Activity size={18} />
          </span>
          <div>
            <span>Provider freshness</span>
            <strong>
              {freshLeagues}/{portfolio.leagues.length} fresh
            </strong>
            <small>Fresh means synced within 6 hours</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--blue">
            <UserRoundCheck size={18} />
          </span>
          <div>
            <span>Team identities</span>
            <strong>
              {claimedLeagues}/{portfolio.leagues.length} claimed
            </strong>
            <small>Required for personal recommendations</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--orange">
            <Database size={18} />
          </span>
          <div>
            <span>Providers represented</span>
            <strong>{providers.size}</strong>
            <small>{[...providers].map(providerLabel).join(" · ") || "Awaiting sync"}</small>
          </div>
        </article>
      </section>

      <AiCoachPanel
        leagueId={selectedLeagueId}
        features={["weekly-brief", "standings-prediction"]}
        eyebrow="Always-current brief"
        title="What changed, and what should you do?"
        description="Generate a weekly read or rest-of-season forecast from the currently selected league."
      />

      <section className="section-block league-section" aria-labelledby="live-league-board-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">League portfolio</p>
            <h2 id="live-league-board-title">Choose a league to inspect</h2>
          </div>
          <Link
            className="button button--outline button--small"
            href={`/analytics?league=${encodeURIComponent(selectedLeagueId)}`}
          >
            League analytics <ArrowRight size={14} />
          </Link>
        </div>
        <div className="league-grid live-league-grid">
          {portfolio.leagues.map((league, index) => {
            const selected = league.id === selectedLeagueId;
            const season = league.season;
            const accent = ["lime", "blue", "orange", "violet"][index % 4] ?? "blue";
            return (
              <button
                className={`league-card league-card--${accent}${selected ? " league-card--selected" : ""}`}
                type="button"
                key={league.id}
                aria-pressed={selected}
                onClick={() => {
                  if (!selected) {
                    dashboardRequest.current?.abort();
                    setDashboardState({ status: "loading" });
                  }
                  setSelectedLeagueId(league.id);
                  setClaimState("idle");
                  setClaimMessage("");
                }}
              >
                <div className="league-card__top">
                  <span className="league-monogram" aria-hidden="true">
                    {league.name
                      .split(/\s+/)
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <span className="provider-badge">
                    {season ? providerLabel(season.provider) : "Unsynced"}
                  </span>
                  <span className="league-format">{season?.draftType ?? "No season"}</span>
                </div>
                <div className="league-card__identity">
                  <span>{league.name}</span>
                  <strong>{league.membership.claimedTeamName ?? "Choose your team"}</strong>
                  <small>
                    {roleLabel(league.membership.role)}
                    {season ? ` · ${season.season} · ${season.teamCount} teams` : " · setup needed"}
                  </small>
                </div>
                <div className="live-league-facts">
                  <span>
                    <Trophy size={14} /> Week {season?.currentWeek ?? "—"}
                  </span>
                  <span>{season?.waiverType ?? "Waiver settings unavailable"}</span>
                </div>
                <div className="league-card__footer">
                  <span className="league-freshness">
                    <FreshnessDot state={season?.providerFreshness.state ?? "missing"} />
                    {season?.providerFreshness.label ?? "Never synced"}
                  </span>
                  <ArrowRight size={15} />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {dashboardState.status === "loading" ? (
        <section className="panel live-detail-loading" role="status">
          <LoaderCircle className="spin" size={20} /> Loading {selectedSummary?.name ?? "league"}…
        </section>
      ) : dashboardState.status === "error" ? (
        <section className="panel live-detail-error" role="alert">
          <CircleAlert size={20} />
          <div>
            <strong>Live league detail unavailable</strong>
            <p>{dashboardState.message}</p>
          </div>
          <button
            className="button button--outline"
            type="button"
            onClick={() => void loadDashboard()}
          >
            Retry
          </button>
        </section>
      ) : (
        <LeagueDetail
          dashboard={dashboardState.dashboard}
          claimChoice={claimChoice}
          setClaimChoice={setClaimChoice}
          claimState={claimState}
          claimMessage={claimMessage}
          claimTeam={() => void claimTeam()}
        />
      )}
    </div>
  );
}

interface LeagueDetailProps {
  readonly dashboard: LeagueDashboard;
  readonly claimChoice: string;
  readonly setClaimChoice: (teamId: string) => void;
  readonly claimState: "idle" | "saving" | "saved" | "error";
  readonly claimMessage: string;
  readonly claimTeam: () => void;
}

function MemberWeekPanel({ dashboard }: { readonly dashboard: LeagueDashboard }) {
  const context = dashboard.memberWeek;
  if (context.state !== "available") {
    const message =
      context.state === "team-unclaimed"
        ? "Claim your fantasy team below to unlock current-opponent context."
        : context.state === "week-unavailable"
          ? "The provider snapshot does not identify a current week yet."
          : "No matchup was stored for your claimed team this week. This may be a bye or a provider data gap.";
    return (
      <section className="panel live-opponent-panel live-opponent-panel--empty">
        <div>
          <p className="eyebrow">Your current opponent</p>
          <h3>Opponent context unavailable</h3>
          <p>{message}</p>
        </div>
        <span className="status-chip">
          <FreshnessDot state={dashboard.weeklyInsights.freshness.state} />
          {dashboard.weeklyInsights.freshness.label}
        </span>
      </section>
    );
  }

  return (
    <section className="panel live-opponent-panel">
      <div className="live-opponent-copy">
        <p className="eyebrow">Week {context.week} · your current opponent</p>
        <h3>{context.opponentTeamName ?? "Opponent name unavailable"}</h3>
        <p>
          {context.opponentManagerDisplayName ?? "Manager unavailable"} ·{" "}
          {context.opponentStandingRank ? `#${context.opponentStandingRank} · ` : ""}
          {recordLabel(context.opponentWins, context.opponentLosses, context.opponentTies)}
        </p>
      </div>
      <div className="live-opponent-score" aria-label="Your matchup score">
        <div>
          <span>{context.teamName ?? "Your team"}</span>
          <strong>{scoreLabel(context.teamScore)}</strong>
          <small>
            {context.standingRank ? `#${context.standingRank} · ` : ""}
            {recordLabel(context.wins, context.losses, context.ties)}
          </small>
        </div>
        <span className="live-score-divider">vs</span>
        <div>
          <span>{context.opponentTeamName ?? "Opponent"}</span>
          <strong>{scoreLabel(context.opponentScore)}</strong>
          <small>{memberScoreStateLabel(context.scoreState)}</small>
        </div>
      </div>
      <div className="live-opponent-status">
        <span
          className={`status-chip status-chip--matchup-${context.matchupStatus ?? "scheduled"}`}
        >
          {context.matchupStatus ? matchupStatusLabel(context.matchupStatus) : "Status unavailable"}
        </span>
        <small>{dashboard.weeklyInsights.freshness.label}</small>
      </div>
    </section>
  );
}

function WeeklyInsightsPanel({ dashboard }: { readonly dashboard: LeagueDashboard }) {
  const insights = dashboard.weeklyInsights;
  const metrics = insights.metrics;
  return (
    <section className="panel live-weekly-panel" aria-labelledby="live-weekly-title">
      <div className="panel-heading live-insights-heading">
        <div>
          <p className="eyebrow">League-wide weekly stats</p>
          <h3 id="live-weekly-title">
            {insights.week ? `Week ${insights.week} league pulse` : "Current-week league pulse"}
          </h3>
          <p>Provider scores only. No projections or estimated totals are mixed in.</p>
        </div>
        <span className="status-chip status-chip--live">
          <FreshnessDot state={insights.freshness.state} /> {insights.freshness.label}
        </span>
      </div>

      {insights.state !== "available" ? (
        <div className="live-insights-empty">
          <CircleAlert size={18} />
          <div>
            <strong>Current-week scoreboard unavailable</strong>
            <p>
              {insights.state === "unavailable"
                ? "No matchup snapshot has been stored for this league."
                : insights.week
                  ? `The latest snapshot contains no matchup rows for week ${insights.week}.`
                  : "The provider did not identify a current week."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="live-weekly-metrics" aria-label="Week metrics">
            <article>
              <span>Matchups complete</span>
              <strong>
                {metrics.completedMatchupCount}/{metrics.matchupCount}
              </strong>
              <small>
                {metrics.inProgressMatchupCount} live · {metrics.scheduledMatchupCount} scheduled
              </small>
            </article>
            <article>
              <span>League average</span>
              <strong>{scoreLabel(metrics.averageTeamScore)}</strong>
              <small>{metrics.scoredTeamCount} teams with scores</small>
            </article>
            <article>
              <span>High / low score</span>
              <strong>
                {scoreLabel(metrics.highestTeamScore)} / {scoreLabel(metrics.lowestTeamScore)}
              </strong>
              <small>Current provider totals</small>
            </article>
            <article>
              <span>Closest / largest margin</span>
              <strong>
                {scoreLabel(metrics.smallestScoreMargin)} / {scoreLabel(metrics.largestScoreMargin)}
              </strong>
              <small>Among matchups with scores</small>
            </article>
          </div>

          <div className="live-weekly-columns">
            <section aria-labelledby="live-scoreboard-title">
              <div className="live-subsection-heading">
                <h4 id="live-scoreboard-title">Scoreboard</h4>
                <span>{insights.matchups.length} matchups</span>
              </div>
              <div className="live-scoreboard-grid">
                {insights.matchups.map((matchup) => (
                  <article
                    className={`live-scoreboard-card${matchup.isCurrentUserMatchup ? " live-scoreboard-card--current" : ""}`}
                    key={matchup.id}
                  >
                    <div className="live-scoreboard-status">
                      <span>{matchupStatusLabel(matchup.status)}</span>
                      {matchup.isCurrentUserMatchup ? <strong>Your matchup</strong> : null}
                    </div>
                    {[matchup.away, matchup.home].map((team, index) => (
                      <div
                        className={`live-scoreboard-team${matchup.winnerTeamId === team.teamId ? " live-scoreboard-team--winner" : ""}`}
                        key={team.teamId}
                      >
                        <small>{index === 0 ? "Away" : "Home"}</small>
                        <span>
                          <strong>{team.teamName}</strong>
                          <small>{team.managerDisplayName ?? "Manager unavailable"}</small>
                        </span>
                        <b>{scoreLabel(team.score)}</b>
                      </div>
                    ))}
                  </article>
                ))}
              </div>
            </section>

            <section aria-labelledby="live-score-leaders-title">
              <div className="live-subsection-heading">
                <h4 id="live-score-leaders-title">Scoring leaders</h4>
                <span>Provider totals</span>
              </div>
              {insights.scoreLeaders.length === 0 ? (
                <p className="live-table-empty">Scores will appear after games begin.</p>
              ) : (
                <div className="live-table-scroll">
                  <table className="live-stats-table live-leader-table">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Team</th>
                        <th scope="col">Score</th>
                        <th scope="col">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.scoreLeaders.map((leader) => (
                        <tr
                          className={leader.isCurrentUser ? "is-current-user" : undefined}
                          key={leader.teamId}
                        >
                          <td>{leader.rank}</td>
                          <th scope="row">
                            {leader.teamName}
                            <small>vs {leader.opponentTeamName}</small>
                          </th>
                          <td className="live-number-cell">{scoreLabel(leader.score)}</td>
                          <td>{roleLabel(leader.outcome)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function StandingsPanel({ dashboard }: { readonly dashboard: LeagueDashboard }) {
  const standings = dashboard.standings;
  return (
    <section className="panel live-standings-panel" aria-labelledby="live-standings-title">
      <div className="panel-heading live-insights-heading">
        <div>
          <p className="eyebrow">League table</p>
          <h3 id="live-standings-title">Current standings</h3>
          <p>
            {standings.asOfWeek
              ? `Through week ${standings.asOfWeek}`
              : "Provider week unavailable"}
          </p>
        </div>
        <span className="status-chip status-chip--live">
          <FreshnessDot state={standings.freshness.state} /> {standings.freshness.label}
        </span>
      </div>
      {standings.state === "unavailable" ? (
        <p className="live-table-empty">No standings rows are stored for this league yet.</p>
      ) : (
        <div className="live-table-scroll">
          <table className="live-stats-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col">Record</th>
                <th scope="col">PF</th>
                <th scope="col">PA</th>
                <th scope="col">Diff</th>
                <th scope="col">Streak</th>
              </tr>
            </thead>
            <tbody>
              {standings.entries.map((entry) => (
                <tr
                  className={entry.isCurrentUser ? "is-current-user" : undefined}
                  key={entry.teamId}
                >
                  <td>
                    <strong>{entry.rank}</strong>
                    {entry.playoffSeed ? <small>Seed {entry.playoffSeed}</small> : null}
                  </td>
                  <th scope="row">
                    {entry.teamName}
                    <small>{entry.managerDisplayName ?? "Manager unavailable"}</small>
                  </th>
                  <td>{recordLabel(entry.wins, entry.losses, entry.ties)}</td>
                  <td className="live-number-cell">{scoreLabel(entry.pointsFor)}</td>
                  <td className="live-number-cell">{scoreLabel(entry.pointsAgainst)}</td>
                  <td className="live-number-cell">
                    {entry.pointDifferential > 0 ? "+" : ""}
                    {scoreLabel(entry.pointDifferential)}
                  </td>
                  <td>
                    {entry.streakType === "none" || entry.streakLength === 0
                      ? "—"
                      : `${entry.streakType.charAt(0).toUpperCase()}${entry.streakLength}`}
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

function LeagueDetail({
  dashboard,
  claimChoice,
  setClaimChoice,
  claimState,
  claimMessage,
  claimTeam,
}: LeagueDetailProps) {
  const claimedTeam = dashboard.teams.find((team) => team.claimStatus === "current-user");
  const selectableTeams = dashboard.teams.filter(
    (team) => team.claimStatus === "current-user" || team.claimStatus === "available",
  );
  const claimHeading = claimedTeam
    ? claimedTeam.name
    : dashboard.teamClaim.mode === "provider-mapped"
      ? "Confirm your Yahoo team"
      : dashboard.teamClaim.mode === "unavailable"
        ? "Team identity unavailable"
        : "Claim your team";
  const claimBadge =
    dashboard.teamClaim.mode === "provider-mapped"
      ? "Yahoo mapped"
      : dashboard.teamClaim.mode === "self-asserted"
        ? "Self-asserted"
        : "Claim retained";
  const selectedTeam =
    claimedTeam ?? dashboard.teams.find((team) => team.id === claimChoice) ?? dashboard.teams[0];
  const roster = selectedTeam?.latestRoster?.players ?? [];
  const starters = roster.filter((player) => player.isStarter);
  const bench = roster.filter((player) => !player.isStarter);

  return (
    <section className="live-league-detail" aria-labelledby="live-league-detail-title">
      <div className="section-heading live-detail-heading">
        <div>
          <p className="eyebrow">League details</p>
          <h2 id="live-league-detail-title">{dashboard.league.name}</h2>
          <p>
            {dashboard.season
              ? `${providerLabel(dashboard.season.provider)} ${dashboard.season.season} · ${dashboard.season.status} · ${dashboard.season.draftType}`
              : "No synchronized season"}
          </p>
        </div>
        <span className="status-chip status-chip--live">
          <FreshnessDot state={dashboard.season?.providerFreshness.state ?? "missing"} />
          {dashboard.season?.providerFreshness.label ?? "Never synced"}
        </span>
      </div>

      {dashboard.notices.length > 0 ? (
        <div className="live-notice-list">
          {dashboard.notices.map((notice) => (
            <p key={notice}>
              <CircleAlert size={15} /> {notice}
            </p>
          ))}
        </div>
      ) : null}

      <div className="live-overview-grid">
        <article>
          <span>Teams stored</span>
          <strong>
            {dashboard.overview.storedTeamCount}/{dashboard.overview.configuredTeamCount}
          </strong>
        </article>
        <article>
          <span>Roster snapshots</span>
          <strong>{dashboard.overview.teamsWithRosterSnapshots}</strong>
        </article>
        <article>
          <span>Roster entries</span>
          <strong>{dashboard.overview.rosteredPlayerCount}</strong>
        </article>
        <article>
          <span>Starting slots populated</span>
          <strong>{dashboard.overview.starterCount}</strong>
        </article>
      </div>

      <MemberWeekPanel dashboard={dashboard} />
      <WeeklyInsightsPanel dashboard={dashboard} />
      <StandingsPanel dashboard={dashboard} />

      <div className="live-detail-columns">
        <section className="panel live-team-panel">
          <div className="panel-heading panel-heading--tight">
            <div>
              <p className="eyebrow">Your team identity</p>
              <h3>{claimHeading}</h3>
            </div>
            {claimedTeam ? (
              <span className="status-chip status-chip--live">
                <CheckCircle2 size={13} /> {claimBadge}
              </span>
            ) : null}
          </div>
          <p className="live-claim-explainer">{dashboard.teamClaim.explanation}</p>
          {selectableTeams.length > 0 ? (
            <div className="live-claim-form">
              <label htmlFor="team-claim">Fantasy team</label>
              <select
                id="team-claim"
                value={claimChoice}
                onChange={(event) => setClaimChoice(event.target.value)}
              >
                {selectableTeams.map((team) => (
                  <option value={team.id} key={team.id}>
                    {team.name}
                    {team.managerDisplayName ? ` · ${team.managerDisplayName}` : ""}
                  </option>
                ))}
              </select>
              <button
                className="button button--dark"
                type="button"
                disabled={
                  !claimChoice || claimState === "saving" || claimChoice === claimedTeam?.id
                }
                onClick={claimTeam}
              >
                {claimState === "saving" ? <LoaderCircle className="spin" size={15} /> : null}
                {dashboard.teamClaim.mode === "provider-mapped"
                  ? "Confirm Yahoo team"
                  : claimedTeam
                    ? "Switch self-asserted team"
                    : "Claim this team"}
              </button>
            </div>
          ) : null}
          {claimMessage ? (
            <p className={`live-claim-message live-claim-message--${claimState}`} role="status">
              {claimMessage}
            </p>
          ) : null}

          <div className="live-roster-meta">
            <span>FAAB: {selectedTeam?.faabRemaining ?? "—"}</span>
            <span>Waiver priority: {selectedTeam?.waiverPriority ?? "—"}</span>
            <span>
              Roster as of{" "}
              {selectedTeam?.latestRoster?.effectiveAt
                ? new Date(selectedTeam.latestRoster.effectiveAt).toLocaleString()
                : "—"}
            </span>
          </div>
          <div className="live-roster-columns">
            <RosterGroup label="Starters" players={starters} />
            <RosterGroup label="Bench / reserve" players={bench} />
          </div>
        </section>

        <aside className="panel live-health-panel" id="data-health">
          <div className="panel-heading panel-heading--tight">
            <div>
              <p className="eyebrow">Sources & freshness</p>
              <h3>Data health</h3>
            </div>
            <Database size={18} />
          </div>
          <div className="live-sync-run">
            <span>Latest league sync</span>
            <strong>{dashboard.latestSyncRun?.state ?? "No run recorded"}</strong>
            <small>
              {dashboard.latestSyncRun
                ? `${dashboard.latestSyncRun.kind} · ${dashboard.latestSyncRun.recordsWritten} records written`
                : "Waiting for a provider import"}
            </small>
          </div>
          <div className="live-source-list">
            {dashboard.dataSources.length === 0 ? (
              <p>No supporting data sources have reported freshness yet.</p>
            ) : (
              dashboard.dataSources.map((source) => (
                <article key={source.key}>
                  <FreshnessDot state={source.freshness.state} />
                  <div>
                    <strong>{source.name}</strong>
                    <span>{source.freshness.label}</span>
                    {source.attributionUrl ? (
                      <a href={source.attributionUrl} target="_blank" rel="noreferrer">
                        {source.attribution ?? "Source attribution"}
                      </a>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function RosterGroup({
  label,
  players,
}: {
  readonly label: string;
  readonly players: NonNullable<LeagueDashboard["teams"][number]["latestRoster"]>["players"];
}) {
  return (
    <div className="live-roster-group">
      <h4>{label}</h4>
      {players.length === 0 ? (
        <p>No stored players.</p>
      ) : (
        players.map((player) => (
          <div className="live-roster-player" key={player.id}>
            <span>{player.slotCode}</span>
            <strong>{player.name}</strong>
            <small>
              {player.position} · {player.nflTeam ?? "FA"}
            </small>
          </div>
        ))
      )}
    </div>
  );
}

export function DashboardExperience() {
  const [state, setState] = useState<PortfolioState>({ status: "loading" });
  const portfolioRequestRef = useRef<AbortController | null>(null);
  const portfolioRequestGate = useRef(new LatestRequest());

  const loadPortfolio = useCallback(async () => {
    portfolioRequestRef.current?.abort();
    const controller = new AbortController();
    const request = portfolioRequestGate.current.begin("portfolio");
    portfolioRequestRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted && portfolioRequestGate.current.isCurrent(request);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues`, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (response.status === 401) {
        setState({ status: "demo", reason: "signed-out" });
        return;
      }
      if (!response.ok) {
        setState({ status: "demo", reason: "api-unavailable" });
        return;
      }
      const portfolio = parseLeagueListResponse(await response.json());
      if (!isCurrent()) return;
      setState(
        portfolio ? { status: "live", portfolio } : { status: "demo", reason: "invalid-response" },
      );
    } catch {
      if (!isCurrent()) return;
      setState({ status: "demo", reason: "api-unavailable" });
    } finally {
      if (isCurrent()) portfolioRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    void loadPortfolio();
    return () => {
      portfolioRequestRef.current?.abort();
      portfolioRequestRef.current = null;
      portfolioRequestGate.current.invalidate();
    };
  }, [loadPortfolio]);

  const content = useMemo(() => {
    if (state.status === "loading") return <LoadingDashboard />;
    if (state.status === "demo") return <DemoFallback reason={state.reason} />;
    return <LivePortfolio portfolio={state.portfolio} reloadPortfolio={loadPortfolio} />;
  }, [loadPortfolio, state]);

  return content;
}
