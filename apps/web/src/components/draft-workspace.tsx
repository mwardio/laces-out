"use client";

import {
  AlertCircle,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  BarChart3,
  Bookmark,
  Check,
  ChevronDown,
  CircleGauge,
  Clock3,
  Coins,
  Gavel,
  Info,
  Minus,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  draftPlayers,
  draftTeams,
  initialDraftEvents,
  revealsRayFinkle,
  type DraftEvent,
  type DraftFormat,
  type DraftPlayer,
  type DraftTeam,
  type Position,
} from "../lib/demo-data";

interface LocalDraftEvent {
  event: DraftEvent;
  teamId: string;
  amount: number;
}

const positions: readonly Position[] = ["ALL", "QB", "RB", "WR", "TE"];

function Signal({ player, mode }: { player: DraftPlayer; mode: DraftFormat }) {
  if (mode === "Auction") {
    const difference = player.fairValue - player.aav;
    return difference > 2 ? (
      <span className="board-signal board-signal--value">
        <TrendingUp size={12} /> +${difference}
      </span>
    ) : difference < 0 ? (
      <span className="board-signal board-signal--risk">
        <TrendingDown size={12} /> ${difference}
      </span>
    ) : (
      <span className="board-signal">At market</span>
    );
  }
  return player.availability > 25 ? (
    <span className="board-signal board-signal--value">Likely next</span>
  ) : player.availability < 8 ? (
    <span className="board-signal board-signal--risk">Take now</span>
  ) : (
    <span className="board-signal">In range</span>
  );
}

