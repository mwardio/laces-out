"use client";

import {
  PERSONA_CARD_MAX_LENGTH,
  recapSpiceLevelSchema,
  type AiProviderConfiguration,
  type AiProviderName,
  type LeagueAnalyticsSnapshot,
  type LeagueRecapResponse,
  type RecapPersonaCardList,
  type RecapSpiceLevel,
} from "@fantasy/contracts";
import { Clipboard, Flame, LoaderCircle, Megaphone, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiBaseUrl, parseAiProviderList } from "../lib/api-client";
import {
  demoHistoricalRecapBodies,
  demoLeagueRecap,
  demoRecapPersonaCards,
} from "../lib/demo-contract-data";
import {
  awardableWeek,
  canEditSpice,
  canGenerateRecap,
  canManageLeagueIntel,
  parseLeagueRecap,
  parseRecapPersonaCards,
  parseRecapSettings,
  recapByline,
  recapUnavailableReasons,
  selectableRecapWeeks,
} from "../lib/recap";
import { AiAnswerContent } from "./ai-answer-content";
import styles from "./reckoning-recap-panel.module.css";

type RecapState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly response: LeagueRecapResponse };

const PROVIDER_LABELS: Readonly<Record<AiProviderName, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  openrouter: "OpenRouter",
};

const SPICE_LABELS: Readonly<Record<RecapSpiceLevel, string>> = {
  mild: "Mild · clean",
  medium: "Medium · NSFW",
  scorched: "Scorched · NSFW",
};

export interface ReckoningRecapPanelProps {
  readonly leagueId: string;
  readonly snapshot: LeagueAnalyticsSnapshot;
  readonly demo: boolean;
}

async function problemMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
    if (typeof body.title === "string" && body.title) return body.title;
  } catch {
    // Malformed problem body; the fallback carries the status.
  }
  return fallback;
}

/** The tour's stored recap for a given week, so switching weeks visibly changes the artifact. */
function demoRecapFor(week: number): LeagueRecapResponse {
  if (week === demoLeagueRecap.week) return demoLeagueRecap;
  const body = demoHistoricalRecapBodies[week];
  return {
    ...demoLeagueRecap,
    week,
    recap: body && demoLeagueRecap.recap ? { ...demoLeagueRecap.recap, week, body } : null,
  };
}

