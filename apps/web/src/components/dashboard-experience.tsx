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
  Trophy,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseJobAccepted,
  parseEspnLeagueRefreshStatus,
  parseLeagueDashboard,
  parseLeagueListResponse,
  type EspnLeagueRefreshStatus,
  type LeagueDashboard,
  type LeagueListResponse,
} from "../lib/api-client";
import { shouldRequestEspnRefreshOnView } from "../lib/espn-refresh";
import { LatestRequest } from "../lib/latest-request";
import { yahooComingSoon } from "../lib/public-site";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";
import { DEMO_LEAGUE_ID } from "../lib/demo-contract-data";
import { leagueIsUnclaimed } from "../lib/team-claim";
import { useDefaultLeague } from "../lib/use-default-league";
import { AiCoachPanel } from "./ai-coach-panel";
import { ChangeFeedPanel } from "./change-feed-panel";
import { PortfolioDashboard } from "./portfolio-dashboard";
import { TeamAvatar } from "./team-avatar";
import { TeamClaimCallout } from "./team-claim-callout";

type PortfolioState =
  | { readonly status: "loading" }
  | {
      readonly status: "demo";
      readonly reason: "signed-out" | "api-unavailable" | "invalid-response";
    }
  | { readonly status: "unavailable"; readonly reason: "api-unavailable" | "invalid-response" }
  | { readonly status: "live"; readonly portfolio: LeagueListResponse };

type DashboardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly dashboard: LeagueDashboard }
  | { readonly status: "error"; readonly message: string };

type EspnRefreshUiState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly current: EspnLeagueRefreshStatus | null }
  | { readonly status: "ready"; readonly current: EspnLeagueRefreshStatus }
  | {
      readonly status: "error";
      readonly message: string;
      readonly current: EspnLeagueRefreshStatus | null;
    };

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

