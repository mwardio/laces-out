"use client";

import {
  playerExposureResponseSchema,
  type PlayerExposureLeague,
  type PlayerExposureResponse,
} from "@laces-out/contracts";
import { AlertCircle, Info, LoaderCircle, RefreshCw, Search, UsersRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-session";
import { compactDate, providerLabel } from "../lib/copy";
import styles from "./player-exposure-panel.module.css";

interface PlayerExposurePanelProps {
  readonly refreshToken: string;
}

const previewLimit = 8;

function coverageLabel(league: PlayerExposureLeague): string {
  if (league.status === "archived") return "Excluded · archived league";
  if (league.status === "other-season") return `Excluded · ${league.season} season`;
  if (league.status === "no-season") return "Excluded · no season synced";
  if (league.status === "team-unclaimed") return "Excluded · select your team in Settings";
  if (league.status === "roster-missing") return "Excluded · no saved roster for your team";
  return `Included${league.week !== null ? ` · Week ${league.week}` : ""}`;
}

function emptyMessage(feed: PlayerExposureResponse): { title: string; detail: string } {
  if (feed.leagues.length === 0) {
    return {
      title: "Connect a league to see player exposure",
      detail:
        "Once your team’s roster is synced, you can see which players you hold across leagues.",
    };
  }
  if (feed.season === null) {
    return {
      title: "No active season available",
      detail: "Connect or sync an active league to build your player exposure view.",
    };
  }
  const included = feed.leagues.some((league) => league.status === "included");
  const unclaimed = feed.leagues.some((league) => league.status === "team-unclaimed");
  const missing = feed.leagues.some((league) => league.status === "roster-missing");
  if (!included && unclaimed) {
    return {
      title: "Select your team to see player exposure",
      detail: missing
        ? "Some leagues need a team selection in Settings, and others need a roster sync. Check league coverage for details."
        : "Choose your team in Settings for each league so we can count the players on your rosters.",
    };
  }
  if (!included && missing) {
    return {
      title: "Your rosters haven’t synced yet",
      detail: "Sync your leagues from Connections, then refresh here to see your players.",
    };
  }
  if (!included) {
    return {
      title: "No roster coverage yet",
      detail:
        "The latest season needs a selected team and a synced roster. Check league coverage for details.",
    };
  }
  return {
    title: "Your saved rosters are empty",
    detail:
      "Players will appear here once they are added to your teams and your leagues sync again.",
  };
}

export function PlayerExposurePanel({ refreshToken }: PlayerExposurePanelProps) {
  const [feed, setFeed] = useState<PlayerExposureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresSignIn, setRequiresSignIn] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const request = useRef<AbortController | null>(null);
  const headingId = useId();
  const searchId = useId();
  const tableId = useId();
  const metricId = useId();

  const load = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setError(null);
    setRequiresSignIn(false);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/portfolio/player-exposure`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: abort.signal,
      });
      if (abort.signal.aborted || request.current !== abort) return;
      if (response.status === 401) {
        setFeed(null);
        setRequiresSignIn(true);
        throw new Error("Sign in again to see your player exposure.");
      }
      if (!response.ok) throw new Error("Player exposure could not be loaded. Please try again.");
      const parsed = playerExposureResponseSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new Error("The player exposure response could not be read. Please try again.");
      if (abort.signal.aborted || request.current !== abort) return;
      setFeed(parsed.data);
    } catch (cause) {
      if (!abort.signal.aborted && request.current === abort) {
        setError(cause instanceof Error ? cause.message : "Player exposure could not be loaded.");
      }
    } finally {
      if (!abort.signal.aborted && request.current === abort) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load, refreshToken]);

  const included = feed?.leagues.filter((league) => league.status === "included") ?? [];
  const excludedCount = (feed?.leagues.length ?? 0) - included.length;
  const olderCount = included.filter((league) => league.freshness?.state !== "fresh").length;
  const leaguesById = new Map(feed?.leagues.map((league) => [league.id, league]) ?? []);
  const search = query.trim().toLocaleLowerCase();
  const filtered =
    feed?.players.filter((player) => player.name.toLocaleLowerCase().includes(search)) ?? [];
  const visible = showAll ? filtered : filtered.slice(0, previewLimit);
  const empty = feed ? emptyMessage(feed) : null;

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Across your portfolio</p>
          <h2 id={headingId}>Player exposure</h2>
          <p className={styles.subtitle}>
            Your players across all account teams
            {feed?.season ? ` in ${feed.season}` : " in the latest season"}, regardless of the
            league selected above.
          </p>
        </div>
        <button
          className="button button--outline button--small"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh player exposure"
        >
          <RefreshCw className={loading ? "spin" : undefined} size={14} aria-hidden="true" />{" "}
          Refresh
        </button>
      </header>

      <span className="sr-only" role="status" aria-live="polite">
        {loading
          ? "Loading player exposure."
          : feed
            ? `${feed.players.length} players across ${included.length} included leagues.`
            : ""}
      </span>

      {error ? (
        <div className={styles.error} role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <p>{error}</p>
          {requiresSignIn ? (
            <Link href="/login">Sign in</Link>
          ) : (
            <button
              className="button button--outline button--small"
              type="button"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          )}
        </div>
      ) : null}

      {loading && !feed ? (
        <div className={styles.empty} aria-hidden="true">
          <LoaderCircle className="spin" size={24} />
          <p>Loading your saved rosters…</p>
        </div>
      ) : null}

      {feed ? (
        <>
          {feed.leagues.length > 0 ? (
            <details className={styles.coverage}>
              <summary>
                <Info size={15} aria-hidden="true" /> League coverage: {included.length} of{" "}
                {feed.leagues.length} included
                {excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}
                {olderCount > 0 ? ` · ${olderCount} with older or undated rosters` : ""}
              </summary>
              <div className={styles.coverageBody}>
                <p>
                  We count each selected team once using its latest saved roster for{" "}
                  {feed.season ?? "the latest season"}. Archived leagues, other seasons, unselected
                  teams, and missing rosters are excluded. Saved empty rosters are included. League
                  snapshots may be from different weeks.
                </p>
                <ul className={styles.coverageList}>
                  {feed.leagues.map((league) => (
                    <li key={league.id}>
                      <div>
                        <a href={`/app?league=${encodeURIComponent(league.id)}`}>{league.name}</a>
                        <span>
                          {league.provider === "manual" ? "Manual" : providerLabel(league.provider)}
                          {league.teamName ? ` · ${league.teamName}` : ""}
                        </span>
                      </div>
                      <div>
                        <strong>{coverageLabel(league)}</strong>
                        {league.status === "included" ? (
                          <span>
                            {league.rosterUpdatedAt
                              ? `Roster saved ${compactDate(league.rosterUpdatedAt)}`
                              : "Roster timestamp unavailable"}
                            {league.freshness ? ` · ${league.freshness.label}` : ""}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className={styles.coverageActions}>
                  <Link href="/settings#teams">Select your teams</Link>
                  <Link href="/connections">Manage league syncs</Link>
                </div>
              </div>
            </details>
          ) : null}

          {feed.players.length > 0 ? (
            <>
              <div className={styles.toolbar}>
                <p id={metricId}>
                  <strong>
                    {feed.players.length} players · {included.length}{" "}
                    {included.length === 1 ? "league" : "leagues"}
                  </strong>
                  Most held players first. Roster exposure is the share of included team rosters
                  holding a player. Starting counts come from saved provider lineups.
                </p>
                <div className={styles.search}>
                  <label htmlFor={searchId}>Find a player</label>
                  <div>
                    <Search size={15} aria-hidden="true" />
                    <input
                      id={searchId}
                      type="search"
                      value={query}
                      placeholder="Player name"
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setShowAll(false);
                      }}
                    />
                  </div>
                </div>
              </div>

              {filtered.length > 0 ? (
                <table
                  className={styles.table}
                  id={tableId}
                  role="table"
                  aria-label="Player exposure across your teams"
                  aria-describedby={metricId}
                >
                  <thead role="rowgroup">
                    <tr role="row">
                      <th scope="col" role="columnheader">
                        Player
                      </th>
                      <th scope="col" role="columnheader">
                        Roster exposure
                      </th>
                      <th scope="col" role="columnheader">
                        Starting
                      </th>
                      <th scope="col" role="columnheader">
                        Your leagues
                      </th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {visible.map((player) => (
                      <tr key={player.id} role="row">
                        <th scope="row" role="rowheader">
                          <span className={styles.player}>
                            <span className={styles.avatar} aria-hidden="true">
                              {player.name
                                .split(/\s+/)
                                .map((part) => part[0])
                                .slice(0, 2)
                                .join("")}
                            </span>
                            <span>
                              <strong>{player.name}</strong>
                              <small>
                                {player.position || "Position unavailable"} ·{" "}
                                {player.nflTeam ?? "NFL team unavailable"}
                              </small>
                            </span>
                          </span>
                        </th>
                        <td role="cell">
                          <span className={styles.mobileLabel} aria-hidden="true">
                            Roster exposure
                          </span>
                          <div className={styles.exposure}>
                            <strong>{player.rosterPercentage}%</strong>
                            <span>
                              {player.leagueIds.length} of {included.length}{" "}
                              {included.length === 1 ? "league" : "leagues"}
                            </span>
                            <div className={styles.bar} aria-hidden="true">
                              <span style={{ width: `${player.rosterPercentage}%` }} />
                            </div>
                          </div>
                        </td>
                        <td role="cell">
                          <span className={styles.mobileLabel} aria-hidden="true">
                            Starting
                          </span>
                          <span className={styles.starters}>
                            {player.starterLeagueIds.length}{" "}
                            {player.starterLeagueIds.length === 1 ? "league" : "leagues"}
                          </span>
                        </td>
                        <td role="cell" className={styles.leaguesCell}>
                          <span className={styles.mobileLabel} aria-hidden="true">
                            Your leagues
                          </span>
                          <ul className={styles.leagueLinks}>
                            {player.leagueIds.map((id) => {
                              const league = leaguesById.get(id);
                              if (!league) return null;
                              return (
                                <li key={id}>
                                  <a href={`/app?league=${encodeURIComponent(id)}`}>
                                    {league.name}
                                    {player.starterLeagueIds.includes(id) ? (
                                      <span>Starting</span>
                                    ) : null}
                                  </a>
                                </li>
                              );
                            })}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className={styles.empty} role="status">
                  <p>No players match “{query.trim()}”.</p>
                  <button
                    className="button button--outline button--small"
                    type="button"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </button>
                </div>
              )}

              <div className={styles.listFooter}>
                <p role="status">
                  Showing {visible.length} of {filtered.length} {search ? "matching " : ""}players
                </p>
                {filtered.length > previewLimit ? (
                  <button
                    className="button button--outline button--small"
                    type="button"
                    aria-expanded={showAll}
                    aria-controls={tableId}
                    onClick={() => setShowAll((current) => !current)}
                  >
                    {showAll ? "Show fewer" : `Show all ${filtered.length}`}
                  </button>
                ) : null}
              </div>
            </>
          ) : empty ? (
            <div className={styles.empty}>
              <UsersRound size={26} aria-hidden="true" />
              <strong>{empty.title}</strong>
              <p>{empty.detail}</p>
              {feed.leagues.some((league) => league.status === "team-unclaimed") ? (
                <Link className="button button--dark button--small" href="/settings#teams">
                  Select your teams
                </Link>
              ) : (
                <Link className="button button--outline button--small" href="/connections">
                  {feed.leagues.length === 0 ? "Connect a league" : "Manage league syncs"}
                </Link>
              )}
            </div>
          ) : null}
          <footer className={styles.footer}>
            <span>Latest saved rosters · refresh after a league sync to pick up changes.</span>
            <span>Checked {compactDate(feed.generatedAt)}</span>
          </footer>
        </>
      ) : null}
    </section>
  );
}