export function ReckoningRecapPanel({ leagueId, snapshot, demo }: ReckoningRecapPanelProps) {
  const weeks = useMemo(
    () => selectableRecapWeeks(snapshot.weeklyAwardWeeks, awardableWeek(snapshot.weeklyAwards)),
    [snapshot.weeklyAwardWeeks, snapshot.weeklyAwards],
  );
  // Falling back to the league's current week keeps the spice dial and League Intel loading even
  // when no week is awardable yet; the response still explains why generation is unavailable.
  const defaultWeek = weeks[0] ?? snapshot.league.currentWeek ?? 1;
  const membership = snapshot.membership;
  const managesLeagueIntel = canManageLeagueIntel(membership);

  const [selectedWeek, setSelectedWeek] = useState(defaultWeek);
  const [recap, setRecap] = useState<RecapState>({ state: "loading" });
  const [cards, setCards] = useState<RecapPersonaCardList | null>(null);
  const [cardsMessage, setCardsMessage] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly AiProviderConfiguration[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderName>("gemini");
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingSpice, setSavingSpice] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.available),
    [providers],
  );

  useEffect(() => {
    setSelectedWeek(defaultWeek);
  }, [defaultWeek]);

  // The Film Room links here as /analytics#reckoning-recap, but this panel mounts only after the
  // analytics snapshot loads — long after the browser's own fragment scroll has given up — so the
  // deep link is honored here. scroll-margin-top on the panel keeps it clear of the top bar.
  useEffect(() => {
    if (window.location.hash !== "#reckoning-recap") return;
    document.getElementById("reckoning-recap")?.scrollIntoView({ block: "start" });
  }, []);

  // The recap reloads whenever the selected week changes; League Intel, providers, and the spice
  // dial each load once and are deliberately not coupled to award availability.
  useEffect(() => {
    if (demo) {
      setRecap({ state: "ready", response: demoRecapFor(selectedWeek) });
      return;
    }
    if (!leagueId) return;
    setRecap({ state: "loading" });
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/v1/leagues/${leagueId}/recap?week=${selectedWeek}`,
          {
            credentials: "include",
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          setRecap({
            state: "error",
            message: await problemMessage(
              response,
              `The recap could not be loaded (${response.status}).`,
            ),
          });
          return;
        }
        const parsed = parseLeagueRecap(await response.json());
        setRecap(
          parsed
            ? { state: "ready", response: parsed }
            : { state: "error", message: "The recap response failed validation." },
        );
      } catch {
        if (!controller.signal.aborted) {
          setRecap({ state: "error", message: "The recap could not be loaded." });
        }
      }
    })();
    return () => controller.abort();
  }, [demo, leagueId, selectedWeek, reloadToken]);

  useEffect(() => {
    if (demo) {
      setCards(demoRecapPersonaCards);
      setCardsMessage(null);
      return;
    }
    if (!managesLeagueIntel) {
      setCards(null);
      setCardsMessage(null);
      setDrafts({});
      return;
    }
    if (!leagueId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/persona-cards`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          setCardsMessage(
            await problemMessage(
              response,
              `League Intel could not be loaded (${response.status}).`,
            ),
          );
          return;
        }
        const parsed = parseRecapPersonaCards(await response.json());
        setCards(parsed);
        setCardsMessage(parsed ? null : "The League Intel response failed validation.");
      } catch {
        if (!controller.signal.aborted) setCardsMessage("League Intel could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [demo, leagueId, managesLeagueIntel]);

  useEffect(() => {
    if (demo || !leagueId) return;
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/ai/providers`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const parsed = parseAiProviderList(await response.json());
        if (!parsed || controller.signal.aborted) return;
        setProviders(parsed.providers);
        const includedGemini = parsed.providers.find(
          (provider) => provider.provider === "gemini" && provider.available,
        );
        const firstAvailable = parsed.providers.find((provider) => provider.available);
        setSelectedProvider(includedGemini?.provider ?? firstAvailable?.provider ?? "gemini");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [demo, leagueId]);

  const generation = recap.state === "ready" ? recap.response.generation : null;
  const waitSeconds =
    generation && (generation.state === "in-progress" || generation.state === "cooldown")
      ? generation.retryAfterSeconds
      : null;
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(waitSeconds);

  useEffect(() => {
    setRemainingSeconds(waitSeconds);
  }, [waitSeconds]);

  // A wait is a countdown, never a permanent failure: when it elapses the panel reloads itself.
  useEffect(() => {
    if (demo || remainingSeconds === null) return;
    if (remainingSeconds <= 0) {
      setReloadToken((token) => token + 1);
      return;
    }
    const timer = window.setTimeout(
      () => setRemainingSeconds((seconds) => (seconds === null ? null : seconds - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [demo, remainingSeconds]);

  const stored = recap.state === "ready" ? recap.response.recap : null;
  const configuredSpiceLevel =
    recap.state === "ready" ? recap.response.configuredSpiceLevel : "medium";

  const generate = useCallback(async () => {
    if (generating) return;
    if (
      stored &&
      !window.confirm(`Replace the shared Week ${selectedWeek} recap for the league?`)
    ) {
      return;
    }
    if (demo) {
      setActionError(null);
      setRecap({ state: "ready", response: demoRecapFor(selectedWeek) });
      return;
    }
    setGenerating(true);
    setActionError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/recap`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          week: selectedWeek,
          ...(availableProviders.length > 0 ? { provider: selectedProvider } : {}),
        }),
      });
      if (!response.ok) {
        setActionError(
          await problemMessage(response, `The recap could not be generated (${response.status}).`),
        );
        // An in-progress or cooldown answer is state, not an error: re-read so the wait shows.
        if (response.status === 409 || response.status === 429) setReloadToken((t) => t + 1);
        return;
      }
      const parsed = parseLeagueRecap(await response.json());
      if (!parsed) {
        setActionError("The generated recap failed validation.");
        return;
      }
      setRecap({ state: "ready", response: parsed });
    } catch {
      setActionError("The recap could not be generated.");
    } finally {
      setGenerating(false);
    }
  }, [
    availableProviders.length,
    demo,
    generating,
    leagueId,
    selectedProvider,
    selectedWeek,
    stored,
  ]);

  async function copyRecap(body: string) {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setActionError("Copy was blocked by the browser. Select the recap text manually.");
    }
  }

  async function saveCard(teamId: string) {
    const draft = (drafts[teamId] ?? "").trim();
    if (!draft || pendingTeamId) return;
    setPendingTeamId(teamId);
    setActionError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/persona-cards/${teamId}`, {
        method: "PUT",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft }),
      });
      if (!response.ok) {
        setActionError(
          await problemMessage(response, `The Intel note could not be saved (${response.status}).`),
        );
        return;
      }
      // The server's read-back carries the real timestamp and updater; the browser guesses neither.
      const saved = parseRecapPersonaCards({
        leagueId,
        cards: [await response.json()],
      })?.cards[0];
      if (!saved) {
        setActionError("The saved Intel note failed validation.");
        return;
      }
      setCards((current) =>
        current
          ? {
              ...current,
              cards: current.cards.map((card) => (card.teamId === teamId ? saved : card)),
            }
          : current,
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[teamId];
        return next;
      });
    } catch {
      setActionError("The Intel note could not be saved.");
    } finally {
      setPendingTeamId(null);
    }
  }

  async function clearCard(teamId: string) {
    if (pendingTeamId) return;
    setPendingTeamId(teamId);
    setActionError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/persona-cards/${teamId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        setActionError(
          await problemMessage(
            response,
            `The Intel note could not be cleared (${response.status}).`,
          ),
        );
        return;
      }
      setCards((current) =>
        current
          ? {
              ...current,
              cards: current.cards.map((card) =>
                card.teamId === teamId
                  ? { ...card, body: null, updatedAt: null, updatedByDisplayName: null }
                  : card,
              ),
            }
          : current,
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[teamId];
        return next;
      });
    } catch {
      setActionError("The Intel note could not be cleared.");
    } finally {
      setPendingTeamId(null);
    }
  }

  async function saveSpice(next: RecapSpiceLevel) {
    if (savingSpice || recap.state !== "ready") return;
    setSavingSpice(true);
    setActionError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues/${leagueId}/recap-settings`, {
        method: "PUT",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ spiceLevel: next }),
      });
      if (!response.ok) {
        setActionError(
          await problemMessage(
            response,
            `The spice level could not be saved (${response.status}).`,
          ),
        );
        return;
      }
      const settings = parseRecapSettings(await response.json());
      if (!settings) {
        setActionError("The saved spice level failed validation.");
        return;
      }
      setRecap((current) =>
        current.state === "ready"
          ? {
              state: "ready",
              response: { ...current.response, configuredSpiceLevel: settings.spiceLevel },
            }
          : current,
      );
    } catch {
      setActionError("The spice level could not be saved.");
    } finally {
      setSavingSpice(false);
    }
  }

  const unavailableReasons =
    generation?.state === "unavailable"
      ? generation.reasons.map((reason) => reason.message)
      : recapUnavailableReasons(snapshot.weeklyAwards);
  const canGenerate =
    canGenerateRecap(membership) && (generation === null || generation.state === "available");
  const noProvider = !demo && providers.length > 0 && availableProviders.length === 0;

  return (
    <section id="reckoning-recap" className={styles.panel} aria-labelledby="reckoning-recap-title">
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>
          <Megaphone size={18} aria-hidden="true" />
        </span>
        <div>
          <p>Group-chat ready</p>
          <h2 id="reckoning-recap-title">The Recap</h2>
        </div>
        <span className={styles.sectionTag}>Week {selectedWeek}</span>
      </header>

      <div className={styles.body}>
        <div className={styles.controls}>
          {weeks.length > 0 ? (
            <label className={styles.control}>
              <span>Week</span>
              <select
                value={selectedWeek}
                onChange={(event) => setSelectedWeek(Number(event.target.value))}
              >
                {weeks.map((week) => (
                  <option value={week} key={week}>
                    Week {week}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {!demo && availableProviders.length > 1 ? (
            <label className={styles.control}>
              <span>Provider</span>
              <select
                value={selectedProvider}
                onChange={(event) => setSelectedProvider(event.target.value as AiProviderName)}
              >
                {availableProviders.map((provider) => (
                  <option value={provider.provider} key={provider.provider}>
                    {PROVIDER_LABELS[provider.provider]} · {provider.model}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {canEditSpice(membership) ? (
            <label className={styles.control}>
              <span>
                <Flame size={13} aria-hidden="true" /> Spice
              </span>
              <select
                value={configuredSpiceLevel}
                disabled={demo || savingSpice || recap.state !== "ready"}
                onChange={(event) => {
                  const parsed = recapSpiceLevelSchema.safeParse(event.target.value);
                  if (parsed.success) void saveSpice(parsed.data);
                }}
              >
                <option value="mild">{SPICE_LABELS.mild}</option>
                <option value="medium">{SPICE_LABELS.medium}</option>
                <option value="scorched">{SPICE_LABELS.scorched}</option>
              </select>
            </label>
          ) : (
            <span className={styles.readOnlySpice}>
              <Flame size={13} aria-hidden="true" /> Spice: {SPICE_LABELS[configuredSpiceLevel]}
            </span>
          )}
        </div>

        {configuredSpiceLevel === "medium" ? (
          <p className={styles.notice}>
            Medium is uncensored and NSFW by design. Expect profanity, crude jokes, and
            inappropriate locker-room humor. Slurs, protected traits, threats, and anything private
            remain off limits.
          </p>
        ) : configuredSpiceLevel === "scorched" ? (
          <p className={styles.notice}>
            Scorched is the uncensored, shock-and-awe roast. Fantasy personas, egos, league history,
            decisions, and humiliating results are fair game. Slurs, protected traits, threats, and
            anything private remain off limits.
          </p>
        ) : null}

        {recap.state === "loading" ? (
          <p className={styles.status} role="status">
            <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> Loading the recap…
          </p>
        ) : recap.state === "error" ? (
          <p className={styles.muted}>{recap.message}</p>
        ) : stored ? (
          <>
            <p className={styles.byline}>{recapByline(stored)}</p>
            <div className={styles.answer}>
              <AiAnswerContent answer={stored.body} />
            </div>
          </>
        ) : (
          <p className={styles.muted}>
            No recap has been written for week {selectedWeek} yet.
            {unavailableReasons.length > 0 ? ` ${unavailableReasons.join(" ")}` : ""}
          </p>
        )}

        {generation?.state === "in-progress" ? (
          <p className={styles.status} role="status">
            <LoaderCircle className={styles.spin} size={16} aria-hidden="true" /> Another member is
            writing this recap. Checking back in {Math.max(0, remainingSeconds ?? 0)}s.
          </p>
        ) : generation?.state === "cooldown" ? (
          <p className={styles.status} role="status">
            Rerolls reopen in {Math.max(0, remainingSeconds ?? 0)}s.
          </p>
        ) : generation?.state === "unavailable" && stored ? (
          <p className={styles.muted}>{unavailableReasons.join(" ")}</p>
        ) : null}

        <div className={styles.actions}>
          {canGenerateRecap(membership) ? (
            <button
              type="button"
              className="button button--small"
              disabled={generating || !canGenerate}
              onClick={() => void generate()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {generating ? "Writing…" : stored ? "Reroll the recap" : "Write the recap"}
            </button>
          ) : null}
          {stored ? (
            <button
              type="button"
              className="button button--outline button--small"
              onClick={() => void copyRecap(stored.body)}
            >
              <Clipboard size={14} aria-hidden="true" />
              {copied ? "Copied" : "Copy for the chat"}
            </button>
          ) : null}
          {noProvider ? (
            <Link className={styles.settingsLink} href="/settings">
              Add an AI provider to write the recap
            </Link>
          ) : !demo ? (
            <Link className={styles.settingsLink} href="/settings">
              Provider and model settings
            </Link>
          ) : null}
        </div>

        {actionError ? (
          <p className={styles.error} role="alert">
            {actionError}
          </p>
        ) : null}

        {(demo || managesLeagueIntel) && cards ? (
          <details className={styles.cards}>
            <summary>League Intel</summary>
            <p className={styles.muted}>
              {demo
                ? "Sample commissioner notes the recap writer uses for voice, history, and rivalries. They never change a stat, a result, or an award."
                : "Private commissioner notes the recap writer uses for voice, history, and rivalries. They never change a stat, a result, or an award. Only league owners and commissioners can view or edit them."}
            </p>
            <ul className={styles.cardList}>
              {cards.cards.map((card) => {
                const editable = !demo && managesLeagueIntel;
                const draft = drafts[card.teamId] ?? card.body ?? "";
                return (
                  <li key={card.teamId} className={styles.card}>
                    <strong>{card.teamName}</strong>
                    {editable ? (
                      <>
                        <textarea
                          value={draft}
                          maxLength={PERSONA_CARD_MAX_LENGTH}
                          placeholder="Rivalries, running bits, league history, what stings."
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [card.teamId]: event.target.value,
                            }))
                          }
                        />
                        <div className={styles.cardMeta}>
                          <span>
                            {draft.length}/{PERSONA_CARD_MAX_LENGTH}
                          </span>
                          <span className={styles.cardButtons}>
                            <button
                              type="button"
                              className="button button--outline button--small"
                              disabled={pendingTeamId === card.teamId || !draft.trim()}
                              onClick={() => void saveCard(card.teamId)}
                            >
                              {pendingTeamId === card.teamId ? "Saving…" : "Save Intel"}
                            </button>
                            {card.body ? (
                              <button
                                type="button"
                                className="button button--outline button--small"
                                disabled={pendingTeamId === card.teamId}
                                onClick={() => void clearCard(card.teamId)}
                              >
                                <Trash2 size={13} aria-hidden="true" /> Clear
                              </button>
                            ) : null}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className={styles.muted}>{card.body ?? "No Intel written yet."}</p>
                    )}
                    {card.updatedByDisplayName ? (
                      <small className={styles.muted}>
                        Last edited by {card.updatedByDisplayName}
                      </small>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : (demo || managesLeagueIntel) && cardsMessage ? (
          <p className={styles.muted}>{cardsMessage}</p>
        ) : null}
      </div>
    </section>
  );
}
