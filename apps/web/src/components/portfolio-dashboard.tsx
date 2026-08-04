"use client";

import {
  ArrowRight,
  ArrowUp,
  BadgeDollarSign,
  CalendarClock,
  Check,
  ChevronDown,
  CircleGauge,
  ClipboardCheck,
  ExternalLink,
  HeartPulse,
  Info,
  ListPlus,
  LockKeyhole,
  RefreshCw,
  Repeat2,
  ShieldAlert,
  Target,
  TrendingUp,
  UsersRound,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";

import {
  decisions,
  exposurePlayers,
  leagues,
  type DecisionAction,
  type LeagueSummary,
} from "../lib/demo-data";
import { yahooComingSoon } from "../lib/public-site";

type LeagueFilter = string;

const accentLabels: Record<LeagueSummary["accent"], string> = {
  lime: "Lime",
  blue: "Blue",
  orange: "Orange",
  violet: "Violet",
};

function ActionIcon({ kind }: { kind: DecisionAction["kind"] }) {
  if (kind === "lineup") return <ClipboardCheck size={18} />;
  if (kind === "waiver") return <ListPlus size={18} />;
  return <Repeat2 size={18} />;
}

function ProjectionSparkline({ favorable }: { favorable: boolean }) {
  const stroke = favorable ? "var(--lime-600)" : "var(--orange-600)";
  return (
    <svg
      className="sparkline"
      viewBox="0 0 100 34"
      role="img"
      aria-label="Illustrative projection trend"
    >
      <path
        d="M2 27 C 13 24, 17 26, 27 20 S 42 23, 51 15 S 66 19, 75 11 S 88 12, 98 5"
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
      />
      <path
        d="M2 27 C 13 24, 17 26, 27 20 S 42 23, 51 15 S 66 19, 75 11 S 88 12, 98 5 L98 34 L2 34 Z"
        fill={stroke}
        opacity=".09"
      />
    </svg>
  );
}

export function PortfolioDashboard({ afterOverview }: { readonly afterOverview?: ReactNode }) {
  const [leagueFilter, setLeagueFilter] = useState<LeagueFilter>("all");
  const [openDecision, setOpenDecision] = useState<string | null>(decisions[0]?.id ?? null);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [providerExpanded, setProviderExpanded] = useState<"Yahoo" | "ESPN" | null>(null);

  const visibleDecisions = useMemo(
    () =>
      leagueFilter === "all"
        ? decisions
        : decisions.filter((item) => item.leagueId === leagueFilter),
    [leagueFilter],
  );

  const selectedLeague =
    leagueFilter === "all" ? null : (leagues.find((league) => league.id === leagueFilter) ?? null);

  function toggleReviewed(id: string) {
    setReviewed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="dashboard-page">
      <section className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">League overview</p>
          <h1>Four leagues. One decision board.</h1>
          <p className="page-subtitle">
            Prioritize the lineup, waiver, and trade decisions that can change your week across
            every league.
          </p>
        </div>
        <div className="heading-actions">
          <span className="freshness-label">
            <span className="freshness-dot freshness-dot--demo" />
            Snapshot · Oct 8, 1:42 PM
          </span>
        </div>
      </section>

      <section className="overview-strip" aria-label="Portfolio overview">
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--ink">
            <UsersRound size={18} />
          </span>
          <div>
            <span>League portfolio</span>
            <strong>4 leagues</strong>
            <small>2 auction · 2 snake</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--lime">
            <TrendingUp size={18} />
          </span>
          <div>
            <span>Weekly edge</span>
            <strong>+12.4 pts</strong>
            <small>Across 4 lineup checks</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--orange">
            <Zap size={18} />
          </span>
          <div>
            <span>Decisions waiting</span>
            <strong>{decisions.length - reviewed.size} open</strong>
            <small>{reviewed.size} reviewed locally</small>
          </div>
        </article>
        <article className="overview-stat">
          <span className="overview-stat__icon overview-stat__icon--blue">
            <HeartPulse size={18} />
          </span>
          <div>
            <span>Live data health</span>
            <strong>Not connected</strong>
            <small>Demo UI only</small>
          </div>
        </article>
      </section>

      <section className="section-block league-section" aria-labelledby="league-board-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Portfolio board</p>
            <h2 id="league-board-title">Your leagues at a glance</h2>
          </div>
          <button
            className={`filter-pill${leagueFilter === "all" ? " filter-pill--active" : ""}`}
            type="button"
            onClick={() => setLeagueFilter("all")}
          >
            Show all
          </button>
        </div>

        <div className="league-grid">
          {leagues.map((league) => {
            const selected = leagueFilter === league.id;
            const favorable = league.projected >= league.opponentProjected;
            return (
              <button
                className={`league-card league-card--${league.accent}${selected ? " league-card--selected" : ""}`}
                type="button"
                onClick={() => setLeagueFilter(selected ? "all" : league.id)}
                aria-pressed={selected}
                aria-label={`Filter decisions to ${league.name}`}
                key={league.id}
              >
                <div className="league-card__top">
                  <span className="league-monogram" aria-hidden="true">
                    {league.shortName}
                  </span>
                  <span className="provider-badge">{league.provider}</span>
                  <span className="league-format">{league.format}</span>
                </div>
                <div className="league-card__identity">
                  <span>{league.name}</span>
                  <strong>{league.teamName}</strong>
                  <small>
                    {league.role} · {league.place}
                  </small>
                </div>
                <div className="matchup-row">
                  <div>
                    <span>Sample matchup</span>
                    <strong>{league.projected.toFixed(1)}</strong>
                  </div>
                  <ProjectionSparkline favorable={favorable} />
                  <div className="matchup-opponent">
                    <span>vs {league.opponent}</span>
                    <strong>{league.opponentProjected.toFixed(1)}</strong>
                  </div>
                </div>
                <div className="league-card__footer">
                  <span className="edge-chip">
                    <ArrowUp size={12} /> +{league.lineupGain.toFixed(1)} lineup
                  </span>
                  <span className="league-freshness">{league.dataState}</span>
                </div>
                <span className="sr-only">Theme: {accentLabels[league.accent]}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="dashboard-columns" id="decisions">
        <section className="panel decision-panel" aria-labelledby="decision-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Decision inbox</p>
              <h2 id="decision-title">What deserves attention</h2>
              <p>
                {selectedLeague
                  ? `Showing sample analysis for ${selectedLeague.name}.`
                  : "Ranked by projected impact and urgency."}
              </p>
            </div>
            <span className="count-badge">{visibleDecisions.length}</span>
          </div>

          <div className="decision-list">
            {visibleDecisions.length === 0 ? (
              <div className="empty-state">
                <Check size={20} />
                <strong>No sample decisions for this league</strong>
                <button type="button" onClick={() => setLeagueFilter("all")}>
                  Clear the filter
                </button>
              </div>
            ) : (
              visibleDecisions.map((decision) => {
                const expanded = openDecision === decision.id;
                const isReviewed = reviewed.has(decision.id);
                const league = leagues.find((item) => item.id === decision.leagueId);
                return (
                  <article
                    className={`decision-card decision-card--${decision.kind}${isReviewed ? " decision-card--reviewed" : ""}`}
                    key={decision.id}
                  >
                    <button
                      className="decision-card__summary"
                      type="button"
                      onClick={() => setOpenDecision(expanded ? null : decision.id)}
                      aria-expanded={expanded}
                    >
                      <span className="decision-icon">
                        <ActionIcon kind={decision.kind} />
                      </span>
                      <span className="decision-copy">
                        <span className="decision-meta">
                          {decision.eyebrow} · {league?.shortName ?? "League"}
                        </span>
                        <strong>{decision.title}</strong>
                        <span>{decision.summary}</span>
                      </span>
                      <span className="decision-impact">
                        <strong>{decision.impact}</strong>
                        <small>{decision.confidence} confidence</small>
                      </span>
                      <ChevronDown className={expanded ? "is-rotated" : ""} size={18} />
                    </button>
                    {expanded ? (
                      <div className="decision-detail">
                        <div>
                          <p>{decision.rationale}</p>
                          <span>
                            <Info size={13} /> {decision.freshness}
                          </span>
                        </div>
                        <button
                          className={`button button--small${isReviewed ? " button--soft" : " button--dark"}`}
                          type="button"
                          onClick={() => toggleReviewed(decision.id)}
                        >
                          {isReviewed ? (
                            <>
                              <Check size={15} /> Reviewed
                            </>
                          ) : (
                            <>
                              Mark reviewed <ArrowRight size={14} />
                            </>
                          )}
                        </button>
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>

          <div className="panel-footnote">
            <ShieldAlert size={15} />
            Recommendation actions are intentionally read-only. You make the final move on the
            league provider.
          </div>
        </section>

        <aside className="right-stack">
          <section className="panel week-panel" aria-labelledby="week-title">
            <div className="panel-heading panel-heading--tight">
              <div>
                <p className="eyebrow">Sample outlook</p>
                <h2 id="week-title">Portfolio pulse</h2>
              </div>
              <span className="status-chip status-chip--demo">Demo</span>
            </div>
            <div className="win-ring-row">
              <div
                className="win-ring"
                aria-label="Illustrative 62 percent average win probability"
              >
                <span>
                  <strong>62%</strong>
                  <small>avg. win</small>
                </span>
              </div>
              <div className="win-ring-copy">
                <strong>3 of 4 favored</strong>
                <p>Illustrative probabilities based on the demo matchup projections.</p>
              </div>
            </div>
            <div className="mini-metrics">
              <div>
                <span>
                  <Target size={14} /> Closest matchup
                </span>
                <strong>NL · −3.9</strong>
              </div>
              <div>
                <span>
                  <CalendarClock size={14} /> Next checkpoint
                </span>
                <strong>Fri · 4:00 PM</strong>
              </div>
              <div>
                <span>
                  <BadgeDollarSign size={14} /> Sample FAAB
                </span>
                <strong>$83 median</strong>
              </div>
            </div>
          </section>

          <section className="panel draft-card" aria-labelledby="draft-card-title">
            <span className="draft-card__flag">
              <CircleGauge size={16} /> Practice room
            </span>
            <p className="eyebrow">Live draft assistant</p>
            <h2 id="draft-card-title">Know your ceiling before the hammer drops.</h2>
            <p>
              Test dynamic auction values, room budgets, and snake availability in a safe local
              sandbox.
            </p>
            <div className="draft-card__metrics">
              <div>
                <span>Demo budget</span>
                <strong>$163</strong>
              </div>
              <div>
                <span>Open slots</span>
                <strong>14</strong>
              </div>
              <div>
                <span>Value targets</span>
                <strong>4</strong>
              </div>
            </div>
            <Link className="button button--lime" href="/draft">
              Enter draft studio <ArrowRight size={15} />
            </Link>
          </section>
        </aside>
      </div>

      {/* Follows the leagues and the decision inbox. Above them it filled 55% of
          the desktop fold and pushed the inbox two swipes down on mobile. */}
      {afterOverview ? <div className="dashboard-ai-tour">{afterOverview}</div> : null}

      <section className="data-section" id="data-health" aria-labelledby="connections-title">
        <div className="section-heading section-heading--connections">
          <div>
            <p className="eyebrow">Connection center</p>
            <h2 id="connections-title">Provider truth, in plain English</h2>
            <p>
              Connection modes stay explicit so an import is never mistaken for a live official
              integration.
            </p>
          </div>
          <span className="read-only-badge">
            <LockKeyhole size={14} /> Read-only by design
          </span>
        </div>

        <div className="provider-grid">
          <article className="provider-card">
            <div className="provider-card__head">
              <span className="provider-logo provider-logo--espn">E</span>
              <div>
                <h3>ESPN Fantasy</h3>
                <p>One-click + automatic sync</p>
              </div>
            </div>
            <p className="provider-description">
              Private leagues sync from the ESPN session already open in your browser without
              sharing a password or cookie.
            </p>
            <div className="provider-facts">
              <span>
                <Check size={14} /> One-click, multi-league sync
              </span>
              <span>
                <Check size={14} /> Five-minute intent checks + six-hour safety sweep
              </span>
              <span>
                <Check size={14} /> Availability, box scores, transactions, and draft results
              </span>
              <span>
                <ShieldAlert size={14} /> ESPN cookies stay in the browser
              </span>
            </div>
            <button
              className="button button--outline button--full"
              type="button"
              onClick={() => setProviderExpanded(providerExpanded === "ESPN" ? null : "ESPN")}
            >
              {providerExpanded === "ESPN" ? "Hide sync details" : "View sync details"}
              <ChevronDown className={providerExpanded === "ESPN" ? "is-rotated" : ""} size={16} />
            </button>
            {providerExpanded === "ESPN" ? (
              <div className="provider-detail provider-detail--stack">
                <p>
                  <ExternalLink size={14} /> <strong>One-click sync:</strong> save a scoped
                  bookmark, sign in on ESPN, and run it whenever you want fresh league data.
                </p>
                <p>
                  <Zap size={14} /> <strong>Automatic sync:</strong> the optional Chrome companion
                  checks for requested work every five minutes while Chrome is running and keeps a
                  six-hour full sweep. A verified public league can refresh core data directly when
                  the deployment operator enables the default-off unofficial path.
                </p>
                <p>
                  <RefreshCw size={14} /> <strong>Truthful states:</strong> the live account shows
                  deterministic examples such as “Refreshing directly from ESPN,” “Refresh queued ·
                  waiting for a paired device,” “Up to date,” and “Open the paired browser and sign
                  in to ESPN.” Cached data remains visible in every state.
                </p>
                <p>
                  <ShieldAlert size={14} /> <strong>Credential boundary:</strong> ESPN passwords,
                  cookies, SWID, and espn_s2 never enter the app.
                </p>
              </div>
            ) : null}
          </article>

          <article className="provider-card">
            <div className="provider-card__head">
              <span className="provider-logo provider-logo--yahoo">Y!</span>
              <div>
                <h3>Yahoo Fantasy</h3>
                <p>Official API + OAuth 2.0</p>
              </div>
              <span className="provider-state provider-state--pending">
                {yahooComingSoon ? "Coming soon" : "OAuth ready"}
              </span>
            </div>
            <p className="provider-description">
              {yahooComingSoon
                ? "Yahoo sign-in and read-only league sync are coming soon."
                : "Yahoo sign-in uses the official Authorization Code + PKCE flow. With approved Fantasy API credentials configured, leagues are discovered automatically and settings, team, roster, standings, and scoreboard data sync read-only."}
            </p>
            {/* These were ungated, so the card read "Coming soon" directly above
                a green check claiming the sync was already there. */}
            <div className="provider-facts">
              {yahooComingSoon ? (
                <>
                  <span>
                    <ShieldAlert size={14} /> Yahoo sign-in is not open yet
                  </span>
                  <span>
                    <Check size={14} /> Official sign-in, no password sharing
                  </span>
                  <span>
                    <Check size={14} /> Read-only when it opens
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <Check size={14} /> Official Yahoo sign-in
                  </span>
                  <span>
                    <Check size={14} /> Read-only league sync
                  </span>
                  <span>
                    <Check size={14} /> Your tokens stay encrypted on your server
                  </span>
                </>
              )}
            </div>
            <button
              className="button button--outline button--full"
              type="button"
              onClick={() => setProviderExpanded(providerExpanded === "Yahoo" ? null : "Yahoo")}
            >
              {providerExpanded === "Yahoo" ? "Hide sync details" : "View sync details"}
              <ChevronDown className={providerExpanded === "Yahoo" ? "is-rotated" : ""} size={16} />
            </button>
            {providerExpanded === "Yahoo" ? (
              <div className="provider-detail">
                <Info size={15} />
                <p>
                  {yahooComingSoon
                    ? "This tour is not a connected account. Yahoo sign-in is coming soon; when available, token exchange will stay server-side and refresh tokens will remain encrypted."
                    : "This sample screen is not a connected account. After sign-in, League Sync can start Yahoo authorization. Token exchange stays server-side and refresh tokens are encrypted."}
                </p>
              </div>
            ) : null}
          </article>

          <article className="provider-card provider-card--health">
            <div className="provider-card__head">
              <span className="provider-logo provider-logo--health">
                <HeartPulse size={20} />
              </span>
              <div>
                <h3>Data health</h3>
                <p>Source-by-source freshness</p>
              </div>
              <span className="provider-state provider-state--demo">Demo only</span>
            </div>
            <div className="health-list">
              <div>
                <span>
                  <i className="health-dot health-dot--off" /> League rosters
                </span>
                <strong>Not connected</strong>
              </div>
              <div>
                <span>
                  <i className="health-dot health-dot--demo" /> Projections
                </span>
                <strong>Sample fixture</strong>
              </div>
              <div>
                <span>
                  <i className="health-dot health-dot--demo" /> Injuries
                </span>
                <strong>Sample fixture</strong>
              </div>
              <div>
                <span>
                  <i className="health-dot health-dot--off" /> Availability
                </span>
                <strong>Not connected</strong>
              </div>
            </div>
            <p className="health-note">
              <Info size={14} /> Production recommendations will retain source, fetch time, model
              version, and confidence.
            </p>
          </article>
        </div>
      </section>

      <section className="panel exposure-panel" aria-labelledby="exposure-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Across your portfolio</p>
            <h2 id="exposure-title">Player exposure preview</h2>
            <p>See where one injury or breakout affects multiple leagues.</p>
          </div>
          <span className="status-chip status-chip--demo">Illustrative</span>
        </div>
        <div
          className="exposure-table-wrap"
          tabIndex={0}
          aria-label="Player exposure table; scroll horizontally for more columns"
        >
          <table className="exposure-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Leagues</th>
                <th scope="col">Projected points share</th>
                <th scope="col">Signal</th>
              </tr>
            </thead>
            <tbody>
              {exposurePlayers.map((player) => (
                <tr key={player.name}>
                  <th scope="row">
                    <span className="player-avatar">
                      {player.name
                        .split(" ")
                        .map((part) => part[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span>
                      <strong>{player.name}</strong>
                      <small>{player.meta}</small>
                    </span>
                  </th>
                  <td>
                    <span
                      className="league-dots"
                      role="img"
                      aria-label={`${player.leagues} leagues`}
                    >
                      {Array.from({ length: 4 }, (_, index) => (
                        <i className={index < player.leagues ? "is-filled" : ""} key={index} />
                      ))}
                    </span>
                  </td>
                  <td>
                    <div className="exposure-bar">
                      <span style={{ width: `${player.projectedShare * 3.5}%` }} />
                    </div>
                    <strong>{player.projectedShare}%</strong>
                  </td>
                  <td>
                    <span className={`trend trend--${player.direction}`}>
                      {player.direction === "up"
                        ? "Rising"
                        : player.direction === "down"
                          ? "Monitor"
                          : "Steady"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
