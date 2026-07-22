"use client";

import { CircleAlert, Clock3, Info, LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseRosProjectionStatus, type RosProjectionStatus } from "../lib/api-client";
import { describeRosProjectionRail } from "../lib/ros-projection-status";
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

  return (
    <section className={styles.panel} aria-labelledby="ros-lab-title">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Rest-of-season rail</p>
          <h2 id="ros-lab-title">Rest-of-season projection status</h2>
          <p>
            Read-only visibility into the first-party ROS rail: whether a champion artifact is
            admitted, the latest model-run audit, and any league-scoped published set. Nothing here
            is used by lineup, waiver, trade, standings, or AI recommendations.
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
            {panel.status.publication === "publishable" ? "Publishable" : "Fail-closed shadow"}
          </span>
        ) : null}
      </div>

      {panel.state === "loading" ? (
        <p className={styles.message}>
          <LoaderCircle size={14} aria-hidden="true" /> Loading rail status…
        </p>
      ) : null}

      {panel.state === "signed-out" ? (
        <p className={styles.message}>Sign in to inspect the rest-of-season rail status.</p>
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
            <strong>Shadow only — not used in any recommendations.</strong>
            The rail is fail-closed: it records audit evidence and cannot authorize live publication
            until an admitted champion artifact validates against the running code.
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
          <span>Champion artifact</span>
          <strong>{description.artifactPresent ? "Admitted" : "None"}</strong>
          <small>
            {description.artifactPresent
              ? "Validated at publication time"
              : "Rail stays fail-closed"}
          </small>
        </div>
        <div>
          <span>Last evaluated</span>
          <strong>{readableDate(description.lastEvaluatedIso)}</strong>
          <small>
            {status.latestRun ? `Run state: ${status.latestRun.qualityState}` : "No runs"}
          </small>
        </div>
        <div>
          <span>Published sets</span>
          <strong>{description.publishedLeagueCount}</strong>
          <small>
            {description.publishedLeagueCount === 0
              ? "No leagues published"
              : `${description.publishedPlayerCount} players · ${readableDate(description.lastPublishedIso)}`}
          </small>
        </div>
      </div>

      <div className={styles.section}>
        <h3>Champion artifact</h3>
        <p className={styles.artifactLine}>
          {description.artifactPresent ? (
            <ShieldCheck size={15} aria-hidden="true" />
          ) : (
            <ShieldOff size={15} aria-hidden="true" />
          )}
          {description.artifactSummary}
        </p>
        {status.artifact.present ? (
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
        ) : null}
      </div>

      <div className={styles.section}>
        <h3>Latest model-run audit</h3>
        {status.latestRun ? (
          <>
            <div className={styles.setMeta}>
              <span>Mode {status.latestRun.mode}</span>
              <span>Quality {status.latestRun.qualityState}</span>
              <span>Can publish: {status.latestRun.canPublish ? "yes" : "no"}</span>
              <span>
                Window W{status.latestRun.windowStartWeek}–W{status.latestRun.windowEndWeek} (as of
                W{status.latestRun.asOfWeek})
              </span>
              <span>
                {status.latestRun.playersPublished}/{status.latestRun.playersEvaluated} players
                published
              </span>
            </div>
            {description.reasons.length > 0 ? (
              <ul className={styles.reasonList}>
                {description.reasons.map((reason) => (
                  <li key={reason.code}>
                    <CircleAlert size={14} aria-hidden="true" />
                    <span>
                      {reason.label}
                      <span className={styles.reasonCode}>{reason.code}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>No withhold or degraded reasons recorded.</p>
            )}
          </>
        ) : (
          <p className={styles.empty}>
            No rest-of-season model run has been recorded yet. The rail has not evaluated this
            season.
          </p>
        )}
      </div>

      <div className={styles.section}>
        <h3>Published sets</h3>
        {status.publishedSets.length === 0 ? (
          <p className={styles.empty}>
            No league-scoped rest-of-season set is published — expected while the rail is
            fail-closed.
          </p>
        ) : (
          <div className={styles.setList}>
            {status.publishedSets.map((set) => (
              <article key={set.projectionSetId}>
                <header>
                  <span>League season {set.leagueSeasonId}</span>
                  <span>
                    <Clock3 size={13} aria-hidden="true" /> {readableDate(set.fetchedAt)}
                  </span>
                </header>
                <div className={styles.setMeta}>
                  <span>{set.playerCount} players</span>
                  <span>
                    Window W{set.windowStartWeek}–W{set.windowEndWeek} (as of W{set.asOfWeek})
                  </span>
                  {set.scoringProfileKey ? <span>Scoring {set.scoringProfileKey}</span> : null}
                  <span className={styles.checksum}>
                    Input {shortenedChecksum(set.inputChecksum)}
                  </span>
                  {set.championArtifactChecksum ? (
                    <span className={styles.checksum}>
                      Artifact {shortenedChecksum(set.championArtifactChecksum)}
                    </span>
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
