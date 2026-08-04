"use client";

import type {
  AiAnalysisResponse,
  AiProviderConfiguration,
  AiProviderName,
  LeagueListResponse,
} from "@fantasy/contracts";
import {
  AlertCircle,
  BrainCircuit,
  Check,
  Gauge,
  KeyRound,
  LoaderCircle,
  Megaphone,
  Send,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  apiBaseUrl,
  parseAiAnalysis,
  parseAiProviderList,
  parseLeagueListResponse,
} from "../lib/api-client";
import { AI_PROVIDER_META as PROVIDERS, AI_PROVIDER_ORDER } from "../lib/ai-provider-meta";
import { DEMO_LEAGUE_ID } from "../lib/demo-contract-data";
import { AiAnswerContent } from "./ai-answer-content";
import { AiCoachPanel } from "./ai-coach-panel";
import { AiProviderPicker } from "./ai-provider-picker";
import styles from "./film-room-workbench.module.css";

const QUICK_QUESTIONS = [
  "What are my three highest-leverage moves this week?",
  "Explain my best waiver priorities and who I can drop.",
  "Which realistic trade improves my weakest position?",
  "Write a scouting report roasting my opponent's roster this week.",
  "Write my victory speech — or my concession statement, whichever the projections support.",
  "Which manager in this league should be most embarrassed this week? Use the numbers.",
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
  | { readonly state: "analyzing" }
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

function FilmRoomTour() {
  const [tourProvider, setTourProvider] = useState<AiProviderName>("gemini");
  const tourProviderMeta = PROVIDERS[tourProvider];
  const tourUsesIncludedGemini = tourProvider === "gemini";

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
      <div className={styles.mainGrid}>
        <section className={`${styles.panel} ${styles.providerPanel}`}>
          <div className={styles.panelHeader}>
            <div>
              <p className={styles.eyebrow}>AI provider</p>
              <h2>Choose how Film Room answers</h2>
              <span>Keys and model preferences live in Settings.</span>
            </div>
            <span className={styles.tourTag}>Sample</span>
          </div>
          <div className={styles.providerPanelBody}>
            <AiProviderPicker
              options={AI_PROVIDER_ORDER.map((provider) => ({
                provider,
                detail: provider === "gemini" ? "Included and ready" : "Available with your key",
                state: provider === "gemini" ? "ready" : "idle",
              }))}
              value={tourProvider}
              onChange={setTourProvider}
            />
            <dl className={styles.providerFacts}>
              <div>
                <dt>Access</dt>
                <dd>{tourUsesIncludedGemini ? "Included" : "Personal key"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{tourUsesIncludedGemini ? "Gemini 3.6 Flash" : "Your choice"}</dd>
              </div>
              <div>
                <dt>Limits</dt>
                <dd>{tourUsesIncludedGemini ? "50 requests/day" : "Independent"}</dd>
              </div>
            </dl>
            <p className={styles.providerFootnote}>
              {tourUsesIncludedGemini
                ? "Ready after sign-in with no personal key."
                : `${tourProviderMeta.name} becomes available after you add a key in Settings.`}
            </p>
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
                <span>
                  {tourUsesIncludedGemini ? "Included Gemini" : tourProviderMeta.name} · sample
                  answer
                </span>
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
              <footer className={styles.answerGrounding}>
                <ShieldCheck size={13} aria-hidden="true" />
                <span>Grounded in your league&rsquo;s computed data</span>
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
      <ReckoningRecapCallout />
    </div>
  );
}

/**
 * The weekly recap is one shared, stored league artifact now, so the Film Room points at The
 * Weekly Reckoning instead of offering a second, ephemeral generator of the same thing.
 */
function ReckoningRecapCallout() {
  return (
    <section className={styles.recapCallout}>
      <Megaphone size={18} aria-hidden="true" />
      <div>
        <strong>The weekly recap lives in The Weekly Reckoning</strong>
        <p>
          One shared recap per week, kept for the league, personalized by League Intel and the
          commissioner&rsquo;s tone setting.
        </p>
      </div>
      <Link href="/analytics#reckoning-recap">Open The Weekly Reckoning</Link>
    </section>
  );
}

export function FilmRoomWorkbench() {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [selectedProvider, setSelectedProvider] = useState<AiProviderName>("gemini");
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const [question, setQuestion] = useState<string>(QUICK_QUESTIONS[0]);
  const [analysisAction, setAnalysisAction] = useState<ActionState>({ state: "idle" });
  const [analysis, setAnalysis] = useState<AiAnalysisResponse | null>(null);

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
  const canAnalyze = Boolean(currentProvider?.available && selectedLeagueId && question.trim());
  const availableProviders = load.providers.filter((provider) => provider.available);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Private intelligence layer</p>
          <h1>Film Room</h1>
          <p>
            Ask why a recommendation leads the board. Included Gemini works without setup; add an
            OpenAI, Anthropic, Gemini, DeepSeek, Grok, or OpenRouter key only to choose the model
            and use independent limits. No prompts or answers are stored.
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

      {currentProvider?.available ? (
        <section className={styles.providerControl} aria-label="AI provider">
          {availableProviders.length > 1 ? (
            <AiProviderPicker
              options={availableProviders.map((provider) => ({
                provider: provider.provider,
                detail:
                  provider.accessMode === "managed"
                    ? `Included · ${provider.model}`
                    : `Personal key · ${provider.model}`,
                state: provider.status === "invalid" ? "invalid" : "ready",
              }))}
              value={selectedProvider}
              onChange={setSelectedProvider}
            />
          ) : null}
          <div className={styles.providerControlStatus} role="status">
            <Check size={16} aria-hidden="true" />
            <span>
              <strong>
                {currentProvider.accessMode === "managed"
                  ? "Included Gemini is ready"
                  : `${providerMeta.name} is ready`}
              </strong>
              <small>
                {availableProviders.length > 1
                  ? "Switch here. Manage keys and models in Settings."
                  : `${currentProvider.model} · Manage keys and models in Settings.`}
              </small>
            </span>
            <Link href="/settings">Settings →</Link>
          </div>
        </section>
      ) : (
        <div className={styles.inlineGate}>
          <KeyRound size={17} aria-hidden="true" />
          <span>
            No AI provider is configured yet.{" "}
            <Link href="/settings">Manage AI provider in Settings →</Link>
          </span>
        </div>
      )}

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

        {/* Ask on the left, answer on the right — the same request/result split the coaching
            panel below already uses, so a full-width card stops stretching a single question
            field across the whole desktop viewport. Collapses to one column under 1000px. */}
        <div className={styles.analysisWorkArea}>
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
                {/* The grounding claim is made once per page. On Film Room that is the
                    "Grounded, not autonomous" chip in the trust strip above, which is why this
                    answer carries the shield marker instead of repeating the full sentence — the
                    coaching panel below would otherwise state it a second time on one screen. */}
                <footer className={styles.answerGrounding}>
                  <ShieldCheck size={13} aria-hidden="true" />
                  <span>Grounded in your league&rsquo;s computed data</span>
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
        </div>
      </section>
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
      <ReckoningRecapCallout />
    </div>
  );
}
