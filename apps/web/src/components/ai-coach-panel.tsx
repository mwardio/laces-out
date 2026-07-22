"use client";

import type {
  AiFeatureName,
  AiFeatureResponse,
  AiProviderConfiguration,
  AiProviderName,
} from "@fantasy/contracts";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  LoaderCircle,
  Scale,
  Sparkles,
  Trophy,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { apiBaseUrl, parseAiFeature, parseAiProviderList } from "../lib/api-client";
import { AiAnswerContent } from "./ai-answer-content";
import styles from "./ai-coach-panel.module.css";

interface FeatureMeta {
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly promptLabel: string;
  readonly promptPlaceholder: string;
}

const FEATURES: Readonly<Record<AiFeatureName, FeatureMeta>> = {
  "weekly-brief": {
    label: "Weekly Briefing",
    shortLabel: "Weekly Brief",
    description: "Your matchup, roster pressure points, and the one move that matters most.",
    icon: FileText,
    promptLabel: "Anything to account for?",
    promptPlaceholder: "Optional: I prefer floor over upside this week.",
  },
  "start-sit": {
    label: "Start / Sit Review",
    shortLabel: "Start / Sit",
    description: "Clear calls, close decisions, and stored injury, bye, eligibility, or lock risk.",
    icon: ClipboardCheck,
    promptLabel: "Decision preference",
    promptPlaceholder: "Optional: favor ceiling in close calls.",
  },
  "waiver-scan": {
    label: "Waiver Wire Scan",
    shortLabel: "Waiver Scan",
    description: "Only recommends an addition when it beats the player or spot it replaces.",
    icon: UserRoundPlus,
    promptLabel: "Roster preference",
    promptPlaceholder: "Optional: prioritize rest-of-season RB depth.",
  },
  "trade-builder": {
    label: "Trade Finder",
    shortLabel: "Trade Finder",
    description: "Ranks legal packages, tests both teams' incentives, and drafts the best pitch.",
    icon: Scale,
    promptLabel: "What are you trying to improve?",
    promptPlaceholder: "Optional: improve TE without moving my top two receivers.",
  },
  "standings-prediction": {
    label: "Final Standings Forecast",
    shortLabel: "Season Forecast",
    description: "Projected order, records, risers, fallers, and your playoff outlook.",
    icon: Trophy,
    promptLabel: "Forecast preference",
    promptPlaceholder: "Optional: emphasize roster strength over current record.",
  },
};

const PROVIDER_LABELS: Readonly<Record<AiProviderName, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

const DEMO_ANSWERS: Readonly<Record<AiFeatureName, string>> = {
  "weekly-brief":
    "Fourth & Long enters Week 6 at 4–1 with the league's second-strongest power score. Your opponent has the stronger projected WR group, but your RB advantage is meaningful.\n\n**One move:** Start Quentin Johnston in the FLEX for the modeled 1.5-point edge, then verify his status before lock.",
  "start-sit":
    "**The clear call:** Quentin Johnston over Mike Evans in FLEX. The current projection set gives Johnston a 1.5-point edge; the rest of the optimized lineup is unchanged.\n\n**Close call:** This margin is small enough to recheck after the next projection refresh. No stored lock prevents the switch, but complete provider lock coverage is unavailable.",
  "waiver-scan":
    "Jaylen Wright is the only addition that clears the worth-the-drop bar.\n\n- **Add:** Jaylen Wright\n- **Drop:** Your second defense\n- **Suggested bid:** Around $8\n\nThe pairing improves weighted roster value by 2.8 points while preserving a legal lineup. The remaining available players do not improve the roster enough to justify a drop.",
  "trade-builder":
    "**Best fit:** Send Mike Evans and receive Jahmyr Gibbs. The modeled package improves your optimized roster by 3.2 points and the other team by 0.8, while addressing your RB weakness without creating an illegal roster.\n\n> You get a weekly WR starter, and I balance out my RB room. The numbers are close for both sides—interested in Evans for Gibbs?",
  "standings-prediction":
    "### Model-assisted forecast\n1. Fourth & Long — 10–4\n2. Uptown Blitz — 9–5\n3. Lake Effect — 8–6\n4. Sunday Scaries — 8–6\n5. Goal Line Fade — 6–8\n6. Punt Intended — 5–9\n\n**Biggest riser:** Fourth & Long, driven by the league's best all-play profile and a top-two power score.\n\n**Biggest faller:** Sunday Scaries, whose record is running ahead of expected wins. Your playoff outlook is strong, with the current roster projecting as a top-two seed.",
};

type ResultState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly result: AiFeatureResponse };

export interface AiCoachPanelProps {
  readonly leagueId: string;
  readonly features: readonly AiFeatureName[];
  readonly demo?: boolean;
  readonly eyebrow?: string;
  readonly title?: string;
  readonly description?: string;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // Use the status-aware fallback below for empty or non-JSON responses.
  }
  return `The AI review could not be generated (${response.status}).`;
}

function demoResult(feature: AiFeatureName, leagueId: string): AiFeatureResponse {
  return {
    feature,
    outcome: "generated",
    provider: "gemini",
    accessMode: "managed",
    model: "gemini-3.6-flash",
    league: { id: leagueId, name: "Lakeview Auction" },
    title: FEATURES[feature].label,
    answer: DEMO_ANSWERS[feature],
    generatedAt: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0 },
    sources: ["League overview", "Decision Desk", "League analytics"],
  };
}

