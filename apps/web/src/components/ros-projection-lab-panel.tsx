"use client";

import {
  ArrowUpRight,
  Clock3,
  Info,
  LoaderCircle,
  ShieldCheck,
  ShieldOff,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import {
  describeRosRelease,
  leagueLabelFor,
  parseRosReleaseStatus,
  type RosReleaseStatus,
} from "../lib/ros-release-status";
import styles from "./ros-projection-lab-panel.module.css";

type PanelState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly status: RosReleaseStatus };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readableDate(value: string | null): string {
  if (!value) return "Not reported";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // The status-aware fallback below remains safe for an empty or non-JSON response.
  }
  return `${fallback} (${response.status})`;
}

export function RosProjectionLabPanel() {
  const [panel, setPanel] = useState<PanelState>({ state: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPanel({ state: "loading" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/projections/ros-status`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (abortRef.current !== controller) return;
      if (response.status === 401) {
        setPanel({ state: "signed-out" });
        return;
      }
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not load rest-of-season status"));
      }
      const payload: unknown = await response.json();
      if (abortRef.current !== controller) return;
      const parsed = parseRosReleaseStatus(payload);
      if (!parsed) throw new Error("Status response did not match the expected contract");
      setPanel({ state: "ready", status: parsed });
    } catch (error) {
      if (isAbortError(error) || abortRef.current !== controller) return;
      setPanel({
        state: "error",
        message: error instanceof Error ? error.message : "Could not load rest-of-season status",
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  useEffect(() => void load(), [load]);

  if (panel.state === "signed-out") {
    return (
      <section
        className={`${styles.panel} ${styles.tourPanel}`}
        id="rest-of-season"
        aria-labelledby="ros-tour-title"
      >
        <div className={styles.header}>
          <div>
            <p className={styles.kicker}>Rest-of-season outlook</p>
            <h2 id="ros-tour-title">See beyond this week.</h2>
            <p>
              ROS scoring is based on first-party forecasts, and the outlook refreshes whenever
              trusted NFL inputs change.
            </p>
          </div>
          <span className={`${styles.badge} ${styles.badgePublishable}`}>
            <TrendingUp size={14} aria-hidden="true" />
            Tour preview
          </span>
        </div>
        <div className={styles.metrics}>
          <div>
            <span>Forecast window</span>
            <strong>Weeks 7–17</strong>
            <small>Regular season + fantasy playoffs</small>
          </div>
          <div>
            <span>Player coverage</span>
            <strong>210 players</strong>
            <small>League-scored outlooks</small>
          </div>
          <div>
            <span>Input checks</span>
            <strong>Daily + on demand</strong>
            <small>Reruns when source facts change</small>
          </div>
          <div>
            <span>Recommendation use</span>
            <strong>Validated first</strong>
            <small>Held back until every check passes</small>
          </div>
        </div>
        <div
          className={styles.tourPlayers}
          aria-label="Illustrative rest-of-season player outlooks"
        >
          <article>
            <span>RB · NYJ</span>
            <strong>Breece Hall</strong>
            <small>ROS RB4 · workload trending up</small>
            <ArrowUpRight size={15} aria-hidden="true" />
          </article>
          <article>
            <span>WR · DET</span>
            <strong>Amon-Ra St. Brown</strong>
            <small>ROS WR3 · stable target floor</small>
            <ArrowUpRight size={15} aria-hidden="true" />
          </article>
          <article>
            <span>TE · ARI</span>
            <strong>Trey McBride</strong>
            <small>ROS TE2 · elite route share</small>
            <ArrowUpRight size={15} aria-hidden="true" />
          </article>
        </div>
        <p className={styles.tourNote}>
          Illustrative tour values. Connected leagues receive scoring-specific forecasts with source
          age and readiness attached.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.panel} id="rest-of-season" aria-labelledby="ros-lab-title">
      <div className={styles.header}>
        <div>
          <h2 id="ros-lab-title">Rest-of-season forecast status</h2>
          <p>
            Where each of your leagues stands on getting a rest-of-season forecast, and what is
            still missing where one has not arrived yet.
          </p>
        </div>
      </div>

      {panel.state === "loading" ? (
        <p className={styles.message}>
          <LoaderCircle size={14} aria-hidden="true" /> Checking forecast status…
        </p>
      ) : null}

      {panel.state === "error" ? (
        <p className={styles.message} role="alert">
          {panel.message}
        </p>
      ) : null}

      {panel.state === "ready" ? <RosStatusBody status={panel.status} /> : null}
    </section>
  );
}

function RosStatusBody({ status }: { readonly status: RosReleaseStatus }) {
  const description = describeRosRelease(status);
  const latestPublishedIso =
    status.publishedSets.length === 0
      ? null
      : ([...status.publishedSets]
          .map((set) => set.fetchedAt)
          .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))[0] ?? null);

  return (
    <>
      {description.retainedSetNotice ? (
        <div className={styles.retainedBanner} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Your existing forecast is unchanged.</strong>
            {description.retainedSetNotice}
          </span>
        </div>
      ) : null}

      <div className={styles.metrics}>
        <div>
          <span>Season</span>
          <strong>{status.season}</strong>
          <small>Model {status.modelVersion}</small>
        </div>
        <div>
          <span>Forecast</span>
          <strong>
            {status.admittedArtifacts.state === "admitted" ? "Ready" : "Not ready yet"}
          </strong>
          <small>{description.supportedProfileSummary}</small>
        </div>
        <div>
          <span>Positions covered</span>
          <strong>{description.cellSummary ?? "Not checked yet"}</strong>
          <small>
            {description.withheldCells.length === 0
              ? "Every position is covered"
              : `Not covered: ${description.withheldCells.join(", ")}`}
          </small>
        </div>
        <div>
          <span>Your leagues with a forecast</span>
          <strong>{description.publishedLeagueCount}</strong>
          <small>
            {description.publishedLeagueCount === 0
              ? "None yet"
              : `${description.publishedPlayerCount} players · ${readableDate(latestPublishedIso)}`}
          </small>
        </div>
      </div>

      <div className={styles.section}>
        <h3>What the forecast covers</h3>
        <p className={styles.artifactLine}>
          {status.admittedArtifacts.state === "admitted" ? (
            <ShieldCheck size={15} aria-hidden="true" />
          ) : (
            <ShieldOff size={15} aria-hidden="true" />
          )}
          {description.artifactHeadline}
        </p>
        {description.unsupportedProfileSummary ? (
          <p className={styles.empty}>
            {description.unsupportedProfileSummary}. Leagues on those rules wait rather than get a
            forecast built for a different scoring format.
          </p>
        ) : null}
      </div>

      <div className={styles.section}>
        <h3>Leagues with a forecast</h3>
        {status.publishedSets.length === 0 ? (
          <p className={styles.empty}>None yet.</p>
        ) : (
          <div className={styles.setList}>
            {status.publishedSets.map((set) => (
              <article key={set.projectionSetId}>
                <header>
                  <span>
                    {leagueLabelFor(set.leagueName, set.leagueSeasonId)}
                    {set.scoringProfile ? ` · ${set.scoringProfile.label} scoring` : ""}
                  </span>
                  <span>
                    <Clock3 size={13} aria-hidden="true" /> {readableDate(set.fetchedAt)}
                  </span>
                </header>
                <div className={styles.setMeta}>
                  <span>{set.playerCount} players</span>
                  <span>
                    Weeks {set.windowStartWeek}–{set.windowEndWeek} (as of week {set.asOfWeek})
                  </span>
                  {set.retainedFromEarlierRun ? (
                    <span>Kept from the last passing check</span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
