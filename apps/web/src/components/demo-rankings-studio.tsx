"use client";

import { Check, FileSpreadsheet, ListPlus, Save, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { draftPlayers } from "../lib/demo-data";
import { TourBanner } from "./tour-banner";

export function DemoRankingsStudio() {
  return (
    <div className="rankings-page rankings-page--tour">
      <TourBanner />

      <section className="page-heading rankings-heading">
        <div>
          <h1>Rankings Studio</h1>
          <p className="page-subtitle">
            Blend rankings, ADP, auction prices, targets, and notes into one versioned cheat sheet.
          </p>
        </div>
        <div className="heading-actions">
          {/* The tour's controls are all inert. Two solid-looking disabled buttons in
              the most prominent slot read as a page that failed to load, and this was
              the only tour surface with no way to sign in from the content. */}
          <Link className="button button--dark" href="/login">
            <ListPlus size={15} /> Sign in to build your board
          </Link>
        </div>
      </section>

      <div className="ranking-studio-grid">
        <aside className="panel ranking-library" aria-label="Sample ranking boards">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Library</p>
              <h2>Your boards</h2>
            </div>
            <span className="count-badge">3</span>
          </div>
          <div className="ranking-list">
            <button className="is-selected" type="button" aria-pressed="true" disabled>
              <span className="ranking-kind-icon">#</span>
              <span>
                <strong>2026 Auction Command Board</strong>
                <small>2026 · Cheat sheet · PPR</small>
              </span>
            </button>
            <button type="button" disabled>
              <span className="ranking-kind-icon">$</span>
              <span>
                <strong>North Loop Values</strong>
                <small>2026 · Auction values · PPR</small>
              </span>
            </button>
            <button type="button" disabled>
              <span className="ranking-kind-icon">A</span>
              <span>
                <strong>Room-adjusted ADP</strong>
                <small>2026 · ADP · PPR</small>
              </span>
            </button>
          </div>
        </aside>

        <div className="ranking-workspace">
          <section className="panel ranking-board-head">
            <div className="ranking-demo-board-head">
              <div className="ranking-board-title">
                <div>
                  <span className="status-chip">private</span>
                  <span className="status-chip">Cheat sheet</span>
                  <span className="status-chip status-chip--demo">Tour</span>
                </div>
                <h2>2026 Auction Command Board</h2>
                <p>Targets, walk-away prices, and room-adjusted value for a $200 budget.</p>
              </div>
              <button className="button button--outline button--small" type="button" disabled>
                <Save size={14} /> Save metadata
              </button>
            </div>
            <div className="ranking-version-strip">
              <span className="ranking-version-state ranking-version-state--draft">draft</span>
              <strong>v7</strong>
              <span>Sample revision · 12 players</span>
              <span>Manual board + sample ADP</span>
            </div>
          </section>

          <section className="panel ranking-editor">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Editable draft</p>
                <h2>12 ranked players</h2>
                <p>Live boards keep every prior version and the source behind each number.</p>
              </div>
              <div className="ranking-editor-actions">
                <button className="button button--lime button--small" type="button" disabled>
                  <Save size={14} /> Save draft
                </button>
              </div>
            </div>
            <div
              className="ranking-table-wrap"
              role="region"
              aria-label="Sample ranking board; scroll horizontally to view all columns"
              tabIndex={0}
            >
              <table className="ranking-table">
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Pos</th>
                    <th scope="col">Rank</th>
                    <th scope="col">Tier</th>
                    <th scope="col">ADP</th>
                    <th scope="col">AAV</th>
                    <th scope="col">Target</th>
                    <th scope="col">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {draftPlayers.slice(0, 12).map((player) => (
                    <tr key={player.id}>
                      <th scope="row">
                        <strong>{player.name}</strong>
                        <small>{player.team}</small>
                      </th>
                      <td>{player.position}</td>
                      <td>{player.rank}</td>
                      <td>{player.tier}</td>
                      <td>{player.adp}</td>
                      <td>${player.aav}</td>
                      <td>${player.fairValue}</td>
                      <td>
                        <span
                          className={`shared-ranking-signal shared-ranking-signal--${player.signal === "risk" ? "avoid" : "target"}`}
                        >
                          {player.signal === "risk" ? "Watch" : player.signal}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ranking-demo-footnote">
              <ShieldCheck size={14} />
              <span>
                Sample values only · private boards remain isolated until explicitly shared
              </span>
              <Check size={14} />
            </div>
          </section>

          <section className="panel ranking-demo-import">
            <FileSpreadsheet size={22} />
            <div>
              <strong>CSV import with a strict preview</strong>
              <p>Live mode resolves every row against the player catalog before it can be saved.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
