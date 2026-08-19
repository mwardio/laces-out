"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseLeagueDashboard, type LeagueDashboard } from "../lib/api-client";
import { claimCalloutMode } from "../lib/team-claim";
import styles from "./team-claim-callout.module.css";

interface TeamClaimCalloutProps {
  readonly leagueId: string;
  /** Preloaded dashboard: skips the self-fetch. Omit to have the callout load its own. */
  readonly dashboard?: LeagueDashboard;
}

type LoadState =
  | { readonly status: "loading" }
  /** Covers a fetch error, a non-2xx response (including 401), and a failed parse alike: a
      signed-out visitor or a transient API hiccup must never see this callout at all. */
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly dashboard: LeagueDashboard };

/**
 * The unresolved-identity explanation from `teamClaimPolicy` is accurate but can be too long for a
 * compact cross-surface callout. Only short-enough explanations are used verbatim.
 */
const EXPLANATION_LENGTH_LIMIT = 70;

function supportingLine(dashboard: LeagueDashboard): string {
  const explanation = dashboard.teamClaim.explanation;
  return explanation.length <= EXPLANATION_LENGTH_LIMIT
    ? explanation
    : "Pick your team for roster-aware analysis.";
}

export function TeamClaimCallout({ leagueId, dashboard }: TeamClaimCalloutProps) {
  const [load, setLoad] = useState<LoadState>(
    dashboard ? { status: "ready", dashboard } : { status: "loading" },
  );
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

  if (load.status === "loading" || load.status === "unavailable") return null;
  if (!activeDashboard) return null;

  const mode = claimCalloutMode(activeDashboard);
  if (mode === "hidden") return null;

  return (
    <div className={styles.callout}>
      <div className={styles.copy}>
        <strong>Choose your team in Settings</strong>
        <span>{supportingLine(activeDashboard)}</span>
      </div>
      <Link className={styles.settingsLink} href="/settings#teams">
        Set team <ArrowRight size={13} aria-hidden="true" />
      </Link>
    </div>
  );
}