function MobileWeekAtGlance({ dashboard }: { readonly dashboard: LeagueDashboard }) {
  const context = dashboard.memberWeek;
  const leagueQuery = `league=${encodeURIComponent(dashboard.league.id)}`;
  const matchupAvailable = context.state === "available";
  const teamUnclaimed = context.state === "team-unclaimed";

  // Once a team is claimed, this card only earns its spot when there is an actual matchup to
  // glance at; a claimed league between snapshots renders nothing here.
  if (!matchupAvailable && !teamUnclaimed) return null;

  return (
    <section className="mobile-week-card" aria-labelledby="mobile-week-card-title">
      <div className="mobile-week-card__heading">
        <span className="mobile-week-card__icon" aria-hidden="true">
          <Trophy size={18} />
        </span>
        <div>
          <p className="eyebrow">
            {matchupAvailable && context.week
              ? `Week ${context.week} at a glance`
              : "Your next move"}
          </p>
          <h2 id="mobile-week-card-title">
            {matchupAvailable
              ? `${context.teamName ?? "Your team"} vs ${context.opponentTeamName ?? "opponent"}`
              : dashboard.league.name}
          </h2>
        </div>
        <span className="mobile-week-card__state">
          {matchupAvailable ? memberScoreStateLabel(context.scoreState) : "Claim team"}
        </span>
      </div>

      {matchupAvailable ? (
        <div className="mobile-week-card__score" aria-label="Current matchup score">
          <span className="live-team-cell">
            <TeamAvatar
              teamName={context.teamName ?? "Your team"}
              logoUrl={context.teamLogoUrl}
              size="medium"
              highlight
            />
            <span>
              You <strong>{scoreLabel(context.teamScore)}</strong>
            </span>
          </span>
          <small>vs</small>
          <span className="live-team-cell live-team-cell--end">
            <TeamAvatar
              teamName={context.opponentTeamName ?? "Opponent"}
              logoUrl={context.opponentLogoUrl}
              size="medium"
            />
            <span>
              Them <strong>{scoreLabel(context.opponentScore)}</strong>
            </span>
          </span>
        </div>
      ) : (
        <p className="mobile-week-card__summary">
          Claim your team to unlock lineup, waiver, trade, and opponent guidance.
        </p>
      )}

      {matchupAvailable ? (
        <nav className="mobile-week-card__actions" aria-label="This week shortcuts">
          <Link href={`/decisions?${leagueQuery}#decision-lineup`}>
            Set lineup <ArrowRight size={13} />
          </Link>
          <Link href={`/analytics?${leagueQuery}#analytics-opponent`}>
            Scout opponent <ArrowRight size={13} />
          </Link>
          <Link href={`/analytics?${leagueQuery}#analytics-season`}>
            League pulse <ArrowRight size={13} />
          </Link>
        </nav>
      ) : null}
    </section>
  );
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

function PortfolioUnavailable({
  reason,
  retry,
  showSample,
}: {
  readonly reason: Extract<PortfolioState, { status: "unavailable" }>["reason"];
  readonly retry: () => void;
  readonly showSample: () => void;
}) {
  return (
    <div className="dashboard-page">
      <div className="dashboard-mode-notice dashboard-mode-notice--error" role="alert">
        <CircleAlert size={16} />
        <span>
          {reason === "api-unavailable"
            ? "Your leagues could not be loaded. They are still there — this is a connection problem, not a data loss."
            : "The API returned a response this version could not read, so your leagues were withheld rather than guessed at."}
        </span>
        <button className="button button--outline button--small" type="button" onClick={retry}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
      <div className="dashboard-mode-notice" role="status">
        <span>Nothing below is your data.</span>
        <button className="button button--small" type="button" onClick={showSample}>
          Show the sample locker room
        </button>
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
      <PortfolioDashboard
        afterOverview={
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
            description="Every sample starts with the league engine's board, then uses Gemini to explain what is worth doing and what is not."
          />
        }
      />
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
          <h2>{yahooComingSoon ? "Connect ESPN" : "Connect Yahoo or ESPN"}</h2>
          <p>
            {yahooComingSoon
              ? "ESPN sync is available now. Yahoo league sync is coming soon."
              : "Once a sync succeeds, this page will use the stored league, team, and roster data."}
          </p>
        </div>
        <Link className="button button--dark" href="/connections">
          Open League Sync <ArrowRight size={15} />
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
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const { defaultLeagueId, loaded: preferenceLoaded } = useDefaultLeague();
  const appliedDefault = useRef(false);

  useEffect(() => {
    // Applied once, so a member who switches leagues is not pulled back to their default.
    if (!preferenceLoaded || appliedDefault.current) return;
    appliedDefault.current = true;
    const preferred =
      defaultLeagueId && portfolio.leagues.some((league) => league.id === defaultLeagueId)
        ? defaultLeagueId
        : null;
    setSelectedLeagueId(preferred ?? portfolio.leagues[0]?.id ?? "");
  }, [defaultLeagueId, portfolio.leagues, preferenceLoaded]);
  const [dashboardState, setDashboardState] = useState<DashboardState>({ status: "loading" });
  const [claimChoice, setClaimChoice] = useState("");
  const [claimState, setClaimState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [claimMessage, setClaimMessage] = useState("");
  const [sourceRefreshState, setSourceRefreshState] = useState<
    "idle" | "working" | "queued" | "deduplicated" | "error"
  >("idle");
  const dashboardRequest = useRef<AbortController | null>(null);
  const completedEspnRequest = useRef<string | null>(null);
  const [espnRefreshState, setEspnRefreshState] = useState<EspnRefreshUiState>({
    status: "idle",
  });
  const selectedSummary = portfolio.leagues.find((league) => league.id === selectedLeagueId);
  const selectedEspnSeason =
    selectedSummary?.season?.provider === "espn" ? selectedSummary.season : null;

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

  const requestEspnRefresh = useCallback(async () => {
    if (!selectedEspnSeason) return;
    setEspnRefreshState((previous) => ({
      status: "working",
      current:
        previous.status === "ready" || previous.status === "working" || previous.status === "error"
          ? previous.current
          : null,
    }));
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedEspnSeason.id)}/refresh`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        },
      );
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new Error("ESPN refresh could not be requested.");
      const status = parseEspnLeagueRefreshStatus(await response.json());
      if (!status) throw new Error("ESPN refresh returned an invalid status.");
      setEspnRefreshState({ status: "ready", current: status });
    } catch (error) {
      setEspnRefreshState((previous) => ({
        status: "error",
        message: error instanceof Error ? error.message : "ESPN refresh could not be requested.",
        current:
          previous.status === "ready" ||
          previous.status === "working" ||
          previous.status === "error"
            ? previous.current
            : null,
      }));
    }
  }, [selectedEspnSeason]);

  useEffect(() => {
    completedEspnRequest.current = null;
    setEspnRefreshState({ status: "idle" });
  }, [selectedEspnSeason?.id]);

  useEffect(() => {
    if (!selectedEspnSeason || dashboardState.status !== "ready") return;
    const key = `laces-out:espn-stale-on-view:${selectedEspnSeason.id}`;
    const now = Date.now();
    try {
      if (!shouldRequestEspnRefreshOnView(window.sessionStorage.getItem(key), now)) {
        return;
      }
      window.sessionStorage.setItem(key, String(now));
    } catch {
      // Session storage may be blocked. Request idempotency still makes one extra call harmless.
    }
    void requestEspnRefresh();
  }, [dashboardState.status, requestEspnRefresh, selectedEspnSeason]);

  const refreshStatus =
    espnRefreshState.status === "ready" ||
    espnRefreshState.status === "working" ||
    espnRefreshState.status === "error"
      ? espnRefreshState.current
      : null;

  useEffect(() => {
    if (!selectedEspnSeason || !refreshStatus?.request) return;
    const request = refreshStatus.request;
    if (request.state !== "queued" && request.state !== "processing") return;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedEspnSeason.id)}/refresh/status`,
          {
            credentials: "include",
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const status = parseEspnLeagueRefreshStatus(await response.json());
        if (!status || controller.signal.aborted) return;
        setEspnRefreshState({ status: "ready", current: status });
        if (
          status.current &&
          status.request?.state === "succeeded" &&
          completedEspnRequest.current !== status.request.id
        ) {
          completedEspnRequest.current = status.request.id;
          await Promise.all([loadDashboard(), reloadPortfolio()]);
        }
      } catch {
        // Cached data remains rendered; the next status tick or manual action can reconnect.
      } finally {
        polling = false;
      }
    };
    const interval = window.setInterval(() => {
      void poll();
    }, 5_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [loadDashboard, refreshStatus, reloadPortfolio, selectedEspnSeason]);

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
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new Error("Shared NFL-data check could not be queued.");
      const body = parseJobAccepted(await response.json());
      if (!body) throw new Error("Shared NFL-data queue response was invalid.");
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
          <h1>
            {portfolio.leagues.length === 1
              ? "1 connected league. One clear view."
              : `${portfolio.leagues.length} connected leagues in one view.`}
          </h1>
          <p className="page-subtitle">
            Fresh league and projection data power every lineup, waiver, and trade call.
          </p>
        </div>
        <div className="heading-actions">
          {selectedEspnSeason ? (
            <>
              <span
                className="freshness-label"
                role="status"
                title={
                  refreshStatus
                    ? refreshStatus.artifacts
                        .map((artifact) => `${artifact.family}: ${artifact.state}`)
                        .join(" · ")
                    : undefined
                }
              >
                <FreshnessDot
                  state={
                    refreshStatus?.current
                      ? "fresh"
                      : refreshStatus?.artifacts.some((artifact) => artifact.state === "missing")
                        ? "missing"
                        : "stale"
                  }
                />
                {espnRefreshState.status === "working" && !refreshStatus
                  ? "Checking ESPN freshness…"
                  : espnRefreshState.status === "error" && !refreshStatus
                    ? espnRefreshState.message
                    : (refreshStatus?.display.label ?? "ESPN refresh status pending")}
              </span>
              <button
                className="button button--outline"
                type="button"
                onClick={() => void requestEspnRefresh()}
                disabled={espnRefreshState.status === "working"}
              >
                {espnRefreshState.status === "working" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <RefreshCw size={16} />
                )}
                Refresh league
              </button>
            </>
          ) : null}
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
            title="Check shared NFL inputs and rerun managed forecasts when inputs change"
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
                ? "Forecast input check queued"
                : sourceRefreshState === "deduplicated"
                  ? "Input check already queued"
                  : sourceRefreshState === "error"
                    ? "Retry input check"
                    : "Check forecast inputs"}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {sourceRefreshState === "queued"
              ? "Forecast input check queued."
              : sourceRefreshState === "deduplicated"
                ? "A recent forecast input check is already queued."
                : sourceRefreshState === "error"
                  ? "Forecast input check could not be queued."
                  : ""}
          </span>
        </div>
      </section>

      {currentDashboard ? <MobileWeekAtGlance dashboard={currentDashboard} /> : null}

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
            <small>Freshness follows each provider and season context</small>
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

      {/* ChangeFeedPanel is a shared component whose own .panel carries no top
          margin (other host pages sit it inside a CSS-grid gap, which supplies
          it for free). This page has no such grid, so it needs the same
          section-to-section gap the rest of the page already uses. */}
      <div className="section-block">
        <ChangeFeedPanel leagueId={selectedLeagueId || null} />
      </div>

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
          onTeamClaimed={() => void Promise.all([loadDashboard(), reloadPortfolio()])}
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
  readonly onTeamClaimed: () => void;
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
          <span className="live-team-cell">
            <TeamAvatar
              teamName={context.teamName ?? "Your team"}
              logoUrl={context.teamLogoUrl}
              size="medium"
              highlight
            />
            <span>{context.teamName ?? "Your team"}</span>
          </span>
          <strong>{scoreLabel(context.teamScore)}</strong>
          <small>
            {context.standingRank ? `#${context.standingRank} · ` : ""}
            {recordLabel(context.wins, context.losses, context.ties)}
          </small>
        </div>
        <span className="live-score-divider">vs</span>
        <div>
          <span className="live-team-cell live-team-cell--end">
            <TeamAvatar
              teamName={context.opponentTeamName ?? "Opponent"}
              logoUrl={context.opponentLogoUrl}
              size="medium"
            />
            <span>{context.opponentTeamName ?? "Opponent"}</span>
          </span>
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

type WeeklyMatchupTeam = LeagueDashboard["weeklyInsights"]["matchups"][number]["home"];

/**
 * Score leader rows name a team but carry no logo of their own. The week's matchup rows are the
 * source those leaders are derived from, so they are also the source for a leader's avatar.
 */
function matchupTeamsById(
  matchups: LeagueDashboard["weeklyInsights"]["matchups"],
): ReadonlyMap<string, WeeklyMatchupTeam> {
  const teams = new Map<string, WeeklyMatchupTeam>();
  for (const matchup of matchups) {
    teams.set(matchup.home.teamId, matchup.home);
    teams.set(matchup.away.teamId, matchup.away);
  }
  return teams;
}

function WeeklyInsightsPanel({ dashboard }: { readonly dashboard: LeagueDashboard }) {
  const insights = dashboard.weeklyInsights;
  const metrics = insights.metrics;
  const teamsById = useMemo(() => matchupTeamsById(insights.matchups), [insights.matchups]);
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
                        <div className="live-team-cell">
                          <TeamAvatar
                            teamName={team.teamName}
                            logoUrl={team.logoUrl}
                            abbreviation={team.abbreviation}
                            size="small"
                          />
                          <span>
                            <strong>{team.teamName}</strong>
                            <small>{team.managerDisplayName ?? "Manager unavailable"}</small>
                          </span>
                        </div>
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
                      {insights.scoreLeaders.map((leader) => {
                        const leaderTeam = teamsById.get(leader.teamId);
                        return (
                          <tr
                            className={leader.isCurrentUser ? "is-current-user" : undefined}
                            key={leader.teamId}
                          >
                            <td>{leader.rank}</td>
                            <th scope="row">
                              <div className="live-team-cell">
                                <TeamAvatar
                                  teamName={leader.teamName}
                                  logoUrl={leaderTeam?.logoUrl ?? null}
                                  abbreviation={leaderTeam?.abbreviation ?? null}
                                  size="small"
                                  highlight={leader.isCurrentUser}
                                />
                                <span>
                                  {leader.teamName}
                                  <small>vs {leader.opponentTeamName}</small>
                                </span>
                              </div>
                            </th>
                            <td className="live-number-cell">{scoreLabel(leader.score)}</td>
                            <td>{roleLabel(leader.outcome)}</td>
                          </tr>
                        );
                      })}
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
                    <div className="live-team-cell">
                      <TeamAvatar
                        teamName={entry.teamName}
                        logoUrl={entry.logoUrl}
                        abbreviation={entry.abbreviation}
                        size="small"
                        highlight={entry.isCurrentUser}
                      />
                      <span>
                        {entry.teamName}
                        <small>{entry.managerDisplayName ?? "Manager unavailable"}</small>
                      </span>
                    </div>
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
  onTeamClaimed,
}: LeagueDetailProps) {
  const claimedTeam = dashboard.teams.find((team) => team.claimStatus === "current-user");
  const selectableTeams = dashboard.teams.filter(
    (team) => team.claimStatus === "current-user" || team.claimStatus === "available",
  );
  const unclaimed = leagueIsUnclaimed(dashboard);
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

      {unclaimed ? (
        <TeamClaimCallout
          leagueId={dashboard.league.id}
          dashboard={dashboard}
          onClaimed={onTeamClaimed}
        />
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

      {/* Data health used to sit in a second column here. It now lives in exactly one place —
          the bottom of Settings — so source freshness stops competing with the member's own
          roster for attention on their league page. */}
      <div className="live-detail-columns live-detail-columns--single">
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
          {/* Unclaimed leagues get exactly one claim form: the TeamClaimCallout above. This
              panel's own form only reappears once a team is claimed, for the switch flow. */}
          {!unclaimed && selectableTeams.length > 0 ? (
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
      // A failure is not a signed-out visitor. Substituting the sample portfolio
      // here showed a signed-in user four leagues that are not theirs, with no
      // way back other than reloading the page.
      if (!response.ok) {
        setState({ status: "unavailable", reason: "api-unavailable" });
        return;
      }
      const portfolio = parseLeagueListResponse(await response.json());
      if (!isCurrent()) return;
      setState(
        portfolio
          ? { status: "live", portfolio }
          : { status: "unavailable", reason: "invalid-response" },
      );
    } catch {
      if (!isCurrent()) return;
      setState({ status: "unavailable", reason: "api-unavailable" });
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
    if (state.status === "unavailable") {
      return (
        <PortfolioUnavailable
          reason={state.reason}
          retry={() => void loadPortfolio()}
          showSample={() => setState({ status: "demo", reason: state.reason })}
        />
      );
    }
    return <LivePortfolio portfolio={state.portfolio} reloadPortfolio={loadPortfolio} />;
  }, [loadPortfolio, state]);

  return content;
}
