"use client";

import { AlertCircle, BellRing, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  absoluteApiOrigin,
  apiBaseUrl,
  parseChangeFeed,
  prioritizeChangeEvents,
  type ChangeEvent,
  type ChangeEventFeedResponse,
} from "../lib/api-client";
import { LatestRequest } from "../lib/latest-request";
import styles from "./change-feed-panel.module.css";

/**
 * The change feed.
 *
 * Signed out, the API answers 401 and this panel renders nothing at all: a change feed has no
 * honest demo content — every row would be an invented claim about a league that does not exist.
 * The dashboard's demo path therefore simply does not show it.
 */

type FeedState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly feed: ChangeEventFeedResponse }
  | { readonly status: "hidden" }
  | { readonly status: "error"; readonly message: string };

const SEVERITY_CLASS: Readonly<Record<ChangeEvent["severity"], string>> = {
  info: styles.severityInfo ?? "",
  action: styles.severityAction ?? "",
  warning: styles.severityWarning ?? "",
  critical: styles.severityCritical ?? "",
};

function relativeTime(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface ChangeFeedPanelProps {
  readonly leagueId: string | null;
}

export function ChangeFeedPanel({ leagueId }: ChangeFeedPanelProps) {
  const [state, setState] = useState<FeedState>({ status: "loading" });
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  const request = useRef(new LatestRequest());
  const controller = useRef<AbortController | null>(null);
  const renderedAt = useMemo(() => Date.now(), [state]);

  const load = useCallback(async () => {
    const identity = request.current.begin(leagueId ?? "all");
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      // `apiBaseUrl` is a relative path in same-origin mode, which `new URL` cannot parse alone.
      const url = new URL(`${apiBaseUrl}/v1/change-events`, absoluteApiOrigin());
      if (leagueId) url.searchParams.set("leagueId", leagueId);
      const response = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: abort.signal,
      });
      if (!request.current.isCurrent(identity)) return;
      // Signed out, or the operator has not wired the feed: show nothing rather than an error the
      // member cannot act on.
      if (response.status === 401 || response.status === 503) {
        setState({ status: "hidden" });
        return;
      }
      if (!response.ok) throw new Error("The change feed could not be loaded.");
      const feed = parseChangeFeed(await response.json());
      if (!feed) throw new Error("The change feed response was invalid.");
      if (!request.current.isCurrent(identity)) return;
      setState({ status: "ready", feed });
    } catch (error) {
      if (abort.signal.aborted || !request.current.isCurrent(identity)) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The change feed could not be loaded.",
      });
    }
  }, [leagueId]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
    return () => controller.current?.abort();
  }, [load]);

  async function mutate(eventId: string, action: "read" | "dismiss") {
    setPendingEventId(eventId);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/change-events/${encodeURIComponent(eventId)}/${action}`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        },
      );
      // A 404 means the event is already gone for this member; refetching is the honest answer.
      if (!response.ok && response.status !== 404) {
        throw new Error("That update could not be changed.");
      }
      await load();
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "That update could not be changed.",
      });
    } finally {
      setPendingEventId(null);
    }
  }

  if (state.status === "hidden") return null;

  const events = state.status === "ready" ? prioritizeChangeEvents(state.feed.events) : [];
  const unreadCount = state.status === "ready" ? state.feed.unreadCount : 0;

  return (
    <section className={styles.panel} aria-labelledby="change-feed-title">
      <div className={styles.header}>
        <div>
          <h2 id="change-feed-title">Recent league activity</h2>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.unread} aria-live="polite">
            <span className="sr-only">{unreadCount} unread updates</span>
            <span aria-hidden="true">{unreadCount}</span>
          </span>
          <button
            className={styles.action}
            type="button"
            onClick={() => void load()}
            disabled={state.status === "loading"}
            aria-label="Refresh the change feed"
          >
            <RefreshCw
              className={state.status === "loading" ? styles.spin : undefined}
              size={13}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
      </div>

      {state.status === "loading" ? (
        <div className={styles.state} role="status">
          <LoaderCircle className={styles.spin} size={18} aria-hidden="true" />
          Checking for updates…
        </div>
      ) : state.status === "error" ? (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <strong>Change feed unavailable</strong>
            <p>{state.message}</p>
          </div>
          <button className={styles.action} type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : events.length === 0 ? (
        <div className={styles.state}>
          <BellRing size={18} aria-hidden="true" />
          No recent league changes.
        </div>
      ) : (
        <div className={styles.list}>
          {events.map((entry) => (
            <article
              className={`${styles.row}${entry.state === "read" ? ` ${styles.rowRead}` : ""}`}
              key={entry.id}
            >
              <span
                className={`${styles.severity} ${SEVERITY_CLASS[entry.severity]}`}
                aria-hidden="true"
              />
              <div className={styles.body}>
                <p className={styles.headline}>{entry.headline}</p>
                {entry.detail ? <p className={styles.detail}>{entry.detail}</p> : null}
                <div className={styles.meta}>
                  <span className={styles.time}>{relativeTime(entry.occurredAt, renderedAt)}</span>
                  <div className={styles.actions}>
                    {entry.state === "unread" ? (
                      <button
                        className={styles.action}
                        type="button"
                        onClick={() => void mutate(entry.id, "read")}
                        disabled={pendingEventId === entry.id}
                        aria-label={`Mark read: ${entry.headline}`}
                      >
                        {pendingEventId === entry.id ? (
                          <LoaderCircle className={styles.spin} size={12} aria-hidden="true" />
                        ) : (
                          <Check size={12} aria-hidden="true" />
                        )}
                        Mark read
                      </button>
                    ) : null}
                    <button
                      className={styles.action}
                      type="button"
                      onClick={() => void mutate(entry.id, "dismiss")}
                      disabled={pendingEventId === entry.id}
                      aria-label={`Dismiss: ${entry.headline}`}
                    >
                      {pendingEventId === entry.id ? (
                        <LoaderCircle className={styles.spin} size={12} aria-hidden="true" />
                      ) : (
                        <X size={12} aria-hidden="true" />
                      )}
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
