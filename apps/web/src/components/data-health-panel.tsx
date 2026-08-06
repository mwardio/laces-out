"use client";

import { CheckCircle2, ChevronRight, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  apiBaseUrl,
  parseAuthenticatedSession,
  parseDataQualitySources,
  parseJobAccepted,
  parseUnresolvedIdentities,
  type DataQualitySource,
  type UnresolvedIdentityResponse,
} from "../lib/api-client";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";

/**
 * The one place data health is stated.
 *
 * It used to be told three times — a card on the league overview, an expander on League Sync, and
 * this operator detail — which made a routine "everything is fine" read like something a member
 * had to act on. It is a collapsed expander at the bottom of Settings on purpose: available when
 * someone goes looking, silent otherwise.
 */

type RequestState = "working" | "done" | "error" | "idle";

type RefreshState = "idle" | "working" | "queued" | "deduplicated" | "error";

/** Whole percentages only: a match rate is evidence, not a precision claim. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function listSentence(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function formatRefreshTime(value: string | null): string {
  if (!value) return "Never synced";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sync time unavailable";
  return `Last sync ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

export function DataHealthPanel() {
  const [degradedSources, setDegradedSources] = useState<readonly DataQualitySource[]>([]);
  const [state, setState] = useState<RequestState>("working");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [draftMarketRefresh, setDraftMarketRefresh] = useState<RefreshState>("idle");

  /**
   * Member-safe source quality. The summary route carries admission state, match rates, reasons,
   * and provenance only — never a source row — so this section states impact without implying that
   * a member should repair upstream data.
   */
  const refresh = useCallback(async () => {
    setState("working");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/data-quality/sources`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setState("idle");
        setSignedOut(true);
        return;
      }
      if (!response.ok) {
        throw new Error(
          response.status === 503
            ? "Source quality reporting is not configured on this server yet."
            : "Source health could not be loaded.",
        );
      }
      const summary = parseDataQualitySources(await response.json());
      if (!summary) throw new Error("The source health response was invalid.");
      if (summary.availability.state !== "available") {
        // The bounded read withheld the dataset rather than truncating it; say so plainly.
        setDegradedSources([]);
        setNotice(summary.availability.reason);
        setState("done");
        return;
      }
      const degraded = summary.degradedSourceKeys;
      setDegradedSources(summary.sources.filter((source) => degraded.includes(source.key)));
      setState("done");
    } catch (caught) {
      setState("error");
      setError(caught instanceof Error ? caught.message : "Source health could not be loaded.");
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function checkDraftMarket() {
    if (draftMarketRefresh === "working") return;
    setDraftMarketRefresh("working");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/refreshes`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "adp-data" }),
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new Error("Draft-market check could not be queued.");
      const body = parseJobAccepted(await response.json());
      if (!body || body.target !== "draft-market-adp") {
        throw new Error("Draft-market queue response was invalid.");
      }
      setDraftMarketRefresh(body.state === "deduplicated" ? "deduplicated" : "queued");
    } catch {
      setDraftMarketRefresh("error");
    }
  }

  // A collapsed expander still needs to signal trouble; surface the worst state (withheld beats
  // not-yet-available) so a member never has to open the row just to learn everything is fine.
  const quarantinedSourceCount = degradedSources.filter(
    (source) => source.admission === "quarantined",
  ).length;
  const pendingSourceCount = degradedSources.length - quarantinedSourceCount;
  const hint = signedOut
    ? "Sign in to check"
    : state === "working"
      ? "Checking…"
      : state === "error"
        ? "Check failed"
        : notice
          ? "Unavailable"
          : degradedSources.length === 0
            ? "All sources healthy"
            : quarantinedSourceCount > 0
              ? `${quarantinedSourceCount} withheld${pendingSourceCount > 0 ? `, ${pendingSourceCount} pending` : ""}`
              : `${pendingSourceCount} pending`;

  return (
    <details className="connection-data-health" id="data-health">
      <summary className="connection-data-health__head">
        <div>
          <p className="eyebrow">Source health</p>
          <h2>Data health</h2>
        </div>
        <span className="connection-data-health__summary-status">
          <span className="connection-data-health__summary-hint">{hint}</span>
          <ChevronRight size={18} aria-hidden="true" />
        </span>
      </summary>

      <div className="connection-data-health__body">
        <p className="connection-data-health__lede">
          Laces Out withholds an analysis rather than publishing it from a source whose player
          identities did not resolve. Completed-season snapshots are archived after admission; they
          do not age into a stale state. Anything listed here is being withheld for you already.
        </p>

        {signedOut ? (
          <p className="connection-data-health__state" role="status">
            Sign in to see which sources are currently withheld.
          </p>
        ) : state === "working" ? (
          <p className="connection-data-health__state" role="status">
            Checking source health…
          </p>
        ) : state === "error" ? (
          <p
            className="connection-data-health__state connection-data-health__state--error"
            role="alert"
          >
            {error}
          </p>
        ) : notice ? (
          <p className="connection-data-health__state" role="status">
            {notice}
          </p>
        ) : degradedSources.length === 0 ? (
          <p className="connection-data-health__state" role="status">
            Every source is resolving identities above its threshold.
          </p>
        ) : (
          <ul className="connection-data-health__list">
            {degradedSources.map((source) => (
              <li className="connection-data-health__item" key={source.key}>
                <div className="connection-data-health__item-head">
                  <h3>{source.name}</h3>
                  <span
                    className={`connection-data-health__badge connection-data-health__badge--${source.admission}`}
                  >
                    {source.admission === "quarantined" ? "Withheld" : "Not yet available"}
                  </span>
                </div>
                <dl className="connection-data-health__facts">
                  <div>
                    <dt>Identity coverage</dt>
                    <dd>
                      {source.matchRate === null
                        ? "Not measured yet"
                        : `${percent(source.matchRate)} of ${percent(source.minimumMatchRate)} required`}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {source.lifecycle === "archived"
                        ? "Snapshot verified"
                        : "Last successful refresh"}
                    </dt>
                    <dd>{formatRefreshTime(source.lastSuccessfulAt)}</dd>
                  </div>
                </dl>
                <p className="connection-data-health__reason">{source.reason}</p>
                {source.affectedAnalysis.length > 0 ? (
                  <p className="connection-data-health__impact">
                    {`${listSentence(source.affectedAnalysis)} ${
                      source.affectedAnalysis.length === 1 ? "is" : "are"
                    } withheld for this source until identity coverage returns above ${percent(
                      source.minimumMatchRate,
                    )}.`}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {signedOut ? null : (
          <button
            className="button button--outline button--small"
            type="button"
            onClick={() => void checkDraftMarket()}
            disabled={draftMarketRefresh === "working"}
          >
            {draftMarketRefresh === "working" ? (
              <LoaderCircle className="spin" size={14} />
            ) : draftMarketRefresh === "queued" || draftMarketRefresh === "deduplicated" ? (
              <CheckCircle2 size={14} />
            ) : draftMarketRefresh === "error" ? (
              <CircleAlert size={14} />
            ) : (
              <RefreshCw size={14} />
            )}
            {draftMarketRefresh === "working"
              ? "Checking…"
              : draftMarketRefresh === "queued"
                ? "Queued"
                : draftMarketRefresh === "deduplicated"
                  ? "Already queued"
                  : draftMarketRefresh === "error"
                    ? "Retry"
                    : "Check market"}
          </button>
        )}

        <UnresolvedIdentityPanel />
      </div>
    </details>
  );
}

/**
 * Operator detail for source identity quality. The unresolved rows below are immutable
 * historical facts, not a queue anyone can clear: they record that an external identifier did not
 * resolve to a canonical player during a completed ingestion. The server's 403 is the real
 * boundary; the role check here only avoids a fetch that is guaranteed to fail for a member.
 */
function UnresolvedIdentityPanel() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [degraded, setDegraded] = useState<readonly DataQualitySource[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/auth/session`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? parseAuthenticatedSession(await response.json()) : null,
      )
      .then((session) => setIsAdmin(session?.user.role === "admin"))
      .catch(() => {
        if (!controller.signal.aborted) setIsAdmin(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setState("loading");
    void fetch(`${apiBaseUrl}/v1/data-quality/sources`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? parseDataQualitySources(await response.json()) : null,
      )
      .then((summary) => {
        if (!summary) {
          setState("error");
          return;
        }
        if (summary.availability.state !== "available") {
          setDegraded([]);
          setNotice(summary.availability.reason);
          setState("ready");
          return;
        }
        setNotice(null);
        setDegraded(
          summary.sources.filter((source) => summary.degradedSourceKeys.includes(source.key)),
        );
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [isAdmin]);

  if (!isAdmin) return null;
  return (
    <div className="live-unresolved">
      <h4>Unresolved identities</h4>
      {state === "loading" ? (
        <p role="status">Checking source identity quality…</p>
      ) : state === "error" ? (
        <p role="alert">Source identity quality could not be loaded.</p>
      ) : notice ? (
        <p role="status">{notice}</p>
      ) : degraded.length === 0 ? (
        <p role="status">Every source is resolving identities above its threshold.</p>
      ) : (
        degraded.map((source) => <UnresolvedSourceDisclosure key={source.key} source={source} />)
      )}
    </div>
  );
}

function UnresolvedSourceDisclosure({ source }: { readonly source: DataQualitySource }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<UnresolvedIdentityResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!open || state !== "idle") return;
    const controller = new AbortController();
    setState("loading");
    void fetch(
      `${apiBaseUrl}/v1/data-quality/sources/${encodeURIComponent(source.key)}/unresolved`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    )
      .then(async (response) =>
        response.ok ? parseUnresolvedIdentities(await response.json()) : null,
      )
      .then((result) => {
        if (!result) {
          setState("error");
          return;
        }
        setDetail(result);
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [open, state, source.key]);

  return (
    <details
      className="live-unresolved__source"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{source.name}</span>
        <small>
          {source.matchRate === null
            ? "No match rate recorded"
            : `${Math.round(source.matchRate * 100)}% matched · ${Math.round(source.minimumMatchRate * 100)}% required`}
        </small>
      </summary>
      {state === "loading" ? (
        <p role="status">Loading unresolved rows…</p>
      ) : state === "error" ? (
        <p role="alert">Unresolved rows could not be loaded.</p>
      ) : detail ? (
        <>
          {detail.weeks.state === "available" ? (
            detail.weeks.rows.length === 0 ? (
              <p>No unresolved rows are recorded for this source.</p>
            ) : (
              <div className="live-unresolved__scroll">
                <table>
                  <caption className="sr-only">
                    Unresolved rows by season and week for {source.name}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Season</th>
                      <th scope="col">Week</th>
                      <th scope="col">Unresolved rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.weeks.rows.map((row) => (
                      <tr key={`${row.season}-${row.week}`}>
                        <td>{row.season}</td>
                        <td>{row.week}</td>
                        <td>{row.unresolvedRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <p role="status">{detail.weeks.reason}</p>
          )}
          {detail.sample.state === "available" && detail.sample.rows.length > 0 ? (
            <div className="live-unresolved__scroll">
              <table>
                <caption className="sr-only">
                  Sample of unresolved source identities for {source.name}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Week</th>
                    <th scope="col">Source identifier</th>
                    <th scope="col">Team</th>
                    <th scope="col">Position</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sample.rows.map((row) => (
                    <tr key={`${row.week}-${row.externalPlayerId}`}>
                      <td>{row.week}</td>
                      <td>{row.externalPlayerId}</td>
                      <td>{row.team}</td>
                      <td>{row.position ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : detail.sample.state !== "available" ? (
            <p role="status">{detail.sample.reason}</p>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
