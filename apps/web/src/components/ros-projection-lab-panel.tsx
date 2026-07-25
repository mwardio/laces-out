"use client";

import {
  ArrowUpRight,
  CircleAlert,
  Clock3,
  Info,
  LoaderCircle,
  ShieldCheck,
  ShieldOff,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseRosProjectionStatus, type RosProjectionStatus } from "../lib/api-client";
import {
  describeRosProjectionRail,
  humanizeRosQualityState,
  humanizeRosRunMode,
} from "../lib/ros-projection-status";
import styles from "./ros-projection-lab-panel.module.css";

type PanelState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly status: RosProjectionStatus };

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

function shortenedChecksum(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
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
      const parsed = parseRosProjectionStatus(payload);
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
          <p className={styles.kicker}>Rest-of-season forecast</p>
          <h2 id="ros-lab-title">Rest-of-season forecast status</h2>
          <p>
            Whether the rest-of-season forecast is ready for your league, when it was last checked,
            and what is still outstanding. Until every check passes it is withheld — it never
            quietly feeds a lineup, waiver, or trade call.
          </p>
        </div>
        {panel.state === "ready" ? (
          <span
            className={`${styles.badge} ${
              panel.status.publication === "publishable"
                ? styles.badgePublishable
                : styles.badgeShadow
            }`}
          >
            {panel.status.publication === "publishable" ? (
              <ShieldCheck size={14} aria-hidden="true" />
            ) : (
              <ShieldOff size={14} aria-hidden="true" />
            )}
            {panel.status.publication === "publishable" ? "Ready" : "Validating"}
          </span>
        ) : null}
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

function RosStatusBody({ status }: { readonly status: RosProjectionStatus }) {
  const description = describeRosProjectionRail(status);

  return (
    <>
      {description.isShadow ? (
        <div className={styles.shadowBanner} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Still validating, not used in recommendations yet.</strong>
            The latest forecast remains isolated until its model package and source checks pass.
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
          <span>Validated model</span>
          <strong>{description.artifactPresent ? "In use" : "None yet"}</strong>
          <small>
            {description.artifactPresent
              ? "Re-checked every time it publishes"
              : "Nothing publishes until one passes"}
          </small>
        </div>
        <div>
          <span>Last checked</span>
          <strong>{readableDate(description.lastEvaluatedIso)}</strong>
          <small>
            {status.latestRun
              ? humanizeRosQualityState(status.latestRun.qualityState)
              : "Not checked yet this season"}
          </small>
        </div>
        <div>
          <span>Leagues receiving it</span>
          <strong>{description.publishedLeagueCount}</strong>
          <small>
            {description.publishedLeagueCount === 0
              ? "None yet"
              : `${description.publishedPlayerCount} players · ${readableDate(description.lastPublishedIso)}`}
          </small>
        </div>
      </div>

      <div className={styles.section}>
        <h3>Where it stands</h3>
        <p className={styles.artifactLine}>
          {description.artifactPresent ? (
            <ShieldCheck size={15} aria-hidden="true" />
          ) : (
            <ShieldOff size={15} aria-hidden="true" />
          )}
          {description.artifactSummary}
        </p>
        {status.latestRun ? (
          description.reasons.length > 0 ? (
            <>
              <p className={styles.reasonLead}>
                {description.isShadow
                  ? "Still outstanding before it can be published:"
                  : "Noted on the most recent check:"}
              </p>
              <ul className={styles.reasonList}>
                {description.reasons.map((reason) => (
                  <li key={reason.code}>
                    <CircleAlert size={14} aria-hidden="true" />
                    <span>{reason.label}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={styles.empty}>Nothing is currently holding it back.</p>
          )
        ) : (
          <p className={styles.empty}>
            This season has not been checked yet, so there is nothing to publish.
          </p>
        )}
      </div>

      {/* Operator detail: precise, still available, no longer the first thing a
          fantasy manager reads on a top-level nav item. */}
      <details className={styles.evidence}>
        <summary>Model evidence (advanced)</summary>
        <div className={styles.evidenceBody}>
          {status.artifact.present ? (
            <div>
              <h4>Validated model package</h4>
              <div className={styles.setMeta}>
                <span>
                  Policy {status.artifact.policyVersion} · Calibration{" "}
                  {status.artifact.calibrationVersion}
                </span>
                <span className={styles.checksum}>
                  Checksum {shortenedChecksum(status.artifact.artifactChecksum)}
                </span>
                <span>Admitted {readableDate(status.artifact.admittedAt)}</span>
                <span>{status.artifact.sourceChecksums.length} pinned source checksums</span>
              </div>
            </div>
          ) : null}

          {status.latestRun ? (
            <div>
              <h4>Most recent model run</h4>
              <div className={styles.setMeta}>
                <span>{humanizeRosRunMode(status.latestRun.mode)}</span>
                <span>{humanizeRosQualityState(status.latestRun.qualityState)}</span>
                <span>
                  {status.latestRun.canPublish ? "Cleared to publish" : "Not cleared to publish"}
                </span>
                <span>
                  Weeks {status.latestRun.windowStartWeek}–{status.latestRun.windowEndWeek} (as of
                  week {status.latestRun.asOfWeek})
                </span>
                <span>
                  {status.latestRun.playersPublished} of {status.latestRun.playersEvaluated} players
                  published
                </span>
              </div>
              {description.reasons.length > 0 ? (
                <ul className={styles.reasonCodeList}>
                  {description.reasons.map((reason) => (
                    <li key={reason.code}>{reason.code}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>

      <div className={styles.section}>
        <h3>Leagues receiving this forecast</h3>
        {status.publishedSets.length === 0 ? (
          <p className={styles.empty}>
            None yet. That is the expected state while the forecast is still being validated — it is
            withheld rather than published unproven.
          </p>
        ) : (
          <div className={styles.setList}>
            {status.publishedSets.map((set) => (
              <article key={set.projectionSetId}>
                <header>
                  <span>
                    {set.scoringProfileKey ? `${set.scoringProfileKey} scoring` : "League forecast"}{" "}
                    · {set.leagueSeasonId.slice(0, 8)}
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
                </div>
                <details className={styles.setEvidence}>
                  <summary>Checksums</summary>
                  <div className={styles.setMeta}>
                    <span className={styles.checksum}>
                      Input {shortenedChecksum(set.inputChecksum)}
                    </span>
                    {set.championArtifactChecksum ? (
                      <span className={styles.checksum}>
                        Model {shortenedChecksum(set.championArtifactChecksum)}
                      </span>
                    ) : null}
                  </div>
                </details>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