export function DraftWorkspace() {
  const [mode, setMode] = useState<DraftFormat>("Auction");
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<Position>("ALL");
  const [selectedId, setSelectedId] = useState(draftPlayers[5]?.id ?? "p01");
  const [queuedIds, setQueuedIds] = useState<ReadonlySet<string>>(new Set(["p09", "p11"]));
  const [localEvents, setLocalEvents] = useState<readonly LocalDraftEvent[]>([]);
  const [teams, setTeams] = useState<readonly DraftTeam[]>(draftTeams);
  const [winnerId, setWinnerId] = useState("you");
  const [bid, setBid] = useState("49");
  const [snakePick, setSnakePick] = useState(17);
  const [notice, setNotice] = useState(
    "Local sandbox ready. Nothing here is connected to a league or a provider.",
  );
  const [isPaused, setIsPaused] = useState(false);

  const draftedIds = useMemo(
    () => new Set(localEvents.map((item) => item.event.playerId)),
    [localEvents],
  );
  const selectedPlayer =
    draftPlayers.find((player) => player.id === selectedId) ?? draftPlayers[0]!;
  const userTeam = teams.find((team) => team.id === "you") ?? teams[0]!;
  const winner = teams.find((team) => team.id === winnerId) ?? userTeam;

  const filteredPlayers = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return draftPlayers.filter((player) => {
      if (draftedIds.has(player.id)) return false;
      if (position !== "ALL" && player.position !== position) return false;
      if (player.hidden) return revealsRayFinkle(search);
      return (
        !normalized ||
        `${player.name} ${player.team} ${player.position}`.toLowerCase().includes(normalized)
      );
    });
  }, [draftedIds, position, search]);

  const queuedPlayers = draftPlayers.filter(
    (player) => queuedIds.has(player.id) && !draftedIds.has(player.id),
  );
  const bidNumber = Number.parseInt(bid, 10);
  const auctionAmountIsValid =
    Number.isFinite(bidNumber) && bidNumber >= 1 && bidNumber <= winner.maxBid;

  function toggleQueue(id: string) {
    setQueuedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectMode(nextMode: DraftFormat) {
    setMode(nextMode);
    setNotice(`${nextMode} sandbox active. Entries remain in this browser preview.`);
  }

  function recordEvent() {
    if (draftedIds.has(selectedPlayer.id)) {
      setNotice("That player is already recorded in this sandbox.");
      return;
    }

    const amount = mode === "Auction" ? bidNumber : 0;
    if (mode === "Auction" && !auctionAmountIsValid) {
      setNotice(`Enter a legal bid from $1 to $${winner.maxBid}.`);
      return;
    }

    const event: DraftEvent = {
      id: `local-${localEvents.length + 1}`,
      playerId: selectedPlayer.id,
      player: selectedPlayer.name,
      team: winner.name,
      detail: mode === "Auction" ? `$${amount}` : `Pick ${snakePick}`,
      kind: mode,
    };

    setLocalEvents((current) => [...current, { event, teamId: winner.id, amount }]);
    setQueuedIds((current) => {
      const next = new Set(current);
      next.delete(selectedPlayer.id);
      return next;
    });

    if (mode === "Auction") {
      setTeams((current) =>
        current.map((team) =>
          team.id === winner.id
            ? {
                ...team,
                budget: team.budget - amount,
                maxBid: Math.max(1, team.maxBid - amount),
                rostered: team.rostered + 1,
              }
            : team,
        ),
      );
      setNotice(
        selectedPlayer.hidden
          ? `Einhorn is Finkle! Finkle is Einhorn! (Sold to ${winner.abbreviation} for $${amount}.)`
          : `${selectedPlayer.name} recorded to ${winner.abbreviation} for $${amount}. Demo state only.`,
      );
    } else {
      setSnakePick((current) => current + 1);
      setNotice(
        selectedPlayer.hidden
          ? `Einhorn is Finkle! Finkle is Einhorn! (Pick ${snakePick}.)`
          : `${selectedPlayer.name} recorded at pick ${snakePick}. Demo state only.`,
      );
    }

    const nextPlayer = filteredPlayers.find((player) => player.id !== selectedPlayer.id);
    if (nextPlayer) setSelectedId(nextPlayer.id);
  }

  function undoLast() {
    const last = localEvents.at(-1);
    if (!last) {
      setNotice("No local entries to undo.");
      return;
    }
    setLocalEvents((current) => current.slice(0, -1));
    setSelectedId(last.event.playerId);
    if (last.event.kind === "Auction") {
      setTeams((current) =>
        current.map((team) =>
          team.id === last.teamId
            ? {
                ...team,
                budget: team.budget + last.amount,
                maxBid: team.maxBid + last.amount,
                rostered: Math.max(0, team.rostered - 1),
              }
            : team,
        ),
      );
    } else {
      setSnakePick((current) => Math.max(1, current - 1));
    }
    setNotice(`Undid ${last.event.player}.`);
  }

  return (
    <div className="draft-page">
      <header className="draft-header">
        <div className="draft-title-group">
          <Link className="back-link" href="/app">
            <ArrowLeft size={16} /> Portfolio
          </Link>
          <div className="draft-title-line">
            <div>
              <p className="eyebrow">North Loop Auction · sample league</p>
              <h1>Draft studio</h1>
            </div>
            <div className="mode-switch" role="group" aria-label="Draft format">
              <button
                type="button"
                className={mode === "Auction" ? "is-active" : ""}
                aria-pressed={mode === "Auction"}
                onClick={() => selectMode("Auction")}
              >
                <Gavel size={15} /> Auction
              </button>
              <button
                type="button"
                className={mode === "Snake" ? "is-active" : ""}
                aria-pressed={mode === "Snake"}
                onClick={() => selectMode("Snake")}
              >
                <ArrowDownUp size={15} /> Snake
              </button>
            </div>
          </div>
        </div>
        <div className="draft-header-actions">
          <div className="connection-indicator">
            <span className="connection-indicator__dot" />
            <span>
              <strong>Manual demo</strong>
              <small>No provider feed</small>
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={undoLast}
            aria-label="Undo last local entry"
            title="Undo last local entry"
          >
            <RotateCcw size={17} />
          </button>
          <button
            className={`button button--small ${isPaused ? "button--soft" : "button--dark"}`}
            type="button"
            onClick={() => setIsPaused((current) => !current)}
          >
            {isPaused ? (
              <>
                <Play size={14} /> Resume
              </>
            ) : (
              <>
                <Pause size={14} /> Pause board
              </>
            )}
          </button>
        </div>
      </header>

      <section
        className={`draft-notice${isPaused ? " draft-notice--paused" : ""}`}
        aria-live="polite"
      >
        <span>
          <Radio size={14} /> {notice}
        </span>
        <span className="draft-notice__meta">
          <ShieldCheck size={14} /> Read-only · local interaction
        </span>
      </section>

      <section className="room-strip" aria-label="Draft room state">
        {mode === "Auction" ? (
          <>
            <article>
              <span className="room-stat-icon room-stat-icon--lime">
                <Coins size={18} />
              </span>
              <div>
                <span>Your budget</span>
                <strong>${userTeam.budget}</strong>
                <small>${userTeam.maxBid} max bid</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <Target size={18} />
              </span>
              <div>
                <span>Roster</span>
                <strong>
                  {userTeam.rostered} / {userTeam.slots}
                </strong>
                <small>{userTeam.slots - userTeam.rostered} open slots</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <CircleGauge size={18} />
              </span>
              <div>
                <span>Room inflation</span>
                <strong>+4.8%</strong>
                <small>Illustrative</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <BadgeDollarSign size={18} />
              </span>
              <div>
                <span>Remaining / slot</span>
                <strong>
                  ${Math.round(userTeam.budget / (userTeam.slots - userTeam.rostered))}
                </strong>
                <small>Keep $1 per slot</small>
              </div>
            </article>
          </>
        ) : (
          <>
            <article>
              <span className="room-stat-icon room-stat-icon--lime">
                <Clock3 size={18} />
              </span>
              <div>
                <span>On the clock</span>
                <strong>Pick {snakePick}</strong>
                <small>Round {Math.ceil(snakePick / 10)} · Seat 4</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <Target size={18} />
              </span>
              <div>
                <span>Your next pick</span>
                <strong>2.04</strong>
                <small>3 picks away</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <Users size={18} />
              </span>
              <div>
                <span>Roster start</span>
                <strong>RB · WR</strong>
                <small>Best value next</small>
              </div>
            </article>
            <article>
              <span className="room-stat-icon">
                <BarChart3 size={18} />
              </span>
              <div>
                <span>Roster grade</span>
                <strong>A−</strong>
                <small>Sample model</small>
              </div>
            </article>
          </>
        )}
      </section>

      <section
        className="opponent-budget-strip"
        aria-label={mode === "Auction" ? "Team budgets" : "Draft order"}
      >
        <div className="opponent-budget-strip__label">
          <span>{mode === "Auction" ? "Room budgets" : "Pick order"}</span>
          <small>{mode === "Auction" ? "budget · max bid" : "next six seats"}</small>
        </div>
        <div className="opponent-team-scroll">
          {teams.map((team, index) => (
            <button
              type="button"
              className={`${team.id === winnerId ? "is-selected" : ""}${team.isUser ? " is-user" : ""}`}
              onClick={() => setWinnerId(team.id)}
              key={team.id}
              aria-pressed={team.id === winnerId}
            >
              <span>{team.abbreviation}</span>
              {mode === "Auction" ? (
                <strong>
                  ${team.budget} <small>· ${team.maxBid}</small>
                </strong>
              ) : (
                <strong>{index + snakePick}</strong>
              )}
            </button>
          ))}
        </div>
      </section>

      <div className="draft-workspace-grid">
        <section className="board-panel" aria-labelledby="player-board-title">
          <div className="board-panel__header">
            <div>
              <p className="eyebrow">Live player board</p>
              <h2 id="player-board-title">Available players</h2>
            </div>
            <div className="board-header-meta">
              <span>{filteredPlayers.length} shown</span>
              <span className="freshness-dot freshness-dot--demo" /> Demo projections
            </div>
          </div>

          <div className="board-toolbar">
            <label className="search-field">
              <Search size={16} />
              <span className="sr-only">Search players</span>
              <input
                type="search"
                placeholder="Search player or team"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="position-tabs" role="group" aria-label="Filter by position">
              {positions.map((item) => (
                <button
                  type="button"
                  className={position === item ? "is-active" : ""}
                  aria-pressed={position === item}
                  onClick={() => setPosition(item)}
                  key={item}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div
            className="player-table-wrap"
            role="region"
            aria-label="Available player board; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table className="player-table">
              <thead>
                <tr>
                  <th scope="col">RK</th>
                  <th scope="col">Player</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Proj.</th>
                  {mode === "Auction" ? (
                    <>
                      <th scope="col">AAV</th>
                      <th scope="col">My $</th>
                    </>
                  ) : (
                    <>
                      <th scope="col">ADP</th>
                      <th scope="col">Next pick</th>
                    </>
                  )}
                  <th scope="col">Signal</th>
                  <th scope="col">
                    <span className="sr-only">Queue</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredPlayers.map((player) => {
                  const selected = player.id === selectedPlayer.id;
                  const queued = queuedIds.has(player.id);
                  return (
                    <tr
                      className={`${selected ? "is-selected" : ""}${queued ? " is-queued" : ""}`}
                      aria-selected={selected}
                      key={player.id}
                    >
                      <td>
                        <span className="rank-cell">{player.rank}</span>
                      </td>
                      <th scope="row">
                        <button
                          className="player-name-button"
                          type="button"
                          onClick={() => setSelectedId(player.id)}
                        >
                          <span
                            className={`position-avatar position-avatar--${player.position.toLowerCase()}`}
                          >
                            {player.position}
                          </span>
                          <span>
                            <strong>{player.name}</strong>
                            <small>
                              {player.position} · {player.team} · Bye {player.bye}
                            </small>
                          </span>
                        </button>
                      </th>
                      <td>
                        <span className="tier-pill">T{player.tier}</span>
                      </td>
                      <td>
                        <strong>{player.projected.toFixed(1)}</strong>
                      </td>
                      {mode === "Auction" ? (
                        <>
                          <td>${player.aav}</td>
                          <td>
                            <strong>${player.fairValue}</strong>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{player.adp.toFixed(1)}</td>
                          <td>
                            <strong>{player.availability}%</strong>
                          </td>
                        </>
                      )}
                      <td>
                        <Signal player={player} mode={mode} />
                      </td>
                      <td>
                        <button
                          className={`queue-button${queued ? " is-active" : ""}`}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleQueue(player.id);
                          }}
                          aria-label={`${queued ? "Remove" : "Add"} ${player.name} ${queued ? "from" : "to"} queue`}
                        >
                          <Bookmark size={15} fill={queued ? "currentColor" : "none"} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredPlayers.length === 0 ? (
              <div className="board-empty">
                <Search size={20} />
                <strong>No players match</strong>
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setPosition("ALL");
                  }}
                >
                  Reset filters
                </button>
              </div>
            ) : null}
          </div>
          <div className="board-footer">
            <span>Rankings model: Demo baseline v0</span>
          </div>
        </section>

        <aside className="draft-rail" aria-label="Draft recommendation">
          <section className="recommendation-card">
            <div className="recommendation-card__head">
              <span>
                <CircleGauge size={16} /> Recommendation
              </span>
              <span className="status-chip status-chip--demo">Demo</span>
            </div>
            <div className="recommendation-player">
              <span
                className={`position-avatar position-avatar--large position-avatar--${selectedPlayer.position.toLowerCase()}`}
              >
                {selectedPlayer.position}
              </span>
              <div>
                <p>{mode === "Auction" ? "Current nomination" : "Best pick now"}</p>
                <h2>{selectedPlayer.name}</h2>
                <span>
                  {selectedPlayer.team} · Tier {selectedPlayer.tier} · Bye {selectedPlayer.bye}
                </span>
              </div>
              {queuedIds.has(selectedPlayer.id) ? (
                <span className="queued-badge">
                  <Bookmark size={12} fill="currentColor" /> Queued
                </span>
              ) : null}
            </div>

            {mode === "Auction" ? (
              <>
                <div className="price-ladder">
                  <div>
                    <span>Market</span>
                    <strong>${selectedPlayer.aav}</strong>
                  </div>
                  <div className="is-primary">
                    <span>Fair price</span>
                    <strong>${selectedPlayer.fairValue}</strong>
                  </div>
                  <div>
                    <span>Hard stop</span>
                    <strong>${selectedPlayer.fairValue + 4}</strong>
                  </div>
                </div>
                <div className="value-meter">
                  <div className="value-meter__track">
                    <span
                      style={{
                        left: `${Math.min(92, (bidNumber / (selectedPlayer.fairValue + 8)) * 100)}%`,
                      }}
                    />
                    <i
                      style={{
                        left: `${(selectedPlayer.fairValue / (selectedPlayer.fairValue + 8)) * 100}%`,
                      }}
                    />
                  </div>
                  <span>$1</span>
                  <strong>Fair ${selectedPlayer.fairValue}</strong>
                  <span>${selectedPlayer.fairValue + 8}+</span>
                </div>
                <div className="assistant-callout">
                  <Info size={16} />
                  <p>
                    <strong>
                      {selectedPlayer.signal === "value" ? "Room to press." : "Stay disciplined."}
                    </strong>{" "}
                    {selectedPlayer.note}
                  </p>
                </div>
                <div className="auction-entry">
                  <label>
                    <span>Winning team</span>
                    <select value={winnerId} onChange={(event) => setWinnerId(event.target.value)}>
                      {teams.map((team) => (
                        <option value={team.id} key={team.id}>
                          {team.abbreviation} · ${team.budget}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </label>
                  <label>
                    <span>Sale price</span>
                    <div className="money-input">
                      <span>$</span>
                      <input
                        inputMode="numeric"
                        value={bid}
                        onChange={(event) => setBid(event.target.value.replace(/[^0-9]/g, ""))}
                        aria-invalid={!auctionAmountIsValid}
                      />
                    </div>
                  </label>
                </div>
                {!auctionAmountIsValid ? (
                  <p className="field-error">
                    <AlertCircle size={13} /> Legal max for {winner.abbreviation} is $
                    {winner.maxBid}.
                  </p>
                ) : null}
                <button
                  className="button button--lime button--full button--record"
                  type="button"
                  onClick={recordEvent}
                  disabled={isPaused}
                >
                  <Gavel size={16} /> Record sale at ${Number.isFinite(bidNumber) ? bidNumber : 0}
                </button>
              </>
            ) : (
              <>
                <div className="snake-probability">
                  <div
                    className="probability-ring"
                    style={
                      {
                        "--probability": `${selectedPlayer.availability * 3.6}deg`,
                      } as React.CSSProperties
                    }
                  >
                    <span>
                      <strong>{selectedPlayer.availability}%</strong>
                      <small>next pick</small>
                    </span>
                  </div>
                  <div>
                    <strong>{selectedPlayer.availability < 15 ? "Take now" : "Could wait"}</strong>
                    <p>
                      Illustrative chance available at your next selection, based on sample ADP
                      only.
                    </p>
                  </div>
                </div>
                <div className="snake-comparison">
                  <div>
                    <span>Roster value now</span>
                    <strong>+{(selectedPlayer.projected / 52).toFixed(1)}</strong>
                  </div>
                  <div>
                    <span>ADP</span>
                    <strong>{selectedPlayer.adp.toFixed(1)}</strong>
                  </div>
                  <div>
                    <span>Pick</span>
                    <strong>{snakePick}</strong>
                  </div>
                </div>
                <div className="assistant-callout">
                  <Info size={16} />
                  <p>
                    <strong>Build fit:</strong> {selectedPlayer.note}
                  </p>
                </div>
                <label className="snake-team-select">
                  <span>Drafting team</span>
                  <select value={winnerId} onChange={(event) => setWinnerId(event.target.value)}>
                    {teams.map((team) => (
                      <option value={team.id} key={team.id}>
                        {team.abbreviation} · {team.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
                <button
                  className="button button--lime button--full button--record"
                  type="button"
                  onClick={recordEvent}
                  disabled={isPaused}
                >
                  <Check size={16} /> Record pick {snakePick}
                </button>
              </>
            )}
            <button
              className={`text-action${queuedIds.has(selectedPlayer.id) ? " is-active" : ""}`}
              type="button"
              onClick={() => toggleQueue(selectedPlayer.id)}
            >
              {queuedIds.has(selectedPlayer.id) ? (
                <>
                  <Minus size={14} /> Remove from queue
                </>
              ) : (
                <>
                  <Plus size={14} /> Add to queue
                </>
              )}
            </button>
          </section>

          <section className="queue-card">
            <div className="queue-card__head">
              <div>
                <p className="eyebrow">My queue</p>
                <h3>{queuedPlayers.length} saved targets</h3>
              </div>
              <Bookmark size={17} />
            </div>
            <div className="queue-list">
              {queuedPlayers.length ? (
                queuedPlayers.map((player, index) => (
                  <button type="button" onClick={() => setSelectedId(player.id)} key={player.id}>
                    <span className="queue-order">{index + 1}</span>
                    <span>
                      <strong>{player.name}</strong>
                      <small>
                        {player.position} ·{" "}
                        {mode === "Auction"
                          ? `$${player.fairValue} fair`
                          : `${player.availability}% next pick`}
                      </small>
                    </span>
                    <X
                      size={14}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleQueue(player.id);
                      }}
                    />
                  </button>
                ))
              ) : (
                <p className="queue-empty">Queue is empty.</p>
              )}
            </div>
          </section>
        </aside>
      </div>

      <section className="draft-log" aria-labelledby="draft-log-title">
        <div className="draft-log__heading">
          <div>
            <p className="eyebrow">Event ledger</p>
            <h2 id="draft-log-title">Recent entries</h2>
          </div>
          <button className="text-action" type="button" onClick={undoLast}>
            <RotateCcw size={14} /> Undo local entry
          </button>
        </div>
        <div className="draft-log__events">
          {[...localEvents].reverse().map(({ event }) => (
            <article className="draft-event draft-event--local" key={event.id}>
              <span className="draft-event__pick">NEW</span>
              <div>
                <strong>{event.player}</strong>
                <span>{event.team}</span>
              </div>
              <strong>{event.detail}</strong>
              <small>Local · {event.kind}</small>
            </article>
          ))}
          {mode === "Auction" ? (
            initialDraftEvents.map((event, index) => (
              <article className="draft-event" key={event.id}>
                <span className="draft-event__pick">{index + 1}</span>
                <div>
                  <strong>{event.player}</strong>
                  <span>{event.team}</span>
                </div>
                <strong>{event.detail}</strong>
                <small>Fixture</small>
              </article>
            ))
          ) : (
            <>
              <article className="draft-event">
                <span className="draft-event__pick">1.01</span>
                <div>
                  <strong>Amon-Ra St. Brown</strong>
                  <span>Sunday Scaries</span>
                </div>
                <strong>WR</strong>
                <small>Fixture</small>
              </article>
              <article className="draft-event">
                <span className="draft-event__pick">1.02</span>
                <div>
                  <strong>Saquon Barkley</strong>
                  <span>Gridiron Dept.</span>
                </div>
                <strong>RB</strong>
                <small>Fixture</small>
              </article>
              <article className="draft-event">
                <span className="draft-event__pick">1.03</span>
                <div>
                  <strong>Nico Collins</strong>
                  <span>Two Minute Drill</span>
                </div>
                <strong>WR</strong>
                <small>Fixture</small>
              </article>
            </>
          )}
        </div>
        <p className="draft-log__note">
          <Info size={13} /> This sandbox is not connected to a league or a provider feed. Every
          entry stays in this browser preview and can be undone.
        </p>
      </section>

      <div className="draft-mobile-action">
        <div>
          <span>
            {selectedPlayer.position} · {selectedPlayer.team}
          </span>
          <strong>{selectedPlayer.name}</strong>
        </div>
        <button
          className="button button--lime"
          type="button"
          onClick={recordEvent}
          disabled={isPaused}
        >
          {mode === "Auction"
            ? `Record $${Number.isFinite(bidNumber) ? bidNumber : 0}`
            : `Pick ${snakePick}`}{" "}
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}
