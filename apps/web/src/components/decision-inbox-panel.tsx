"use client";

import {
  decisionInboxResponseSchema,
  decisionInboxStateResponseSchema,
  type DecisionInboxItem,
  type DecisionInboxItemState,
  type DecisionInboxResponse,
} from "@laces-out/contracts";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ClipboardCheck,
  Info,
  ListPlus,
  LoaderCircle,
  RefreshCw,
  Repeat2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { compactDate } from "../lib/copy";
import styles from "./decision-inbox-panel.module.css";

interface DecisionInboxPanelProps {
  readonly leagueId: string;
  readonly refreshToken: number;
}

const kindLabels = { lineup: "Lineup", waiver: "Waivers", trade: "Trades" } as const;

function KindIcon({ kind }: { readonly kind: DecisionInboxItem["kind"] }) {
  if (kind === "lineup") return <ClipboardCheck size={19} aria-hidden="true" />;
  if (kind === "waiver") return <ListPlus size={19} aria-hidden="true" />;
  return <Repeat2 size={19} aria-hidden="true" />;
}

export function DecisionInboxPanel({ leagueId, refreshToken }: DecisionInboxPanelProps) {
  const [feed, setFeed] = useState<DecisionInboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresSignIn, setRequiresSignIn] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const request = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const previousRefresh = useRef(refreshToken);
  const headingId = useId();
  const historyId = useId();
  const detailsPrefix = useId();
  const endpoint = `${apiBaseUrl}/v1/leagues/${encodeURIComponent(leagueId)}/decision-inbox`;
  const currentFeed = feed?.league.id === leagueId ? feed : null;

  const load = useCallback(
    async (refresh = false) => {
      request.current?.abort();
      const abort = new AbortController();
      request.current = abort;
      setLoading(true);
      setError(null);
      setRequiresSignIn(false);
      try {
        const response = await fetch(`${endpoint}${refresh ? "?refresh=true" : ""}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: abort.signal,
        });
        if (abort.signal.aborted || request.current !== abort) return;
        if (response.status === 401 || response.status === 404) {
          setFeed(null);
          setRequiresSignIn(response.status === 401);
          throw new Error(
            response.status === 401
              ? "Sign in again to see your decision inbox."
              : "This league is no longer available to your account.",
          );
        }
        if (!response.ok)
          throw new Error("The decision inbox could not be loaded. Please try again.");
        const parsed = decisionInboxResponseSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.league.id !== leagueId) {
          throw new Error("The decision inbox response could not be read. Please try again.");
        }
        if (abort.signal.aborted || request.current !== abort) return;
        setFeed(parsed.data);
        setExpandedId((current) =>
          current && parsed.data.items.some((item) => item.id === current && item.state === "open")
            ? current
            : null,
        );
      } catch (cause) {
        if (!abort.signal.aborted && request.current === abort) {
          setError(
            cause instanceof Error ? cause.message : "The decision inbox could not be loaded.",
          );
        }
      } finally {
        if (!abort.signal.aborted && request.current === abort) setLoading(false);
      }
    },
    [endpoint, leagueId],
  );

  useEffect(() => {
    const refresh = previousRefresh.current !== refreshToken;
    previousRefresh.current = refreshToken;
    void load(refresh);
    return () => request.current?.abort();
  }, [load, refreshToken]);

  useEffect(() => () => mutation.current?.abort(), [leagueId]);

  async function updateState(item: DecisionInboxItem, state: DecisionInboxItemState) {
    if (mutation.current) return;
    request.current?.abort();
    setLoading(false);
    const abort = new AbortController();
    mutation.current = abort;
    setPendingId(item.id);
    setError(null);
    setAnnouncement("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(item.id)}/state`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
        cache: "no-store",
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      if (response.status === 401 || response.status === 404 || response.status === 409) {
        await load(true);
        if (!abort.signal.aborted)
          setAnnouncement("The inbox has been refreshed. This advice may have changed.");
        return;
      }
      if (!response.ok) throw new Error("Your change could not be saved. Please try again.");
      const parsed = decisionInboxStateResponseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.itemId !== item.id || parsed.data.state !== state) {
        throw new Error("Your change could not be confirmed. Refresh the inbox and try again.");
      }
      if (abort.signal.aborted) return;
      // A reload may have started while the receipt was being saved; never let an older receipt
      // overlay undo the action that has just completed.
      request.current?.abort();
      setLoading(false);
      setFeed((current) =>
        current?.league.id === leagueId
          ? {
              ...current,
              items: current.items.map((entry) =>
                entry.id === item.id ? { ...entry, state } : entry,
              ),
            }
          : current,
      );
      setExpandedId(null);
      setAnnouncement(
        state === "reviewed"
          ? "Decision marked reviewed."
          : state === "dismissed"
            ? "Decision dismissed."
            : "Decision returned to the inbox.",
      );
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Your change could not be saved.");
    } finally {
      if (!abort.signal.aborted) {
        mutation.current = null;
        setPendingId(null);
      }
    }
  }

  const openItems = currentFeed?.items.filter((item) => item.state === "open") ?? [];
  const history = currentFeed?.items.filter((item) => item.state !== "open") ?? [];
  const unavailable =
    currentFeed?.sections.filter((section) => section.state === "unavailable") ?? [];
  const allUnavailable = currentFeed !== null && unavailable.length === currentFeed.sections.length;
  const reasonCodes = new Set(
    unavailable.flatMap((section) => section.reasons.map((reason) => reason.code)),
  );
  const needsTeam =
    reasonCodes.has("TEAM_UNCLAIMED") || reasonCodes.has("CLAIMED_TEAM_NOT_IN_SEASON");
  const needsSync = reasonCodes.has("NO_SEASON");
  const decisionsHref = { pathname: "/decisions", query: { league: leagueId } };

  function renderItem(item: DecisionInboxItem) {
    const expanded = expandedId === item.id;
    const saved = item.state !== "open";
    return (
      <article className={`${styles.item}${saved ? ` ${styles.saved}` : ""}`} key={item.id}>
        <button
          className={styles.summary}
          type="button"
          aria-expanded={expanded}
          aria-controls={`${detailsPrefix}-${item.id}`}
          onClick={() => setExpandedId(expanded ? null : item.id)}
        >
          <span className={`${styles.icon} ${styles[item.kind]}`}>
            <KindIcon kind={item.kind} />
          </span>
          <span className={styles.copy}>
            <span className={styles.meta}>
              {kindLabels[item.kind]}
              {saved ? ` · ${item.state === "reviewed" ? "Reviewed" : "Dismissed"}` : ""}
            </span>
            <strong>{item.title}</strong>
            <span className={styles.description}>{item.summary}</span>
          </span>
          <span className={styles.impact}>{item.impact.label}</span>
          <ChevronDown
            className={expanded ? styles.rotated : undefined}
            size={17}
            aria-hidden="true"
          />
        </button>
        <div className={styles.detail} id={`${detailsPrefix}-${item.id}`} hidden={!expanded}>
          <div className={styles.rationale}>
            {item.detail.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
          <div className={styles.itemActions}>
            <Link
              className="button button--dark button--small"
              href={{ ...decisionsHref, hash: item.href.split("#")[1] }}
            >
              View{" "}
              {item.kind === "lineup"
                ? "lineup plan"
                : item.kind === "waiver"
                  ? "waiver analysis"
                  : "trade analysis"}{" "}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
            {saved ? (
              <button
                className="button button--outline button--small"
                type="button"
                disabled={pendingId !== null}
                onClick={() => void updateState(item, "open")}
              >
                {pendingId === item.id ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : (
                  <RotateCcw size={14} aria-hidden="true" />
                )}{" "}
                Return to inbox
              </button>
            ) : (
              <>
                <button
                  className="button button--outline button--small"
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => void updateState(item, "reviewed")}
                >
                  {pendingId === item.id ? (
                    <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  ) : (
                    <Check size={14} aria-hidden="true" />
                  )}{" "}
                  Mark reviewed
                </button>
                <button
                  className={styles.dismiss}
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => void updateState(item, "dismissed")}
                  aria-label={`Dismiss decision: ${item.title}`}
                >
                  <X size={14} aria-hidden="true" /> Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId} aria-busy={loading}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Decision inbox</p>
          <h2 id={headingId}>What deserves attention</h2>
          <p className={styles.subtitle}>
            {currentFeed
              ? `${currentFeed.league.name}${currentFeed.team ? ` · ${currentFeed.team.name}` : ""}${currentFeed.league.week !== null ? ` · Week ${currentFeed.league.week}` : ""}`
              : "Your next moves, grounded in your league and roster."}
          </p>
        </div>
        <div className={styles.headerActions}>
          {currentFeed ? (
            <span className={styles.count} aria-label={`${openItems.length} open decisions`}>
              {openItems.length}
            </span>
          ) : null}
          <button
            className="button button--outline button--small"
            type="button"
            onClick={() => void load(true)}
            disabled={loading || pendingId !== null}
            aria-label="Refresh decision inbox"
          >
            <RefreshCw className={loading ? "spin" : undefined} size={14} aria-hidden="true" />{" "}
            Refresh
          </button>
          <Link className="button button--outline button--small" href={decisionsHref}>
            Decision Desk <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {error ? (
        <div className={styles.error} role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <p>{error}</p>
          {requiresSignIn ? (
            <Link href="/login">Sign in</Link>
          ) : (
            <button
              className={styles.dismiss}
              type="button"
              onClick={() => void load(true)}
              disabled={loading || pendingId !== null}
            >
              Retry
            </button>
          )}
        </div>
      ) : null}
      {!currentFeed && loading ? (
        <div className={styles.empty} role="status">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <strong>Checking your next moves…</strong>
        </div>
      ) : null}
      {currentFeed ? (
        <>
          {openItems.length > 0 ? (
            <div>{openItems.map(renderItem)}</div>
          ) : (
            <div className={styles.empty}>
              {allUnavailable ? (
                <Info size={22} aria-hidden="true" />
              ) : (
                <Check size={22} aria-hidden="true" />
              )}
              <strong>
                {needsTeam
                  ? "Choose your team to get started"
                  : needsSync
                    ? "Sync your league to get started"
                    : allUnavailable
                      ? "Your analysis is waiting on data"
                      : history.length > 0
                        ? "You’ve worked through your inbox"
                        : "No new moves to suggest"}
              </strong>
              <p>
                {needsTeam
                  ? "Select your team in Settings for recommendations based on your roster."
                  : needsSync
                    ? "Connect and sync a league season so your roster can be analyzed."
                    : allUnavailable
                      ? "The details below explain what is needed to build your recommendations."
                      : history.length > 0
                        ? "Reviewed and dismissed decisions are saved below. New advice will appear when it changes."
                        : "No positive moves surfaced in the available analysis. Check the Decision Desk for the full picture."}
              </p>
              {needsTeam ? (
                <Link className="button button--outline button--small" href="/settings#teams">
                  Choose your team <ArrowRight size={14} aria-hidden="true" />
                </Link>
              ) : null}
              {needsSync ? (
                <Link className="button button--outline button--small" href="/connections">
                  Open League Sync <ArrowRight size={14} aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          )}
          {unavailable.length > 0 ? (
            <details className={styles.coverage} open={allUnavailable && !needsTeam && !needsSync}>
              <summary>
                <Info size={15} aria-hidden="true" />{" "}
                {allUnavailable
                  ? "What’s needed for your analysis"
                  : `${unavailable.map((section) => kindLabels[section.kind]).join(" and ")} analysis unavailable`}
              </summary>
              <div>
                {unavailable.map((section) => (
                  <div key={section.kind}>
                    <strong>{kindLabels[section.kind]}</strong>
                    {section.reasons.map((reason) => (
                      <p key={reason.code}>{reason.message}</p>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {history.length > 0 ? (
            <>
              <button
                className={styles.historyToggle}
                type="button"
                aria-expanded={showHistory}
                aria-controls={historyId}
                onClick={() => setShowHistory((current) => !current)}
              >
                <Check size={15} aria-hidden="true" /> Reviewed &amp; dismissed ({history.length}){" "}
                <ChevronDown
                  className={showHistory ? styles.rotated : undefined}
                  size={15}
                  aria-hidden="true"
                />
              </button>
              <div id={historyId} hidden={!showHistory}>
                {history.map(renderItem)}
              </div>
            </>
          ) : null}
          <footer className={styles.footer}>
            <span>
              <ShieldCheck size={15} aria-hidden="true" /> Review here. Make roster moves with your
              league provider.
            </span>
            <span title={`Analysis generated ${compactDate(currentFeed.generatedAt)}`}>
              Forecast: {currentFeed.provenance.projectionFreshness.label}
            </span>
          </footer>
        </>
      ) : null}
    </section>
  );
}