export function AiCoachPanel({
  leagueId,
  features,
  demo = false,
  eyebrow = "AI coaching",
  title = "Get the second read",
  description = "Deterministic league analysis sets the board. AI turns it into a clear recommendation.",
}: AiCoachPanelProps) {
  const [selectedFeature, setSelectedFeature] = useState<AiFeatureName>(
    features[0] ?? "weekly-brief",
  );
  const [instructions, setInstructions] = useState("");
  const [providers, setProviders] = useState<readonly AiProviderConfiguration[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderName>("gemini");
  const [result, setResult] = useState<ResultState>(() =>
    demo
      ? { state: "ready", result: demoResult(features[0] ?? "weekly-brief", leagueId) }
      : { state: "idle" },
  );

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.available),
    [providers],
  );
  const currentMeta = FEATURES[selectedFeature];
  const CurrentIcon = currentMeta.icon;

  useEffect(() => {
    if (demo) return;
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
  }, [demo]);

  useEffect(() => {
    setInstructions("");
    setResult(
      demo ? { state: "ready", result: demoResult(selectedFeature, leagueId) } : { state: "idle" },
    );
  }, [demo, leagueId, selectedFeature]);

  async function generate() {
    if (!leagueId || result.state === "loading") return;
    if (demo) {
      setResult({ state: "ready", result: demoResult(selectedFeature, leagueId) });
      return;
    }
    setResult({ state: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/features/${encodeURIComponent(selectedFeature)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: selectedProvider,
            leagueId,
            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      const parsed = parseAiFeature(await response.json());
      if (!parsed) throw new Error("The AI response failed validation.");
      setResult({ state: "ready", result: parsed });
    } catch (error) {
      setResult({
        state: "error",
        message: error instanceof Error ? error.message : "The AI review could not be generated.",
      });
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={`ai-coach-${features.join("-")}`}>
      <header className={styles.header}>
        <div>
          <p>{eyebrow}</p>
          <h2 id={`ai-coach-${features.join("-")}`}>{title}</h2>
          <span>{description}</span>
        </div>
        <div className={styles.fuelBadge}>
          <Sparkles size={15} aria-hidden="true" />
          <span>
            <strong>Fueled by Gemini</strong>
            <small>Included with your account</small>
          </span>
        </div>
      </header>

      <div className={styles.featureGrid} role="tablist" aria-label="AI coaching tools">
        {features.map((feature) => {
          const meta = FEATURES[feature];
          const Icon = meta.icon;
          const selected = selectedFeature === feature;
          return (
            <button
              className={selected ? styles.featureSelected : undefined}
              type="button"
              role="tab"
              aria-selected={selected}
              key={feature}
              onClick={() => setSelectedFeature(feature)}
            >
              <span className={styles.featureIcon}>
                <Icon size={17} aria-hidden="true" />
              </span>
              <span>
                <strong>{meta.shortLabel}</strong>
                <small>{meta.description}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className={styles.workArea}>
        <div className={styles.requestPane}>
          <div className={styles.requestHeading}>
            <CurrentIcon size={18} aria-hidden="true" />
            <div>
              <strong>{currentMeta.label}</strong>
              <span>{currentMeta.description}</span>
            </div>
          </div>

          <label className={styles.instructions}>
            <span>{currentMeta.promptLabel}</span>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={1_000}
              placeholder={currentMeta.promptPlaceholder}
              disabled={demo}
            />
          </label>

          <div className={styles.requestControls}>
            {availableProviders.length > 1 ? (
              <label>
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
            ) : (
              <span className={styles.providerLine}>
                {demo || selectedProvider === "gemini"
                  ? "Included Gemini"
                  : PROVIDER_LABELS[selectedProvider]}
              </span>
            )}
            <button
              type="button"
              onClick={() => void generate()}
              disabled={!leagueId || result.state === "loading"}
            >
              {result.state === "loading" ? (
                <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />
              ) : (
                <Sparkles size={16} aria-hidden="true" />
              )}
              {demo
                ? "Refresh sample"
                : result.state === "loading"
                  ? "Reviewing…"
                  : "Generate review"}
              {result.state !== "loading" ? <ArrowRight size={15} aria-hidden="true" /> : null}
            </button>
          </div>
          <Link className={styles.settingsLink} href="/film-room">
            Provider and model settings <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>

        <div className={styles.resultPane} aria-live="polite">
          {result.state === "idle" ? (
            <div className={styles.emptyResult}>
              <Sparkles size={19} aria-hidden="true" />
              <strong>Ready when you are</strong>
              <span>The review uses the latest saved league, decision, and analytics data.</span>
            </div>
          ) : result.state === "loading" ? (
            <div className={styles.emptyResult}>
              <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
              <strong>Reading the whole league</strong>
              <span>Checking the recommendation against the deterministic board.</span>
            </div>
          ) : result.state === "error" ? (
            <div className={styles.errorResult} role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>Review unavailable</strong>
                <span>{result.message}</span>
              </div>
            </div>
          ) : (
            <article
              className={`${styles.answer}${result.result.outcome === "no-action" ? ` ${styles.noAction}` : ""}`}
            >
              <div className={styles.answerHeader}>
                <span>
                  {result.result.outcome === "no-action" ? (
                    <CheckCircle2 size={16} aria-hidden="true" />
                  ) : (
                    <Sparkles size={16} aria-hidden="true" />
                  )}
                  {result.result.title}
                </span>
                <small>
                  {demo
                    ? "Illustrative sample"
                    : `${PROVIDER_LABELS[result.result.provider]} · ${result.result.model}`}
                </small>
              </div>
              <div className={styles.answerBody}>
                <AiAnswerContent answer={result.result.answer} />
              </div>
              <footer>
                {result.result.sources.map((source) => (
                  <span key={source}>{source}</span>
                ))}
                {!demo && result.result.usage.outputTokens === 0 ? (
                  <small>No model call needed</small>
                ) : null}
              </footer>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
