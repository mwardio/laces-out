"use client";

import type {
  AiAnalysisResponse,
  AiProviderConfiguration,
  AiProviderName,
  LeagueListResponse,
} from "@fantasy/contracts";
import {
  AlertCircle,
  ArrowUpRight,
  BrainCircuit,
  Check,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  LoaderCircle,
  Save,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  apiBaseUrl,
  parseAiAnalysis,
  parseAiProviderConfiguration,
  parseAiProviderList,
  parseLeagueListResponse,
} from "../lib/api-client";
import { aiModelOptions, customModelOption, isKnownAiModel } from "../lib/ai-model-options";
import { DEMO_LEAGUE_ID } from "../lib/demo-contract-data";
import { AiAnswerContent } from "./ai-answer-content";
import { AiCoachPanel } from "./ai-coach-panel";
import styles from "./film-room-workbench.module.css";

const PROVIDERS: Readonly<
  Record<
    AiProviderName,
    {
      readonly name: string;
      readonly shortName: string;
      readonly description: string;
      readonly keyUrl: string;
    }
  >
> = {
  openai: {
    name: "OpenAI",
    shortName: "OA",
    description: "Native Responses API",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "Anthropic",
    shortName: "AN",
    description: "Native Claude Messages API",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    name: "Google Gemini",
    shortName: "G",
    description: "Native Interactions API",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  openrouter: {
    name: "OpenRouter",
    shortName: "OR",
    description: "One key, broad model catalog",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
};

const QUICK_QUESTIONS = [
  "What are my three highest-leverage moves this week?",
  "Explain my best waiver priorities and who I can drop.",
  "Which realistic trade improves my weakest position?",
] as const;

type LoadState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | {
      readonly state: "ready";
      readonly providers: readonly AiProviderConfiguration[];
      readonly leagues: LeagueListResponse;
    };

type ActionState =
  | { readonly state: "idle" }
  | { readonly state: "saving" | "testing" | "deleting" | "analyzing" }
  | { readonly state: "success"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // The status-aware fallback remains safe for an empty response.
  }
  return `${fallback} (${response.status})`;
}

function statusLabel(provider: AiProviderConfiguration): string {
  if (provider.accessMode === "managed") return "Included";
  if (!provider.configured) return "Add a key";
  if (provider.status === "invalid") return "Key rejected";
  if (provider.lastValidatedAt) return "Verified";
  return "Saved · untested";
}

function readableTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function FilmRoomTour() {
  return (
    <div className={styles.page}>
      <div className={styles.tourNotice} role="status">
        <BrainCircuit size={17} />
        <span>
          <strong>Locker room tour</strong>
          Illustrative grounded answer. No provider request or API charge occurs in tour mode.
        </span>
      </div>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Private intelligence layer</p>
          <h1>Film Room</h1>
          <p>
            Ask why a recommendation leads the board. Included Gemini explains the deterministic
            calls already calculated from your league, and a personal key remains optional.
          </p>
        </div>
        <div className={styles.securityChip}>
          <ShieldCheck size={18} />
          <span>
            <strong>Included Gemini</strong>
            <small>BYOK remains optional</small>
          </span>
        </div>
      </header>
      <section className={styles.boundary} aria-label="AI trust boundaries">
        <div>
          <KeyRound size={18} />
          <span>
            <strong>Ready out of the box</strong>
            <small>Gemini 3.6 Flash is included after sign-in.</small>
          </span>
        </div>
        <div>
          <BrainCircuit size={18} />
          <span>
            <strong>Grounded, not autonomous</strong>
            <small>Models explain the league engine&apos;s results.</small>
          </span>
        </div>
        <div>
          <Gauge size={18} />
          <span>
            <strong>Optional model choice</strong>
            <small>Bring a key to choose a model and independent limits.</small>
          </span>
        </div>
      </section>
      <div className={styles.providerTabs} role="list" aria-label="Supported AI providers">
        {(Object.keys(PROVIDERS) as AiProviderName[]).map((provider) => {
          const meta = PROVIDERS[provider];
          const included = provider === "gemini";
          return (
            <div
              className={`${styles.providerTab} ${styles[provider]}`}
              key={provider}
              role="listitem"
            >
              <span className={styles.providerMark}>{meta.shortName}</span>
              <span className={styles.providerCopy}>
                <strong>{meta.name}</strong>
                <small>{included ? "Included and ready" : "Available with your key"}</small>
              </span>
              <span
                className={`${styles.statusDot}${included ? ` ${styles.statusReady}` : ""}`}
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
      <div className={styles.mainGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>Provider setup</p>
              <h2>Google Gemini</h2>
              <span>Included access · Native Interactions API</span>
            </div>
            <span className={styles.tourTag}>Sample</span>
          </div>
          <div className={styles.settingsForm}>
            <label className={styles.field}>
              <span>API key</span>
              <input value="Not required for included access" readOnly />
              <small>Add a personal key only to select another model.</small>
            </label>
            <label className={styles.field}>
              <span>Model ID</span>
              <input value="gemini-3.6-flash" readOnly />
            </label>
            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span>Requests per day</span>
                <input value="50" readOnly />
              </label>
              <label className={styles.field}>
                <span>Max answer tokens</span>
                <input value="2000" readOnly />
              </label>
            </div>
            <div className={styles.usageLine}>
              <span>
                <strong>50</strong> requests left today
              </span>
              <span>0 of 50 used</span>
            </div>
          </div>
        </section>
        <section className={`${styles.panel} ${styles.analysisPanel}`}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>League-grounded analysis</p>
              <h2>Ask the film room</h2>
              <span>Overview, Decision Desk, and analytics are included.</span>
            </div>
          </div>
          <div className={styles.analysisForm}>
            <label className={styles.field}>
              <span>League</span>
              <input value="North Loop Auction · ESPN" readOnly />
            </label>
            <label className={styles.field}>
              <span>Your question</span>
              <textarea value="What are my three highest-leverage moves this week?" readOnly />
            </label>
            <div className={styles.tourAsk}>
              <span>This is a sample question. Sign in to ask your own.</span>
              <Link className={styles.tourAskLink} href="/login">
                Sign in
              </Link>
            </div>
          </div>
          <div className={styles.answerRegion}>
            <article className={styles.answer}>
              <div className={styles.answerMeta}>
                <span>Included Gemini · sample answer</span>
                <span>No provider request</span>
              </div>
              <h3>North Loop Auction</h3>
              <ol className={styles.sampleRecommendations}>
                <li>
                  <span>01</span>
                  <div>
                    <strong>Start Quentin Johnston in FLEX</strong>
                    <p>The Decision Desk models a 1.5-point edge over Mike Evans.</p>
                    <small>Decision Desk</small>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>Bid up to $8 for Jaylen Wright</strong>
                    <p>Drop the second defense to add contingent running-back upside.</p>
                    <small>Decision Desk</small>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>Open an Evans-for-Gibbs conversation</strong>
                    <p>The sample trade improves both optimized rosters and fills your RB need.</p>
                    <small>Decision Desk · League Analytics</small>
                  </div>
                </li>
              </ol>
              <p className={styles.sampleVerification}>
                Before kickoff, confirm player locks and the projection timestamp, then make only
                the moves that fit your risk tolerance.
              </p>
              <footer>
                <p>
                  Grounded in Laces Out’s own computed league data (overview, Decision Desk, and
                  analytics), not the model’s outside knowledge.
                </p>
              </footer>
            </article>
          </div>
        </section>
      </div>
      <AiCoachPanel
        leagueId={DEMO_LEAGUE_ID}
        features={[
          "weekly-brief",
          "start-sit",
          "waiver-scan",
          "trade-builder",
          "standings-prediction",
        ]}
        demo
        eyebrow="Purpose-built reviews"
        title="Five ways to read the league"
        description="Choose a job instead of writing a prompt. Each review is grounded in the same deterministic league board."
      />
    </div>
  );
}

export function FilmRoomWorkbench() {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [selectedProvider, setSelectedProvider] = useState<AiProviderName>("gemini");
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("");
  const [dailyRequestLimit, setDailyRequestLimit] = useState("25");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2000");
  const [question, setQuestion] = useState<string>(QUICK_QUESTIONS[0]);
  const [settingsAction, setSettingsAction] = useState<ActionState>({ state: "idle" });
  const [analysisAction, setAnalysisAction] = useState<ActionState>({ state: "idle" });
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const loadData = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const [providerResponse, leagueResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/v1/ai/providers`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }),
        fetch(`${apiBaseUrl}/v1/leagues`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }),
      ]);
      if (providerResponse.status === 401 || leagueResponse.status === 401) {
        setLoad({ state: "signed-out" });
        return;
      }
      if (!providerResponse.ok) {
        throw new Error(await responseMessage(providerResponse, "Could not load AI providers"));
      }
      if (!leagueResponse.ok) {
        throw new Error(await responseMessage(leagueResponse, "Could not load leagues"));
      }
      const providerPayload: unknown = await providerResponse.json();
      const leaguePayload: unknown = await leagueResponse.json();
      const providers = parseAiProviderList(providerPayload);
      const leagues = parseLeagueListResponse(leaguePayload);
      if (!providers || !leagues) throw new Error("The Film room response was not recognized");
      setLoad({ state: "ready", providers: providers.providers, leagues });
      const firstAvailable = providers.providers.find((provider) => provider.available);
      setSelectedProvider((current) => {
        const currentProvider = providers.providers.find(
          (provider) => provider.provider === current,
        );
        return currentProvider?.available ? current : (firstAvailable?.provider ?? "gemini");
      });
      setSelectedLeagueId((current) =>
        leagues.leagues.some((league) => league.id === current)
          ? current
          : (leagues.leagues[0]?.id ?? ""),
      );
    } catch (error) {
      setLoad({
        state: "error",
        message: error instanceof Error ? error.message : "Could not open the Film room",
      });
    }
  }, []);

  useEffect(() => void loadData(), [loadData]);

  const currentProvider = useMemo(
    () =>
      load.state === "ready"
        ? load.providers.find((provider) => provider.provider === selectedProvider)
        : undefined,
    [load, selectedProvider],
  );

  const providerName = currentProvider?.provider;
  const providerAccessMode = currentProvider?.accessMode;
  const providerConfigured = currentProvider?.configured;
  const providerModel = currentProvider?.model;
  const providerDailyRequestLimit = currentProvider?.dailyRequestLimit;
  const providerMaxOutputTokens = currentProvider?.maxOutputTokens;

  useEffect(() => {
    if (
      !providerName ||
      !providerAccessMode ||
      providerConfigured === undefined ||
      !providerModel ||
      providerDailyRequestLimit === undefined ||
      providerMaxOutputTokens === undefined
    ) {
      return;
    }
    setModel(providerModel);
    setDailyRequestLimit(String(providerDailyRequestLimit));
    setMaxOutputTokens(String(providerMaxOutputTokens));
    setApiKey("");
    setShowKey(false);
    setDeleteArmed(false);
  }, [
    providerAccessMode,
    providerConfigured,
    providerDailyRequestLimit,
    providerMaxOutputTokens,
    providerModel,
    providerName,
  ]);

  const settingsDirty = useMemo(() => {
    if (!currentProvider) return false;
    return (
      apiKey.trim().length > 0 ||
      model.trim() !== currentProvider.model ||
      dailyRequestLimit !== String(currentProvider.dailyRequestLimit) ||
      maxOutputTokens !== String(currentProvider.maxOutputTokens)
    );
  }, [apiKey, currentProvider, dailyRequestLimit, maxOutputTokens, model]);

  useEffect(() => {
    if (!settingsDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [settingsDirty]);

  const selectProvider = (provider: AiProviderName) => {
    if (provider === selectedProvider) return;
    if (
      settingsDirty &&
      !window.confirm("Discard your unsaved provider changes and switch providers?")
    ) {
      return;
    }
    setSettingsAction({ state: "idle" });
    setDeleteArmed(false);
    setSelectedProvider(provider);
  };

  const resetSettings = () => {
    if (!currentProvider) return;
    setApiKey("");
    setShowKey(false);
    setModel(currentProvider.model);
    setDailyRequestLimit(String(currentProvider.dailyRequestLimit));
    setMaxOutputTokens(String(currentProvider.maxOutputTokens));
    setDeleteArmed(false);
    setSettingsAction({ state: "idle" });
  };

  const replaceProvider = (configuration: AiProviderConfiguration) => {
    setLoad((current) =>
      current.state === "ready"
        ? {
            ...current,
            providers: current.providers.map((provider) =>
              provider.provider === configuration.provider ? configuration : provider,
            ),
          }
        : current,
    );
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    setSettingsAction({ state: "saving" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            model: model.trim(),
            dailyRequestLimit: Number(dailyRequestLimit),
            maxOutputTokens: Number(maxOutputTokens),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseMessage(response, "Could not save provider"));
      const parsed = parseAiProviderConfiguration(await response.json());
      if (!parsed) throw new Error("The saved provider response was not recognized");
      replaceProvider(parsed);
      setApiKey("");
      setModel(parsed.model);
      setDailyRequestLimit(String(parsed.dailyRequestLimit));
      setMaxOutputTokens(String(parsed.maxOutputTokens));
      setSettingsAction({
        state: "success",
        message: apiKey.trim()
          ? "Key encrypted and settings saved. Run the connection test next."
          : "Provider settings saved.",
      });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Could not save provider",
      });
    }
  };

  const testConnection = async () => {
    setSettingsAction({ state: "testing" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}/test`,
        { method: "POST", credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Connection test failed"));
      }
      await loadData();
      setSelectedProvider(selectedProvider);
      setSettingsAction({ state: "success", message: "Connection verified with a live request." });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Connection test failed",
      });
    }
  };

  const removeProvider = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      setSettingsAction({ state: "idle" });
      return;
    }
    setSettingsAction({ state: "deleting" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}`,
        { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error(await responseMessage(response, "Could not remove key"));
      await loadData();
      setSelectedProvider(selectedProvider);
      setDeleteArmed(false);
      setSettingsAction({ state: "success", message: "The encrypted key was removed." });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Could not remove key",
      });
    }
  };

  const runAnalysis = async (event: FormEvent) => {
    event.preventDefault();
    setAnalysisAction({ state: "analyzing" });
    setAnalysis(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/ai/analyze`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          leagueId: selectedLeagueId,
          question: question.trim(),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "Analysis failed"));
      const parsed = parseAiAnalysis(await response.json());
      if (!parsed) throw new Error("The analysis response was not recognized");
      setAnalysis(parsed);
      setAnalysisAction({ state: "idle" });
      setLoad((current) => {
        if (current.state !== "ready") return current;
        return {
          ...current,
          providers: current.providers.map((provider) =>
            provider.provider === selectedProvider
              ? {
                  ...provider,
                  requestsToday: provider.requestsToday + 1,
                  requestsRemaining: Math.max(0, provider.requestsRemaining - 1),
                }
              : provider,
          ),
        };
      });
    } catch (error) {
      setAnalysisAction({
        state: "error",
        message: error instanceof Error ? error.message : "Analysis failed",
      });
    }
  };

  if (load.state === "loading") {
    return (
      <div className={styles.statePanel}>
        <LoaderCircle className={styles.spin} size={22} />
        <strong>Opening the Film room</strong>
        <span>Loading private provider settings and league access.</span>
      </div>
    );
  }

  if (load.state === "signed-out") {
    return <FilmRoomTour />;
  }

  if (load.state === "error") {
    return (
      <div className={`${styles.statePanel} ${styles.errorState}`}>
        <AlertCircle size={23} />
        <strong>Film room unavailable</strong>
        <span>{load.message}</span>
        <button className={styles.secondaryButton} type="button" onClick={() => void loadData()}>
          Try again
        </button>
      </div>
    );
  }

  const providerMeta = PROVIDERS[selectedProvider];
  const hasLeagues = load.leagues.leagues.length > 0;
  const byokControlsEnabled = Boolean(currentProvider?.configured || apiKey.trim());
  const providerModelOptions = aiModelOptions[selectedProvider];
  const selectedModelOption = isKnownAiModel(selectedProvider, model) ? model : customModelOption;
  const canAnalyze = Boolean(currentProvider?.available && selectedLeagueId && question.trim());
  const settingsBusy =
    settingsAction.state === "saving" ||
    settingsAction.state === "testing" ||
    settingsAction.state === "deleting";

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Private intelligence layer</p>
          <h1>Film Room</h1>
          <p>
            Ask why a recommendation leads the board. Included Gemini works without setup; add an
            OpenAI, Anthropic, Gemini, or OpenRouter key only to choose the model and use
            independent limits. No prompts or answers are stored.
          </p>
        </div>
        <div className={styles.securityChip}>
          <ShieldCheck size={18} />
          <span>
            <strong>Gemini included</strong>
            <small>Personal keys stay optional</small>
          </span>
        </div>
      </header>

      <section className={styles.boundary} aria-label="AI trust boundaries">
        <div>
          <KeyRound size={18} />
          <span>
            <strong>Ready out of the box</strong>
            <small>Gemini 3.6 Flash uses the included key.</small>
          </span>
        </div>
        <div>
          <BrainCircuit size={18} />
          <span>
            <strong>Grounded, not autonomous</strong>
            <small>Models explain deterministic league recommendations.</small>
          </span>
        </div>
        <div>
          <Gauge size={18} />
          <span>
            <strong>Bring your own model</strong>
            <small>A personal key unlocks model choice and independent limits.</small>
          </span>
        </div>
      </section>

      <div className={styles.providerTabs} role="tablist" aria-label="AI providers">
        {load.providers.map((provider) => {
          const meta = PROVIDERS[provider.provider];
          const selected = provider.provider === selectedProvider;
          return (
            <button
              key={provider.provider}
              className={`${styles.providerTab} ${styles[provider.provider]}${selected ? ` ${styles.selected}` : ""}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="provider-settings-panel"
              id={`provider-tab-${provider.provider}`}
              onClick={() => selectProvider(provider.provider)}
            >
              <span className={styles.providerMark}>{meta.shortName}</span>
              <span className={styles.providerCopy}>
                <strong>{meta.name}</strong>
                <small>{statusLabel(provider)}</small>
              </span>
              <span
                className={`${styles.statusDot}${provider.available ? ` ${styles.statusReady}` : ""}${provider.status === "invalid" ? ` ${styles.statusInvalid}` : ""}`}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      <div className={styles.mainGrid}>
        <section
          className={styles.panel}
          id="provider-settings-panel"
          role="tabpanel"
          aria-labelledby={`provider-tab-${selectedProvider}`}
        >
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>
                {currentProvider?.configured ? "Your provider setup" : "Optional BYOK setup"}
              </p>
              <h2 id="provider-settings-heading">{providerMeta.name}</h2>
              <span>{providerMeta.description}</span>
            </div>
            <a href={providerMeta.keyUrl} target="_blank" rel="noreferrer">
              {currentProvider?.accessMode === "managed" ? "Get personal key" : "Get API key"}
              <ArrowUpRight size={14} />
            </a>
          </div>

          <form className={styles.settingsForm} onSubmit={(event) => void saveSettings(event)}>
            {currentProvider?.accessMode === "managed" ? (
              <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
                <Check size={16} />
                <span>
                  Included Gemini is ready now. Adding your own key is optional and will replace the
                  included model for your account until you remove it. Included calls use the
                  host&apos;s Google AI Studio free-tier project and Google&apos;s free-tier data
                  terms.
                </span>
              </div>
            ) : null}
            <label className={styles.field}>
              <span>{currentProvider?.configured ? "Replace API key" : "API key"}</span>
              <div className={styles.secretField}>
                <input
                  aria-describedby="provider-key-help"
                  aria-invalid={currentProvider?.status === "invalid" || undefined}
                  name={`${selectedProvider}-api-key`}
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setDeleteArmed(false);
                    setSettingsAction({ state: "idle" });
                  }}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    currentProvider?.configured ? "Leave blank to keep the saved key" : "Paste key"
                  }
                  required={
                    !currentProvider?.configured && currentProvider?.accessMode !== "managed"
                  }
                />
                <button
                  type="button"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((current) => !current)}
                >
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <small id="provider-key-help">
                Optional. Personal keys are encrypted and never shown again. Provider API usage is
                billed to that key&apos;s account.
              </small>
            </label>

            <label className={styles.field}>
              <span>Model</span>
              <select
                value={selectedModelOption}
                onChange={(event) => {
                  setModel(event.target.value === customModelOption ? "" : event.target.value);
                  setSettingsAction({ state: "idle" });
                }}
                disabled={!byokControlsEnabled}
              >
                {providerModelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
                <option value={customModelOption}>Custom model ID…</option>
              </select>
              <small>
                {byokControlsEnabled
                  ? "Your key unlocks provider-specific model selection."
                  : "The included model is fixed. Add your own key to choose another model."}
              </small>
            </label>

            {selectedModelOption === customModelOption && byokControlsEnabled ? (
              <label className={styles.field}>
                <span>Custom model ID</span>
                <input
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setSettingsAction({ state: "idle" });
                  }}
                  minLength={1}
                  maxLength={160}
                  required
                  spellCheck={false}
                  placeholder="Enter the exact provider model ID"
                />
                <small>Use this for a model that is not yet listed above.</small>
              </label>
            ) : null}

            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span>Requests per day</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={dailyRequestLimit}
                  onChange={(event) => {
                    setDailyRequestLimit(event.target.value);
                    setSettingsAction({ state: "idle" });
                  }}
                  required
                  disabled={!byokControlsEnabled}
                />
              </label>
              <label className={styles.field}>
                <span>Max answer tokens</span>
                <input
                  type="number"
                  min="64"
                  max="8192"
                  value={maxOutputTokens}
                  onChange={(event) => {
                    setMaxOutputTokens(event.target.value);
                    setSettingsAction({ state: "idle" });
                  }}
                  required
                  disabled={!byokControlsEnabled}
                />
              </label>
            </div>

            {currentProvider ? (
              <div className={styles.usageLine}>
                <span>
                  <strong>{currentProvider.requestsRemaining}</strong> requests left today
                </span>
                <span>
                  {currentProvider.requestsToday} of {currentProvider.dailyRequestLimit} used
                </span>
              </div>
            ) : null}

            {settingsAction.state === "success" || settingsAction.state === "error" ? (
              <div
                className={`${styles.notice} ${settingsAction.state === "error" ? styles.noticeError : styles.noticeSuccess}`}
                role={settingsAction.state === "error" ? "alert" : "status"}
              >
                {settingsAction.state === "error" ? <AlertCircle size={16} /> : <Check size={16} />}
                <span>{settingsAction.message}</span>
              </div>
            ) : null}

            <div className={styles.formActions}>
              <button
                className={styles.primaryButton}
                type="submit"
                disabled={settingsBusy || !settingsDirty}
              >
                {settingsAction.state === "saving" ? (
                  <LoaderCircle className={styles.spin} size={16} />
                ) : (
                  <Save size={16} />
                )}
                {settingsAction.state === "saving"
                  ? "Saving securely"
                  : settingsDirty
                    ? "Save securely"
                    : "Settings saved"}
              </button>
              {settingsDirty ? (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={resetSettings}
                  disabled={settingsBusy}
                >
                  Undo changes
                </button>
              ) : (
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => void testConnection()}
                  disabled={!currentProvider?.configured || settingsBusy}
                >
                  {settingsAction.state === "testing" ? (
                    <LoaderCircle className={styles.spin} size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  {settingsAction.state === "testing" ? "Verifying key" : "Verify key"}
                </button>
              )}
            </div>

            {currentProvider?.configured ? (
              <div className={styles.removeRow}>
                <span>
                  {currentProvider.lastValidatedAt
                    ? `Last verified ${readableTime(currentProvider.lastValidatedAt)}`
                    : "Saved key has not been tested yet."}
                </span>
                <span className={styles.removeActions}>
                  {deleteArmed ? (
                    <button
                      className={styles.cancelRemoval}
                      type="button"
                      onClick={() => setDeleteArmed(false)}
                      disabled={settingsBusy}
                    >
                      Cancel
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void removeProvider()}
                    disabled={settingsBusy || settingsDirty}
                    title={
                      settingsDirty
                        ? "Undo or save your changes before removing this key"
                        : undefined
                    }
                  >
                    {settingsAction.state === "deleting" ? (
                      <LoaderCircle className={styles.spin} size={14} />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    {settingsAction.state === "deleting"
                      ? "Removing key"
                      : deleteArmed
                        ? "Yes, remove key"
                        : "Remove key"}
                  </button>
                </span>
              </div>
            ) : null}
          </form>
        </section>

        <section
          className={`${styles.panel} ${styles.analysisPanel}`}
          aria-labelledby="analysis-heading"
        >
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>League-grounded analysis</p>
              <h2 id="analysis-heading">Ask the film room</h2>
              <span>Overview, Decision Desk, and league analytics go in with every request.</span>
            </div>
          </div>

          <form className={styles.analysisForm} onSubmit={(event) => void runAnalysis(event)}>
            <label className={styles.field}>
              <span>League</span>
              <select
                value={selectedLeagueId}
                onChange={(event) => setSelectedLeagueId(event.target.value)}
                disabled={!hasLeagues}
              >
                {hasLeagues ? null : <option value="">Connect a league first</option>}
                {load.leagues.leagues.map((league) => (
                  <option key={league.id} value={league.id}>
                    {league.name}
                    {league.season ? ` · ${league.season.provider.toUpperCase()}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.quickQuestions} aria-label="Suggested questions">
              {QUICK_QUESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setQuestion(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>

            <label className={styles.field}>
              <span>Your question</span>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                minLength={3}
                maxLength={2_000}
                required
              />
            </label>

            {!currentProvider?.available ? (
              <div className={styles.inlineGate}>
                <KeyRound size={17} />
                <span>Save a {providerMeta.name} API key to analyze this league.</span>
              </div>
            ) : currentProvider.accessMode === "managed" ? (
              <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
                <Check size={16} />
                <span>Included Gemini is selected. No personal API key is required.</span>
              </div>
            ) : null}
            {!hasLeagues ? (
              <div className={styles.inlineGate}>
                <AlertCircle size={17} />
                <span>
                  <Link href="/connections">Connect Yahoo or ESPN</Link> before requesting league
                  analysis.
                </span>
              </div>
            ) : null}

            <button
              className={`${styles.primaryButton} ${styles.analyzeButton}`}
              type="submit"
              disabled={!canAnalyze || analysisAction.state === "analyzing"}
            >
              {analysisAction.state === "analyzing" ? (
                <LoaderCircle className={styles.spin} size={17} />
              ) : (
                <Send size={17} />
              )}
              {analysisAction.state === "analyzing" ? "Reviewing league data" : "Run analysis"}
            </button>

            {analysisAction.state === "error" ? (
              <div className={`${styles.notice} ${styles.noticeError}`} role="alert">
                <AlertCircle size={16} />
                <span>{analysisAction.message}</span>
              </div>
            ) : null}
          </form>

          <div className={styles.answerRegion} aria-live="polite">
            {analysisAction.state === "analyzing" ? (
              <div className={styles.emptyAnswer} aria-busy="true">
                <LoaderCircle className={styles.spin} size={25} aria-hidden="true" />
                <strong>Reading the whole league</strong>
                <span>Checking the answer against the latest saved decisions and analytics.</span>
              </div>
            ) : analysis ? (
              <article className={styles.answer}>
                <div className={styles.answerMeta}>
                  <span>
                    {PROVIDERS[analysis.provider].name} · {analysis.model}
                  </span>
                  <span>
                    {analysis.accessMode === "managed" ? "Included access" : "Your API key"}
                  </span>
                  <span>
                    {analysis.usage.inputTokens.toLocaleString()} in ·{" "}
                    {analysis.usage.outputTokens.toLocaleString()} out
                  </span>
                </div>
                <h3>{analysis.league.name}</h3>
                <div className={styles.answerText}>
                  <AiAnswerContent answer={analysis.answer} />
                </div>
                <footer>
                  <p>
                    Grounded in Laces Out’s own computed league data (overview, Decision Desk, and
                    analytics), not the model’s outside knowledge.
                  </p>
                </footer>
              </article>
            ) : analysisAction.state === "error" ? (
              <div className={styles.emptyAnswer} role="alert">
                <AlertCircle size={25} aria-hidden="true" />
                <strong>Analysis unavailable</strong>
                <span>{analysisAction.message}</span>
              </div>
            ) : (
              <div className={styles.emptyAnswer}>
                <BrainCircuit size={25} />
                <strong>Your answer will land here</strong>
                <span>
                  Models receive bounded, current league data. They receive no provider credentials
                  and no ability to change Yahoo or ESPN.
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
      {selectedLeagueId ? (
        <AiCoachPanel
          leagueId={selectedLeagueId}
          features={[
            "weekly-brief",
            "start-sit",
            "waiver-scan",
            "trade-builder",
            "standings-prediction",
          ]}
          eyebrow="Purpose-built reviews"
          title="Five ways to read the league"
          description="Choose a job instead of writing a prompt. Each review is grounded in the same deterministic league board."
        />
      ) : null}
    </div>
  );
}
