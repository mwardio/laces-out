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

import { apiBaseUrl } from "../lib/api-client";
import {
  describeRosRelease,
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
          <p className={styles.kicker}>Rest-of-season forecast</p>
          <h2 id="ros-lab-title">Rest-of-season forecast status</h2>
          <p>
            Four separate things decide whether your league gets a rest-of-season forecast: whether
            a model has been validated, whether it covers your scoring, whether your league inputs
            are complete, and what the latest check released. Each is reported on its own below.
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
  const artifact = status.admittedArtifacts.artifacts[0];
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
          <span>Validated model</span>
          <strong>{status.admittedArtifacts.state === "admitted" ? "In use" : "None yet"}</strong>
          <small>{description.supportedProfileSummary}</small>
        </div>
        <div>
          <span>Position groups released</span>
          <strong>{description.cellSummary ?? "Not checked yet"}</strong>
          <small>
            {description.withheldCells.length === 0
              ? "Every group cleared the latest check"
              : `Withheld: ${description.withheldCells.join(", ")}`}
          </small>
        </div>
        <div>
          <span>Leagues receiving it</span>
          <strong>{description.publishedLeagueCount}</strong>
          <small>
            {description.publishedLeagueCount === 0
              ? "None yet"
              : `${description.publishedPlayerCount} players · ${readableDate(latestPublishedIso)}`}
          </small>
        </div>
      </div>

      <div className={styles.section}>
        <h3>The validated model</h3>
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
            {description.unsupportedProfileSummary}. A league scored under an unvalidated profile
            receives nothing rather than a forecast built for different rules.
          </p>
        ) : null}
      </div>

      <div className={styles.section}>
        <h3>Your leagues</h3>
        {description.leagueNotices.length === 0 ? (
          <p className={styles.empty}>
            {description.readyLeagueCount === 1
              ? "Your league has everything the forecast needs."
              : `${description.readyLeagueCount} leagues have everything the forecast needs.`}
          </p>
        ) : (
          <>
            <p className={styles.reasonLead}>Outstanding for your leagues:</p>
            <ul className={styles.reasonList}>
              {description.leagueNotices.map((notice) => (
                <li key={notice}>
                  <CircleAlert size={14} aria-hidden="true" />
                  <span>{notice}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {description.leaguePositionSummaries.length > 0 ? (
          <ul className={styles.positionSummaryList}>
            {description.leaguePositionSummaries.map((league) => (
              <li key={league.leagueSeasonId ?? "unknown"} className={styles.positionSummaryRow}>
                <span className={styles.positionSummaryLabel}>
                  {league.leagueSeasonId ? `League ${league.leagueSeasonId.slice(0, 8)}` : "League"}
                </span>
                {league.positions.map((position) => (
                  <span
                    key={position.position}
                    className={
                      position.decision === "ready"
                        ? styles.positionChipReady
                        : styles.positionChipWithheld
                    }
                    title={position.title ?? undefined}
                  >
                    {position.position} {position.decision === "ready" ? "✓" : "✗"}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Operator detail: precise, still available, no longer the first thing a
          fantasy manager reads on a top-level nav item. */}
      <details className={styles.evidence}>
        <summary>Model evidence (advanced)</summary>
        <div className={styles.evidenceBody}>
          {artifact ? (
            <div>
              <h4>Validated model package</h4>
              <div className={styles.setMeta}>
                <span>
                  Policy {artifact.policyVersion} · Calibration {artifact.calibrationVersion}
                </span>
                <span className={styles.checksum}>
                  Checksum {shortenedChecksum(artifact.artifactChecksum)}
                </span>
                <span className={styles.checksum}>
                  Scoring profile {shortenedChecksum(artifact.scoringProfile.digest)}
                </span>
                <span>Admitted {readableDate(artifact.admittedAt)}</span>
                <span>{artifact.sourceChecksumCount} pinned source checksums</span>
              </div>
            </div>
          ) : null}

          {status.cellGates.state === "evaluated" ? (
            <div>
              <h4>Latest per-position check</h4>
              <div className={styles.setMeta}>
                <span>Checked {readableDate(status.cellGates.evaluatedAt)}</span>
              </div>
              <ul className={styles.reasonCodeList}>
                {status.cellGates.cells.map((cell) => (
                  <li key={`${cell.position}:${cell.bucket}`}>
                    {cell.position} {cell.bucket} — {cell.decision}
                    {cell.reasons.length > 0 ? ` (${cell.reasons.join(", ")})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h4>Independent audit run</h4>
            <div className={styles.setMeta}>
              <span>{description.auditHeadline}</span>
              {status.shadowAudit.latestRun ? (
                <span>Recorded {readableDate(status.shadowAudit.latestRun.createdAt)}</span>
              ) : null}
            </div>
            {description.auditDetail ? (
              <p className={styles.empty}>{description.auditDetail}</p>
            ) : null}
            {status.shadowAudit.latestRun && status.shadowAudit.latestRun.reasons.length > 0 ? (
              <ul className={styles.reasonCodeList}>
                {status.shadowAudit.latestRun.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
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
                    {set.scoringProfile ? `${set.scoringProfile.label} scoring` : "League forecast"}{" "}
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
                  {set.retainedFromEarlierRun ? (
                    <span>Retained from the last good check</span>
                  ) : null}
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
