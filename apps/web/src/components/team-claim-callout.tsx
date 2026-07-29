"use client";

import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseLeagueDashboard, type LeagueDashboard } from "../lib/api-client";
import { claimCalloutMode, defaultClaimChoice, selectableClaimTeams } from "../lib/team-claim";
import styles from "./team-claim-callout.module.css";

interface TeamClaimCalloutProps {
  readonly leagueId: string;
  /** Preloaded dashboard: skips the self-fetch. Omit to have the callout load its own. */
  readonly dashboard?: LeagueDashboard;
  readonly onClaimed?: () => void;
}

type LoadState =
  | { readonly status: "loading" }
  /** Covers a fetch error, a non-2xx response (including 401), and a failed parse alike: a
      signed-out visitor or a transient API hiccup must never see this callout at all. */
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly dashboard: LeagueDashboard };

type SaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "error"; readonly message: string };

/**
 * The explanation strings `teamClaimPolicy` sends (see `apps/api/src/league-dashboard.ts`) are
 * provider-verification detail ("this identity is self-asserted…", "Only that mapped team can be
 * claimed…") — accurate, but a paragraph, not a callout line. Only short-enough explanations are
 * used verbatim; anything longer falls back to the terse in-house line.
 */
const EXPLANATION_LENGTH_LIMIT = 70;

function supportingLine(dashboard: LeagueDashboard): string {
  const explanation = dashboard.teamClaim.explanation;
  return explanation.length <= EXPLANATION_LENGTH_LIMIT
    ? explanation
    : "Pick your team to unlock roster-aware analysis.";
}

export function TeamClaimCallout({ leagueId, dashboard, onClaimed }: TeamClaimCalloutProps) {
  const [load, setLoad] = useState<LoadState>(
    dashboard ? { status: "ready", dashboard } : { status: "loading" },
  );
  const [choice, setChoice] = useState("");
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const request = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async () => {
    if (dashboard) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoad({ status: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueId)}/dashboard`,
        {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || request.current !== controller) return;
      if (!response.ok) {
        setLoad({ status: "unavailable" });
        return;
      }
      const parsed = parseLeagueDashboard(await response.json());
      if (controller.signal.aborted || request.current !== controller) return;
      setLoad(parsed ? { status: "ready", dashboard: parsed } : { status: "unavailable" });
    } catch {
      if (!controller.signal.aborted && request.current === controller) {
        setLoad({ status: "unavailable" });
      }
    }
  }, [dashboard, leagueId]);

  useEffect(() => {
    if (dashboard) {
      setLoad({ status: "ready", dashboard });
      return;
    }
    void loadDashboard();
    return () => request.current?.abort();
  }, [dashboard, leagueId, loadDashboard]);

  const activeDashboard = load.status === "ready" ? load.dashboard : null;

  useEffect(() => {
    if (!activeDashboard) return;
    setChoice(defaultClaimChoice(activeDashboard));
    setSave({ status: "idle" });
  }, [activeDashboard]);

  async function claimTeam() {
    if (!choice || !activeDashboard) return;
    setSave({ status: "saving" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/leagues/${encodeURIComponent(activeDashboard.league.id)}/team-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ teamId: choice }),
        },
      );
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(
          typeof problem?.detail === "string" ? problem.detail : "That team could not be claimed.",
        );
      }
      setSave({ status: "saved" });
      onClaimed?.();
      if (!dashboard) await loadDashboard();
    } catch (error) {
      setSave({
        status: "error",
        message: error instanceof Error ? error.message : "That team could not be claimed.",
      });
    }
  }

  // Checked ahead of `load`/`activeDashboard`: a self-fetch refresh after a successful claim sets
  // `load` back to "loading" for a moment, and this confirmation must survive that, not disappear
  // under it.
  if (save.status === "saved") {
    return (
      <div className={styles.callout}>
        <p className={styles.savedLine} role="status">
          <CheckCircle2 size={14} aria-hidden="true" /> Team claim saved.
        </p>
      </div>
    );
  }

  if (load.status === "loading" || load.status === "unavailable") return null;
  if (!activeDashboard) return null;

  const mode = claimCalloutMode(activeDashboard);
  if (mode === "hidden") return null;

  const teams = selectableClaimTeams(activeDashboard);
  const heading = mode === "confirm-provider" ? "Confirm your Yahoo team" : "Which team is yours?";
  const buttonLabel = mode === "confirm-provider" ? "Confirm team" : "Claim team";

  return (
    <div className={styles.callout}>
      <div className={styles.copy}>
        <strong>{heading}</strong>
        <span>{supportingLine(activeDashboard)}</span>
      </div>
      <div className={styles.controls}>
        <label className="sr-only" htmlFor={`team-claim-callout-${activeDashboard.league.id}`}>
          Fantasy team
        </label>
        <select
          id={`team-claim-callout-${activeDashboard.league.id}`}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          {teams.map((team) => (
            <option value={team.id} key={team.id}>
              {team.name}
              {team.managerDisplayName ? ` · ${team.managerDisplayName}` : ""}
            </option>
          ))}
        </select>
        <button
          className="button button--dark button--small"
          type="button"
          disabled={!choice || save.status === "saving"}
          onClick={() => void claimTeam()}
        >
          {save.status === "saving" ? <LoaderCircle className={styles.spin} size={14} /> : null}
          {buttonLabel}
        </button>
      </div>
      {save.status === "error" ? (
        <p className={styles.errorLine} role="alert">
          <CircleAlert size={13} aria-hidden="true" /> {save.message}
        </p>
      ) : null}
    </div>
  );
}
