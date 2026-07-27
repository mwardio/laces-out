"use client";

import type { ScheduleResponse } from "@fantasy/contracts";
import {
  CalendarDays,
  CalendarOff,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseScheduleResponse } from "../lib/api-client";
import { NFL_TEAM_CHOICES } from "../lib/nfl-teams";
import styles from "./schedule-board.module.css";
import { dateOnly, dateTime, number, timeOnly, weekCoverage } from "./stats-formatting";

interface FilterState {
  readonly season: number;
  readonly week: number | null;
  readonly team: string;
}

type ViewState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: ScheduleResponse };

function defaultSeason(): number {
  const now = new Date();
  return now.getMonth() < 4 ? now.getFullYear() - 1 : now.getFullYear();
}

/** Groups the flat game list into the week buckets the board renders. */
function gamesByWeek(data: ScheduleResponse): readonly {
  readonly week: number;
  readonly games: ScheduleResponse["games"];
}[] {
  const buckets = new Map<number, ScheduleResponse["games"][number][]>();
  for (const game of data.games) {
    const existing = buckets.get(game.week);
    if (existing) existing.push(game);
    else buckets.set(game.week, [game]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([week, games]) => ({ week, games }));
}

function kickoff(game: ScheduleResponse["games"][number]): string {
  if (game.timeTbd) return "Time TBD";
  if (!game.kickoffAt) return dateOnly(null);
  return `${dateOnly(game.kickoffAt)} · ${timeOnly(game.kickoffAt)}`;
}

function score(game: ScheduleResponse["games"][number]): string {
  if (game.awayScore === null || game.homeScore === null) return "—";
  return `${game.awayScore}–${game.homeScore}`;
}

export function ScheduleBoard({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const [filters, setFilters] = useState<FilterState>({
    season: defaultSeason(),
    week: null,
    team: "",
  });
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async (next: FilterState) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setView({ state: "loading" });
    const query = new URLSearchParams({ season: String(next.season) });
    if (next.week !== null) query.set("week", String(next.week));
    if (next.team) query.set("team", next.team);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/schedule?${query.toString()}`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("The schedule could not be loaded.");
      const parsed = parseScheduleResponse(await response.json());
      if (!parsed) throw new Error("The schedule response failed its data contract.");
      if (!controller.signal.aborted) setView({ state: "ready", data: parsed });
    } catch (error) {
      if (!controller.signal.aborted) {
        setView({
          state: "error",
          message: error instanceof Error ? error.message : "The schedule could not be loaded.",
        });
      }
    }
  }, []);

  useEffect(() => {
    void load({ season: defaultSeason(), week: null, team: "" });
    return () => requestRef.current?.abort();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(filters);
  }

  const seasons = Array.from({ length: 6 }, (_, index) => new Date().getFullYear() - index);

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      {!embedded ? (
        <header className={styles.hero}>
          <div>
            <p>Official NFL reference</p>
            <h1>Schedule</h1>
            <span>Browse every matchup, kickoff, result, and affirmed bye.</span>
          </div>
          <CalendarDays size={34} strokeWidth={1.5} aria-hidden="true" />
        </header>
      ) : null}

      <form className={styles.filters} onSubmit={submit}>
        <label>
          <span>Season</span>
          <select
            value={filters.season}
            onChange={(event) =>
              setFilters((current) => ({ ...current, season: Number(event.target.value) }))
            }
          >
            {seasons.map((season) => (
              <option value={season} key={season}>
                {season}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Week</span>
          <select
            value={filters.week ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                week: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">All weeks</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Team</span>
          <select
            value={filters.team}
            onChange={(event) =>
              setFilters((current) => ({ ...current, team: event.target.value }))
            }
          >
            <option value="">All teams</option>
            {NFL_TEAM_CHOICES.map((team) => (
              <option value={team} key={team}>
                {team}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={view.state === "loading"}>
          <RefreshCw
            className={view.state === "loading" ? styles.spin : undefined}
            size={15}
            aria-hidden="true"
          />
          Apply
        </button>
      </form>

      {view.state === "loading" ? (
        <div className={styles.stateCard} role="status">
          <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
          <div>
            <strong>Reading the admitted schedule</strong>
            <span>Resolving matchups and affirmed bye weeks.</span>
          </div>
        </div>
      ) : view.state === "error" ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>The schedule is unavailable</strong>
            <span>{view.message}</span>
          </div>
        </div>
      ) : (
        <ScheduleResult data={view.data} />
      )}
    </div>
  );
}

function ScheduleResult({ data }: { readonly data: ScheduleResponse }) {
  const weeks = gamesByWeek(data);
  const byeTeams = data.teams.filter(
    (team) => team.bye.status === "available" && team.bye.byeWeeks.length > 0,
  );
  const withheldByes = data.teams.filter((team) => team.bye.status === "unavailable");

  return (
    <>
      {data.source.state !== "available" ? (
        <div className={styles.warning} role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <strong>The schedule artifact is withheld</strong>
            <span>{data.source.reason}</span>
          </div>
        </div>
      ) : null}

      {data.filters.team ? (
        <section className={styles.panel} aria-labelledby="team-schedule-title">
          <div className={styles.panelHeading}>
            <div>
              <p>{data.filters.team}</p>
              <h2 id="team-schedule-title">Team schedule</h2>
            </div>
            <span>{weekCoverage(data.source.coveredWeeks)} covered</span>
          </div>
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Team schedule; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col">Opponent</th>
                  <th scope="col">Venue</th>
                  <th scope="col">Kickoff</th>
                  <th scope="col">Rest</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.teams[0]?.weeks.map((week) => (
                  <tr key={week.week} className={week.state === "bye" ? styles.byeRow : undefined}>
                    <th scope="row">{week.week}</th>
                    <td>
                      {week.state === "game" ? (
                        week.opponent
                      ) : week.state === "bye" ? (
                        <span className={styles.byeTag}>Bye</span>
                      ) : (
                        <span className={styles.unknownTag} title={week.reason ?? undefined}>
                          Unknown
                        </span>
                      )}
                    </td>
                    <td>{week.venue ?? "—"}</td>
                    <td>
                      {week.state !== "game"
                        ? "—"
                        : week.timeTbd
                          ? "Time TBD"
                          : week.kickoffAt
                            ? `${dateOnly(week.kickoffAt)} · ${timeOnly(week.kickoffAt)}`
                            : "—"}
                    </td>
                    <td>{number(week.restDays)}</td>
                    <td>
                      {week.teamScore === null || week.opponentScore === null
                        ? "—"
                        : `${week.teamScore}–${week.opponentScore}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.definition}>{data.definitions.bye}</p>
        </section>
      ) : null}

      {weeks.length === 0 ? (
        <div className={styles.stateCard}>
          <CalendarOff size={20} aria-hidden="true" />
          <div>
            <strong>No games match this view</strong>
            <span>Try another season, week, or team.</span>
          </div>
        </div>
      ) : (
        weeks.map(({ week, games }) => (
          <section className={styles.panel} aria-labelledby={`week-${week}-title`} key={week}>
            <div className={styles.panelHeading}>
              <div>
                <p>Regular season</p>
                <h2 id={`week-${week}-title`}>Week {week}</h2>
              </div>
              <span>
                {games.length} game{games.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className={styles.gameList}>
              {games.map((game) => (
                <li key={game.gameId}>
                  <span className={styles.matchup}>
                    <strong>{game.awayTeam}</strong>
                    <em>at</em>
                    <strong>{game.homeTeam}</strong>
                    {game.neutralSite ? <span className={styles.neutralTag}>Neutral</span> : null}
                  </span>
                  <span className={styles.kickoff}>{kickoff(game)}</span>
                  <span className={styles.status}>{game.status}</span>
                  <span className={styles.score}>{score(game)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <section className={styles.panel} aria-labelledby="bye-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Affirmed byes</p>
            <h2 id="bye-title">Bye weeks</h2>
          </div>
          <span>{byeTeams.length} of 32 teams</span>
        </div>
        {byeTeams.length === 0 ? (
          <div className={styles.emptyState}>
            <CalendarOff size={22} aria-hidden="true" />
            <strong>No bye week can be affirmed for this view</strong>
            <span>{data.definitions.bye}</span>
          </div>
        ) : (
          <ul className={styles.byeList}>
            {byeTeams.map((team) => (
              <li key={team.team}>
                <strong>{team.team}</strong>
                <span>Week {team.bye.byeWeeks.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
        {withheldByes.length > 0 ? (
          <p className={styles.definition}>
            {withheldByes.length} team{withheldByes.length === 1 ? "" : "s"} withheld:{" "}
            {withheldByes[0]?.bye.reason}
          </p>
        ) : null}
      </section>

      <section className={styles.panel} aria-labelledby="schedule-source-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Audit trail</p>
            <h2 id="schedule-source-title">Source health</h2>
          </div>
          <span className={`${styles.sourceState} ${styles[`sourceState--${data.source.state}`]}`}>
            {data.source.state}
          </span>
        </div>
        <dl className={styles.sourceGrid}>
          <div>
            <dt>Checked</dt>
            <dd>{dateTime(data.source.fetchedAt)}</dd>
          </div>
          <div>
            <dt>Weeks covered</dt>
            <dd>{weekCoverage(data.source.coveredWeeks)}</dd>
          </div>
          <div>
            <dt>Teams covered</dt>
            <dd>{data.source.coveredTeams.length}</dd>
          </div>
          <div>
            <dt>Rows read</dt>
            <dd>{number(data.source.quality.rowsRead)}</dd>
          </div>
          <div>
            <dt>Rejected</dt>
            <dd>{number(data.source.quality.rowsRejected)}</dd>
          </div>
        </dl>
        {data.source.attribution ? (
          data.source.attributionUrl ? (
            <a
              className={styles.attribution}
              href={data.source.attributionUrl}
              target="_blank"
              rel="noreferrer"
            >
              {data.source.attribution}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : (
            <span className={styles.attribution}>{data.source.attribution}</span>
          )
        ) : null}
      </section>
    </>
  );
}
