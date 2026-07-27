"use client";

import type {
  ProjectionImportPreviewResponse,
  ProjectionSetListResponse,
  ProjectionVisibility,
} from "@fantasy/contracts";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  Database,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseLeagueListResponse,
  parseJobAccepted,
  parseProjectionImportCommit,
  parseProjectionImportPreview,
  parseProjectionSetList,
  type LeagueListResponse,
} from "../lib/api-client";
import {
  LEAGUE_PROJECTION_IMPORT_HORIZON,
  localDateTimeMinuteValue,
  projectionSourceAsOfText,
  sourceObservedAtIso,
} from "../lib/projection-import-form";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";
import { ProjectionPlayerBrowser, ProjectionPlayerTour } from "./projection-player-browser";
import styles from "./projection-import-workbench.module.css";

const MAX_CSV_BYTES = 512 * 1024;
const TEMPLATE = `player_id,player_name,mean_points,floor_points,ceiling_points,confidence\n,Tyreek Hill,18.4,12.1,27.8,0.82\n`;

type PortfolioState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly portfolio: LeagueListResponse };

type SetsState =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: ProjectionSetListResponse };

type SubmissionState =
  | { readonly state: "idle" }
  | { readonly state: "previewing" | "committing" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "committed"; readonly message: string };

type ForecastRefreshState = "idle" | "working" | "queued" | "deduplicated" | "error";

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

function readableDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function weekReference(value: { readonly season: number; readonly week: number | null } | null) {
  if (!value) return "Not reported";
  return value.week === null ? String(value.season) : `${value.season} Week ${value.week}`;
}

function decimal(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function shortenedChecksum(value: string): string {
  return `${value.slice(7, 19)}…${value.slice(-8)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function ProjectionTour() {
  return (
    <div className={styles.page}>
      <div className={styles.demoNotice} role="status">
        <Info size={17} aria-hidden="true" />
        <span>
          <strong>Locker room tour</strong>
          Illustrative forecast evidence, import, and match report. Nothing can be uploaded or saved
          in tour mode.
        </span>
      </div>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Managed forecasts + custom inputs</p>
          <h1>Use the weekly forecast, or bring your own.</h1>
          <p>
            League-scored forecasts update as source inputs change. Custom sets keep their source
            time, authorship, scope, and checksums.
          </p>
        </div>
        <label className={styles.leagueControl}>
          <span>League season</span>
          <select value="demo" disabled aria-label="Sample league season">
            <option value="demo">North Loop Auction · 2026</option>
          </select>
        </label>
      </header>

      <ProjectionJumpNav />

      <section
        className={styles.managedForecast}
        id="weekly-forecast"
        aria-labelledby="tour-managed-title"
      >
        <header className={styles.managedHeader}>
          <div>
            <p className={styles.kicker}>Laces Out forecast</p>
            <h2 id="tour-managed-title">Week 6 · ready for North Loop Auction</h2>
            <p>Scored for this league. Inputs and validation remain visible.</p>
          </div>
          <span className={styles.qualityBadge}>Quality gate passed</span>
        </header>
        <div className={styles.managedMetrics}>
          <div>
            <span>Inputs checked</span>
            <strong>Oct 8 · 1:40 PM</strong>
            <small>Oldest required source check</small>
          </div>
          <div>
            <span>Computed</span>
            <strong>Oct 8 · 1:43 PM</strong>
            <small>Model first-party-v1</small>
          </div>
          <div>
            <span>Coverage</span>
            <strong>213 / 214</strong>
            <small>99.5% of eligible players</small>
          </div>
          <div>
            <span>Backtest</span>
            <strong>4.18 MAE</strong>
            <small>4.62 recent-average baseline</small>
          </div>
        </div>
      </section>

      <ProjectionPlayerTour />

      <section className={styles.boundary} aria-label="Import privacy and matching rules">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>
            <strong>Private by default</strong>
            Other members cannot read a private set.
          </span>
        </div>
        <div>
          <FileCheck2 size={18} aria-hidden="true" />
          <span>
            <strong>All-or-nothing matching</strong>
            Ambiguous player rows are never silently skipped.
          </span>
        </div>
        <div>
          <Database size={18} aria-hidden="true" />
          <span>
            <strong>Provenance retained</strong>
            Source time, import time, checksums, and author remain visible.
          </span>
        </div>
      </section>

      <div className={`${styles.workspace} ${styles.tourWorkspace}`} id="custom-projections">
        <section className={styles.importPanel} aria-labelledby="tour-import-title">
          <header className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>Strict CSV import</p>
              <h2 id="tour-import-title">New projection set</h2>
            </div>
            <span className={styles.readyBadge}>Sample</span>
          </header>
          <div className={styles.form}>
            <div className={styles.filePicker}>
              <span className={styles.fileIcon}>
                <FileSpreadsheet size={20} aria-hidden="true" />
              </span>
              <span>
                <strong>week-6-blended-projections.csv</strong>
                <small>218 rows · 24 KB · illustrative file</small>
              </span>
            </div>
            <div className={styles.fields}>
              <label className={styles.wideField}>
                <span>Source label</span>
                <input value="My blended Week 6 model" readOnly />
              </label>
              <label>
                <span>Week</span>
                <select value="6" disabled>
                  <option value="6">Week 6</option>
                </select>
              </label>
              <label>
                <span>Source as of</span>
                <input value="Oct 8 · 12:55 PM" readOnly />
              </label>
            </div>
            <fieldset className={styles.visibility}>
              <legend>Who can use this set?</legend>
              <label className={styles.selectedVisibility}>
                <input type="radio" checked readOnly />
                <LockKeyhole size={17} aria-hidden="true" />
                <span>
                  <strong>Only me</strong>
                  <small>Visible solely to this sample account.</small>
                </span>
              </label>
              <label aria-disabled="true">
                <input type="radio" disabled />
                <Users size={17} aria-hidden="true" />
                <span>
                  <strong>Entire league</strong>
                  <small>Commissioners can publish league-wide sets.</small>
                </span>
              </label>
            </fieldset>
            <div className={styles.actions}>
              <button className={styles.previewButton} type="button" disabled>
                <FileSpreadsheet size={16} /> Preview matches
              </button>
              <button className={styles.commitButton} type="button" disabled>
                <Check size={16} /> Save projection set
              </button>
            </div>
          </div>
        </section>

        <section className={styles.previewPanel} aria-labelledby="tour-match-title">
          <header className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>Before anything is saved</p>
              <h2 id="tour-match-title">Match report</h2>
            </div>
            <span className={styles.readyBadge}>Ready</span>
          </header>
          <div className={styles.previewBody}>
            <div className={styles.previewStats}>
              <div>
                <span>Rows</span>
                <strong>218</strong>
              </div>
              <div>
                <span>Resolved</span>
                <strong>218</strong>
              </div>
              <div>
                <span>Errors</span>
                <strong>0</strong>
              </div>
            </div>
            <dl className={styles.checksums}>
              <div>
                <dt>Decision scope</dt>
                <dd>Week 6 · single week</dd>
              </div>
              <div>
                <dt>Player identity</dt>
                <dd>218 canonical matches</dd>
              </div>
              <div>
                <dt>Source checksum</dt>
                <dd>sha256: 7b0a…d421</dd>
              </div>
              <div>
                <dt>Resolved import</dt>
                <dd>sha256: 91fc…8ab2</dd>
              </div>
            </dl>
            <div className={styles.cleanPreview}>
              <Check size={17} aria-hidden="true" />
              <span>Every sample row maps to one canonical player.</span>
            </div>
          </div>
        </section>
      </div>

      <section className={styles.saved} aria-labelledby="tour-saved-title">
        <header className={styles.savedHeader}>
          <div>
            <p className={styles.kicker}>Available in this league</p>
            <h2 id="tour-saved-title">Saved projection sets</h2>
          </div>
          <span className={styles.readyBadge}>2 sets</span>
        </header>
        <div className={styles.demoSavedList}>
          <article>
            <span>MANAGED · WEEK 6</span>
            <strong>Laces Out weekly forecast</strong>
            <small>213 players · inputs checked 32 min ago · quality gate passed</small>
          </article>
          <article>
            <span>PRIVATE · WEEK 6</span>
            <strong>My blended Week 6 model</strong>
            <small>218 players · Source 47 min ago · imported by Sample member</small>
          </article>
        </div>
      </section>
    </div>
  );
}

function ProjectionJumpNav() {
  return (
    <nav className={styles.mobileJump} aria-label="Projection sections">
      <a href="#weekly-forecast">Weekly</a>
      <a href="#player-projections">Player Board</a>
      <a href="#rest-of-season">Rest of Season</a>
      <a href="#custom-projections">Custom Sets</a>
    </nav>
  );
}

export function ProjectionImportWorkbench() {
  const [portfolio, setPortfolio] = useState<PortfolioState>({ state: "loading" });
  const [selectedSeasonId, setSelectedSeasonId] = useState("");
  const [sets, setSets] = useState<SetsState>({ state: "idle" });
  const [csv, setCsv] = useState("");
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("My weekly projections");
  const [week, setWeek] = useState("1");
  const [sourceObservedAtLocal, setSourceObservedAtLocal] = useState("");
  const [visibility, setVisibility] = useState<ProjectionVisibility>("private");
  const [preview, setPreview] = useState<ProjectionImportPreviewResponse | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ state: "idle" });
  const [forecastRefresh, setForecastRefresh] = useState<ForecastRefreshState>("idle");
  const portfolioAbortRef = useRef<AbortController | null>(null);
  const setsAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const commitAbortRef = useRef<AbortController | null>(null);

  const loadPortfolio = useCallback(async () => {
    portfolioAbortRef.current?.abort();
    const controller = new AbortController();
    portfolioAbortRef.current = controller;
    setPortfolio({ state: "loading" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/leagues`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (portfolioAbortRef.current !== controller) return;
      if (response.status === 401) {
        setPortfolio({ state: "signed-out" });
        return;
      }
      if (!response.ok) throw new Error(await responseMessage(response, "Could not load leagues"));
      const payload: unknown = await response.json();
      if (portfolioAbortRef.current !== controller) return;
      const parsed = parseLeagueListResponse(payload);
      if (!parsed) throw new Error("League response did not match the expected contract");
      setPortfolio({ state: "ready", portfolio: parsed });
      const requestedLeagueId = new URLSearchParams(window.location.search).get("league");
      const requestedSeason = parsed.leagues.find(
        (league) => league.id === requestedLeagueId && league.season,
      )?.season;
      const firstSeason = requestedSeason ?? parsed.leagues.find((league) => league.season)?.season;
      setSelectedSeasonId((current) =>
        parsed.leagues.some((league) => league.season?.id === current)
          ? current
          : (firstSeason?.id ?? ""),
      );
    } catch (error) {
      if (isAbortError(error) || portfolioAbortRef.current !== controller) return;
      setPortfolio({
        state: "error",
        message: error instanceof Error ? error.message : "Could not load leagues",
      });
    } finally {
      if (portfolioAbortRef.current === controller) portfolioAbortRef.current = null;
    }
  }, []);

  useEffect(() => void loadPortfolio(), [loadPortfolio]);

  const selectedPortfolioLeague = useMemo(
    () =>
      portfolio.state === "ready"
        ? portfolio.portfolio.leagues.find((league) => league.season?.id === selectedSeasonId)
        : undefined,
    [portfolio, selectedSeasonId],
  );

  const loadSets = useCallback(async () => {
    setsAbortRef.current?.abort();
    if (!selectedSeasonId) {
      setSets({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setsAbortRef.current = controller;
    setSets({ state: "loading" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/league-seasons/${encodeURIComponent(selectedSeasonId)}/projections`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (setsAbortRef.current !== controller) return;
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not load projection sets"));
      }
      const payload: unknown = await response.json();
      if (setsAbortRef.current !== controller) return;
      const parsed = parseProjectionSetList(payload);
      if (!parsed) throw new Error("Projection response did not match the expected contract");
      setSets({ state: "ready", data: parsed });
      setWeek(String(parsed.league.currentWeek ?? 1));
      if (!parsed.league.canShareLeague) setVisibility("private");
    } catch (error) {
      if (isAbortError(error) || setsAbortRef.current !== controller) return;
      setSets({
        state: "error",
        message: error instanceof Error ? error.message : "Could not load projection sets",
      });
    } finally {
      if (setsAbortRef.current === controller) setsAbortRef.current = null;
    }
  }, [selectedSeasonId]);

  useEffect(() => void loadSets(), [loadSets]);

  useEffect(() => {
    setSourceObservedAtLocal((current) => current || localDateTimeMinuteValue(new Date()));
    return () => {
      portfolioAbortRef.current?.abort();
      setsAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      commitAbortRef.current?.abort();
    };
  }, []);

  const clearPreview = () => {
    previewAbortRef.current?.abort();
    setPreview(null);
    setSubmission({ state: "idle" });
  };

  const handleFile = async (file: File | undefined) => {
    clearPreview();
    if (!file) {
      setCsv("");
      setSourceFileName(null);
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setCsv("");
      setSourceFileName(null);
      setSubmission({ state: "error", message: "CSV files are limited to 512 KB." });
      return;
    }
    try {
      setCsv(await file.text());
      setSourceFileName(file.name);
    } catch {
      setSubmission({ state: "error", message: "The selected file could not be read." });
    }
  };

  const requestBody = (sourceObservedAt: string) => ({
    csv,
    metadata: {
      season: selectedPortfolioLeague?.season?.season ?? 0,
      week: Number(week),
      horizon: LEAGUE_PROJECTION_IMPORT_HORIZON,
      sourceLabel,
      sourceObservedAt,
    },
    visibility,
    sourceFileName,
  });

  const previewImport = async () => {
    if (!selectedSeasonId || !csv) return;
    const sourceObservedAt = sourceObservedAtIso(sourceObservedAtLocal);
    if (!sourceObservedAt) {
      setSubmission({ state: "error", message: "Enter a valid source as-of date and time." });
      return;
    }
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const seasonId = selectedSeasonId;
    setSubmission({ state: "previewing" });
    setPreview(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/league-seasons/${encodeURIComponent(seasonId)}/projections/preview`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(requestBody(sourceObservedAt)),
          signal: controller.signal,
        },
      );
      if (previewAbortRef.current !== controller) return;
      if (!response.ok) throw new Error(await responseMessage(response, "Preview failed"));
      const payload: unknown = await response.json();
      if (previewAbortRef.current !== controller) return;
      const parsed = parseProjectionImportPreview(payload);
      if (!parsed) throw new Error("Preview response did not match the expected contract");
      setPreview(parsed);
      setSubmission({ state: "idle" });
    } catch (error) {
      if (isAbortError(error) || previewAbortRef.current !== controller) return;
      setSubmission({
        state: "error",
        message: error instanceof Error ? error.message : "Preview failed",
      });
    } finally {
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
    }
  };

  const commitImport = async () => {
    if (!selectedSeasonId || !preview?.canCommit || !preview.importChecksum) return;
    const sourceObservedAt = sourceObservedAtIso(sourceObservedAtLocal);
    if (!sourceObservedAt) {
      setSubmission({ state: "error", message: "Enter a valid source as-of date and time." });
      return;
    }
    commitAbortRef.current?.abort();
    const controller = new AbortController();
    commitAbortRef.current = controller;
    const seasonId = selectedSeasonId;
    setSubmission({ state: "committing" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/league-seasons/${encodeURIComponent(seasonId)}/projections`,
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            ...requestBody(sourceObservedAt),
            expectedImportChecksum: preview.importChecksum,
          }),
          signal: controller.signal,
        },
      );
      if (commitAbortRef.current !== controller) return;
      if (!response.ok) throw new Error(await responseMessage(response, "Import failed"));
      const payload: unknown = await response.json();
      if (commitAbortRef.current !== controller) return;
      const parsed = parseProjectionImportCommit(payload);
      if (!parsed) throw new Error("Import response did not match the expected contract");
      setSubmission({
        state: "committed",
        message: parsed.deduplicated
          ? "This exact projection set was already saved."
          : `${parsed.projectionSet.playerCount} projections saved.`,
      });
      setPreview(null);
      await loadSets();
    } catch (error) {
      if (isAbortError(error) || commitAbortRef.current !== controller) return;
      setSubmission({
        state: "error",
        message: error instanceof Error ? error.message : "Import failed",
      });
    } finally {
      if (commitAbortRef.current === controller) commitAbortRef.current = null;
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "laces-out-projections-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const checkManagedForecast = async () => {
    if (forecastRefresh === "working") return;
    setForecastRefresh("working");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/refreshes`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "player-data" }),
      });
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok) throw new Error("Forecast input check could not be queued.");
      const queued = parseJobAccepted(await response.json());
      if (!queued || queued.target !== "shared-nfl-data") {
        throw new Error("Forecast input queue response was invalid.");
      }
      setForecastRefresh(queued.state === "deduplicated" ? "deduplicated" : "queued");
    } catch {
      setForecastRefresh("error");
    }
  };

  if (portfolio.state === "loading") {
    return (
      <div className={styles.gate} role="status">
        <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
        <span>Loading your league seasons…</span>
      </div>
    );
  }
  if (portfolio.state === "signed-out") {
    return <ProjectionTour />;
  }
  if (portfolio.state === "error") {
    return (
      <div className={styles.gate} role="alert">
        <AlertTriangle size={22} aria-hidden="true" />
        <div>
          <h1>Projection lab is unavailable</h1>
          <p>{portfolio.message}</p>
          <button className={styles.secondaryButton} type="button" onClick={loadPortfolio}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const leaguesWithSeasons = portfolio.portfolio.leagues.filter((league) => league.season);
  if (leaguesWithSeasons.length === 0) {
    return (
      <div className={styles.gate}>
        <Database size={22} aria-hidden="true" />
        <div>
          <h1>Connect a league first</h1>
          <p>A Yahoo or ESPN league season establishes the scoring and privacy boundary.</p>
          <Link className={styles.primaryLink} href="/connections">
            Open League Sync
          </Link>
        </div>
      </div>
    );
  }

  const canShare = sets.state === "ready" && sets.data.league.canShareLeague;
  const visibleDiagnostics = preview?.diagnostics.slice(0, 50) ?? [];
  const managedSets =
    sets.state === "ready"
      ? sets.data.projectionSets.filter(
          (set) => set.origin === "laces-out" && set.managed && set.horizon === "week",
        )
      : [];
  const currentWeek = sets.state === "ready" ? sets.data.league.currentWeek : null;
  const managedStatus = sets.state === "ready" ? sets.data.managedForecastStatus : null;
  const managedCandidate =
    managedSets.find((set) => currentWeek !== null && set.week === currentWeek) ?? managedSets[0];
  const managedForecast = managedStatus?.state === "withheld" ? undefined : managedCandidate;

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.kicker}>Managed forecasts + custom inputs</p>
          <h1>Use the weekly forecast, or bring your own.</h1>
          <p>
            The league-scored forecast rebuilds when verified inputs change. Your own CSV can
            override that baseline after every player match passes validation.
          </p>
        </div>
        <label className={styles.leagueControl}>
          <span>League season</span>
          <select
            value={selectedSeasonId}
            onChange={(event) => {
              setsAbortRef.current?.abort();
              commitAbortRef.current?.abort();
              setSelectedSeasonId(event.target.value);
              const selectedLeague = leaguesWithSeasons.find(
                (league) => league.season?.id === event.target.value,
              );
              const url = new URL(window.location.href);
              if (selectedLeague) url.searchParams.set("league", selectedLeague.id);
              window.history.replaceState(window.history.state, "", url);
              setSets({ state: "loading" });
              setCsv("");
              setSourceFileName(null);
              clearPreview();
            }}
          >
            {leaguesWithSeasons.map((league) => (
              <option value={league.season!.id} key={league.season!.id}>
                {league.name} · {league.season!.season}
              </option>
            ))}
          </select>
        </label>
      </header>

      <ProjectionJumpNav />

      <section
        className={styles.managedForecast}
        id="weekly-forecast"
        aria-labelledby="managed-forecast-title"
      >
        <header className={styles.managedHeader}>
          <div>
            <p className={styles.kicker}>Laces Out forecast</p>
            {/* Only claim "not published" once the fetch has actually resolved.
                While loading or after a failure this asserted a methodology
                verdict about a request that never returned. */}
            <h2 id="managed-forecast-title">
              {sets.state === "loading" || sets.state === "idle"
                ? "Checking for this week's forecast…"
                : sets.state === "error"
                  ? "The forecast could not be loaded"
                  : managedForecast
                    ? `Week ${managedForecast.week} · ${managedForecast.sourceLabel}`
                    : `Week ${currentWeek ?? "—"} · no managed forecast published`}
            </h2>
            <p>
              {sets.state === "loading" || sets.state === "idle"
                ? "Reading the published forecast and its validation record."
                : sets.state === "error"
                  ? "This is a connection problem, not a verdict on the model. Try again in a moment."
                  : managedForecast
                    ? "League scoring is applied after each position earns either the qualified model or the safer baseline. Input freshness and compute time stay separate."
                    : "The forecast remains unavailable until required inputs, league scoring, coverage, and backtest gates pass."}
            </p>
          </div>
          <div className={styles.managedActions}>
            {selectedPortfolioLeague ? (
              <Link
                className={styles.textButton}
                href={`/schedule?league=${selectedPortfolioLeague.id}`}
              >
                <CalendarDays size={15} aria-hidden="true" />
                Schedule Edge
              </Link>
            ) : null}
            {managedForecast?.managed?.qualityState ? (
              <span
                className={
                  managedForecast.managed.qualityState === "publishable"
                    ? styles.qualityBadge
                    : styles.qualityWarningBadge
                }
              >
                {managedForecast.managed.qualityState === "publishable"
                  ? "Safe forecast published"
                  : managedForecast.managed.qualityState}
              </span>
            ) : null}
            <button
              className={styles.textButton}
              type="button"
              disabled={forecastRefresh === "working"}
              onClick={() => void checkManagedForecast()}
            >
              {forecastRefresh === "working" ? (
                <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
              ) : forecastRefresh === "queued" || forecastRefresh === "deduplicated" ? (
                <Check size={15} aria-hidden="true" />
              ) : forecastRefresh === "error" ? (
                <CircleAlert size={15} aria-hidden="true" />
              ) : (
                <RefreshCw size={15} aria-hidden="true" />
              )}
              {forecastRefresh === "working"
                ? "Requesting…"
                : forecastRefresh === "queued"
                  ? "Input check queued"
                  : forecastRefresh === "deduplicated"
                    ? "Input check already queued"
                    : forecastRefresh === "error"
                      ? "Retry input check"
                      : "Check inputs & rerun"}
            </button>
          </div>
        </header>
        {managedForecast?.managed ? (
          <>
            <div className={styles.managedMetrics}>
              <div>
                <span>Inputs checked</span>
                <strong>{readableDate(managedForecast.managed.inputCheckedAt)}</strong>
                <small>Oldest required source check</small>
              </div>
              <div>
                <span>Computed</span>
                <strong>{readableDate(managedForecast.managed.computedAt)}</strong>
                <small>
                  {managedForecast.managed.modelVersion ?? "Model version not reported"}
                </small>
              </div>
              <div>
                <span>Coverage</span>
                <strong>
                  {managedForecast.managed.coverage
                    ? `${managedForecast.managed.coverage.projected} / ${managedForecast.managed.coverage.eligible}`
                    : `${managedForecast.playerCount} projected`}
                </strong>
                <small>
                  {managedForecast.managed.coverage
                    ? `${Math.round(managedForecast.managed.coverage.ratio * 1000) / 10}% of eligible players`
                    : "Eligible-player count not reported"}
                </small>
              </div>
              <div>
                <span>Training cutoff</span>
                <strong>{weekReference(managedForecast.managed.trainingCutoff)}</strong>
                <small>Stats through {weekReference(managedForecast.managed.statsThrough)}</small>
              </div>
            </div>
            <div className={styles.modelEvidence}>
              <BarChart3 size={17} aria-hidden="true" />
              {managedForecast.managed.backtest ? (
                <p>
                  <strong>Locked backtest:</strong>{" "}
                  {managedForecast.managed.backtest.samples.toLocaleString()} player-weeks · MAE{" "}
                  {decimal(managedForecast.managed.backtest.mae)}
                  {managedForecast.managed.backtest.baselineMae !== null
                    ? ` vs. ${decimal(managedForecast.managed.backtest.baselineMae)} baseline`
                    : ""}
                  {managedForecast.managed.backtest.intervalCoverage !== null
                    ? ` · ${Math.round(managedForecast.managed.backtest.intervalCoverage * 100)}% interval coverage`
                    : ""}
                </p>
              ) : (
                <p>Backtest summary was not attached to this forecast.</p>
              )}
            </div>
            {managedForecast.managed.championByPosition.length > 0 ? (
              <div className={styles.championRail} aria-label="Forecast strategy by position">
                <span>Live mean strategy</span>
                <div>
                  {managedForecast.managed.championByPosition.map((choice) => (
                    <small key={choice.position}>
                      <strong>{choice.position}</strong>
                      {choice.strategy === "first-party-model"
                        ? "Qualified model"
                        : "Safe baseline"}
                    </small>
                  ))}
                </div>
              </div>
            ) : null}
            {managedForecast.managed.warnings.length > 0 ? (
              <div className={styles.forecastWarnings} role="status">
                <AlertTriangle size={16} aria-hidden="true" />
                <ul>
                  {managedForecast.managed.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <div className={styles.managedEmpty}>
            <Clock3 size={18} aria-hidden="true" />
            <div>
              <p>No managed set is available for this league yet.</p>
              {managedStatus?.state === "withheld" && managedStatus.reasons.length > 0 ? (
                <div>
                  <p>The latest update was withheld. Any earlier forecast is inactive.</p>
                  <ul>
                    {managedStatus.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>A check never publishes a weaker forecast just to produce a newer timestamp.</p>
              )}
            </div>
          </div>
        )}
        <p className={styles.refreshFootnote}>
          Input checks run in the background. A new set is published only when inputs change and the
          quality gates pass; use Reload list below to read completed results.
        </p>
      </section>

      <ProjectionPlayerBrowser
        leagueSeasonId={selectedSeasonId}
        leagueName={
          sets.state === "ready"
            ? sets.data.league.name
            : (selectedPortfolioLeague?.name ?? "Selected league")
        }
        currentWeek={currentWeek}
        projectionSets={sets.state === "ready" ? sets.data.projectionSets : []}
        withheldNewerRun={managedStatus?.state === "withheld"}
        listState={
          sets.state === "loading" || sets.state === "idle"
            ? "loading"
            : sets.state === "error"
              ? "error"
              : "ready"
        }
        listError={sets.state === "error" ? sets.message : undefined}
      />

      <section className={styles.boundary} aria-label="Import privacy and matching rules">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>
            <strong>Private by default</strong>
            Other members cannot read a private set.
          </span>
        </div>
        <div>
          <FileCheck2 size={18} aria-hidden="true" />
          <span>
            <strong>All-or-nothing matching</strong>
            No unresolved or ambiguous row is silently skipped.
          </span>
        </div>
        <div>
          <Database size={18} aria-hidden="true" />
          <span>
            <strong>Provenance retained</strong>
            Source as-of time, import time, checksums, and author stay attached.
          </span>
        </div>
      </section>

      <div className={styles.workspace} id="custom-projections">
        <section className={styles.importPanel} aria-labelledby="projection-import-title">
          <header className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>Strict CSV import</p>
              <h2 id="projection-import-title">New projection set</h2>
            </div>
            <button className={styles.textButton} type="button" onClick={downloadTemplate}>
              <Download size={15} aria-hidden="true" />
              Template
            </button>
          </header>

          <div className={styles.form}>
            <label className={styles.filePicker}>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <span className={styles.fileIcon}>
                <Upload size={20} aria-hidden="true" />
              </span>
              <span>
                <strong>{sourceFileName ?? "Choose a projection CSV"}</strong>
                <small>
                  {csv
                    ? `${new TextEncoder().encode(csv).byteLength.toLocaleString()} bytes ready`
                    : "Up to 5,000 rows and 512 KB"}
                </small>
              </span>
            </label>

            <div className={styles.fields}>
              <label className={styles.wideField}>
                <span>Source label</span>
                <input
                  value={sourceLabel}
                  maxLength={80}
                  onChange={(event) => {
                    setSourceLabel(event.target.value);
                    clearPreview();
                  }}
                />
              </label>
              <label>
                <span>Week</span>
                <select
                  value={week}
                  onChange={(event) => {
                    setWeek(event.target.value);
                    clearPreview();
                  }}
                >
                  {Array.from({ length: 18 }, (_, index) => String(index + 1)).map((value) => (
                    <option value={value} key={value}>
                      Week {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Source as of</span>
                <input
                  type="datetime-local"
                  step="60"
                  value={sourceObservedAtLocal}
                  onChange={(event) => {
                    setSourceObservedAtLocal(event.target.value);
                    clearPreview();
                  }}
                  aria-describedby="source-observed-at-help"
                />
                <small id="source-observed-at-help" className={styles.fieldHelp}>
                  Local time when this source published or observed the data.
                </small>
              </label>
            </div>

            <fieldset className={styles.visibility}>
              <legend>Who can use this set?</legend>
              <label className={visibility === "private" ? styles.selectedVisibility : undefined}>
                <input
                  type="radio"
                  name="projection-visibility"
                  value="private"
                  checked={visibility === "private"}
                  onChange={() => {
                    setVisibility("private");
                    clearPreview();
                  }}
                />
                <LockKeyhole size={17} aria-hidden="true" />
                <span>
                  <strong>Only me</strong>
                  <small>Visible solely to your account in this league.</small>
                </span>
              </label>
              <label
                className={visibility === "league" ? styles.selectedVisibility : undefined}
                aria-disabled={!canShare}
              >
                <input
                  type="radio"
                  name="projection-visibility"
                  value="league"
                  checked={visibility === "league"}
                  disabled={!canShare}
                  onChange={() => {
                    setVisibility("league");
                    clearPreview();
                  }}
                />
                <Users size={17} aria-hidden="true" />
                <span>
                  <strong>Entire league</strong>
                  <small>
                    {canShare
                      ? "League members can use it in their decision desk."
                      : "Owner or commissioner permission required."}
                  </small>
                </span>
              </label>
            </fieldset>

            <div className={styles.actions}>
              <button
                className={styles.previewButton}
                type="button"
                disabled={
                  !csv ||
                  sourceLabel.trim().length < 2 ||
                  !sourceObservedAtIso(sourceObservedAtLocal) ||
                  submission.state === "previewing" ||
                  submission.state === "committing"
                }
                onClick={() => void previewImport()}
              >
                {submission.state === "previewing" ? (
                  <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />
                ) : (
                  <FileSpreadsheet size={16} aria-hidden="true" />
                )}
                Preview matches
              </button>
              <button
                className={styles.commitButton}
                type="button"
                disabled={
                  !preview?.canCommit ||
                  !preview.importChecksum ||
                  submission.state === "committing"
                }
                onClick={() => void commitImport()}
              >
                {submission.state === "committing" ? (
                  <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                Save projection set
              </button>
            </div>

            {submission.state === "error" ? (
              <div className={styles.errorNotice} role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>{submission.message}</span>
              </div>
            ) : null}
            {submission.state === "committed" ? (
              <div className={styles.successNotice} role="status">
                <Check size={17} aria-hidden="true" />
                <span>{submission.message}</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className={styles.previewPanel} aria-labelledby="projection-preview-title">
          <header className={styles.panelHeader}>
            <div>
              <p className={styles.kicker}>Before anything is saved</p>
              <h2 id="projection-preview-title">Match report</h2>
            </div>
            {preview ? (
              <span className={preview.canCommit ? styles.readyBadge : styles.blockedBadge}>
                {preview.canCommit ? "Ready" : "Blocked"}
              </span>
            ) : null}
          </header>
          {!preview ? (
            <div className={styles.emptyPreview}>
              <FileCheck2 size={24} aria-hidden="true" />
              <strong>No preview yet</strong>
              <p>
                Required columns are player_id or player_name, plus mean_points. Floor, ceiling, and
                confidence are optional.
              </p>
            </div>
          ) : (
            <div className={styles.previewBody}>
              <div className={styles.previewStats}>
                <div>
                  <span>Rows</span>
                  <strong>{preview.rowCount.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Resolved</span>
                  <strong>{preview.resolvedRowCount.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Errors</span>
                  <strong>
                    {preview.diagnostics.filter((item) => item.severity === "error").length}
                  </strong>
                </div>
              </div>
              <dl className={styles.checksums}>
                <div>
                  <dt>Source as of</dt>
                  <dd>{readableDate(preview.metadata.sourceObservedAt)}</dd>
                </div>
                <div>
                  <dt>Decision scope</dt>
                  <dd>Week {preview.metadata.week} · single week</dd>
                </div>
                <div>
                  <dt>Imported at</dt>
                  <dd>Assigned only when saved</dd>
                </div>
                <div>
                  <dt>Source checksum</dt>
                  <dd title={preview.sourceChecksum}>
                    {shortenedChecksum(preview.sourceChecksum)}
                  </dd>
                </div>
                <div>
                  <dt>Resolved import</dt>
                  <dd title={preview.importChecksum ?? undefined}>
                    {preview.importChecksum ? shortenedChecksum(preview.importChecksum) : "Blocked"}
                  </dd>
                </div>
              </dl>
              {visibleDiagnostics.length === 0 ? (
                <div className={styles.cleanPreview}>
                  <Check size={17} aria-hidden="true" />
                  <span>Every row is valid and maps to one canonical player.</span>
                </div>
              ) : (
                <div className={styles.diagnostics}>
                  {visibleDiagnostics.map((diagnostic, index) => (
                    <article
                      className={
                        diagnostic.severity === "error"
                          ? styles.diagnosticError
                          : styles.diagnosticWarning
                      }
                      key={`${diagnostic.rowNumber}:${diagnostic.code}:${index}`}
                    >
                      <span>Row {diagnostic.rowNumber}</span>
                      <div>
                        <strong>{diagnostic.message}</strong>
                        {diagnostic.candidates?.length ? (
                          <small>
                            Candidates:{" "}
                            {diagnostic.candidates.map((item) => item.playerName).join(", ")}
                          </small>
                        ) : null}
                      </div>
                    </article>
                  ))}
                  {preview.diagnostics.length > visibleDiagnostics.length ? (
                    <p className={styles.moreDiagnostics}>
                      {preview.diagnostics.length - visibleDiagnostics.length} more diagnostics are
                      not shown. Correct the first rows and preview again.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <section className={styles.saved} aria-labelledby="saved-projections-title">
        <header className={styles.savedHeader}>
          <div>
            <p className={styles.kicker}>Available in this league</p>
            <h2 id="saved-projections-title">Projection set history</h2>
          </div>
          <button
            className={styles.textButton}
            type="button"
            disabled={sets.state === "loading"}
            onClick={() => void loadSets()}
          >
            <RefreshCw
              className={sets.state === "loading" ? styles.spin : undefined}
              size={15}
              aria-hidden="true"
            />
            Reload list
          </button>
        </header>
        {sets.state === "loading" ? (
          <div className={styles.savedEmpty} role="status">
            <LoaderCircle className={styles.spin} size={18} aria-hidden="true" />
            Loading saved sets…
          </div>
        ) : sets.state === "error" ? (
          <div className={styles.savedEmpty} role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            {sets.message}
          </div>
        ) : sets.state === "ready" && sets.data.projectionSets.length > 0 ? (
          <div className={styles.setTableWrap}>
            <table className={styles.setTable}>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Window</th>
                  <th>Rows</th>
                  <th>Access</th>
                  <th>Input / source time</th>
                  <th>Built / imported</th>
                  <th>Checksum</th>
                </tr>
              </thead>
              <tbody>
                {sets.data.projectionSets.map((set) => (
                  <tr key={set.id}>
                    <td>
                      <strong>{set.sourceLabel}</strong>
                      <small>
                        {set.origin === "laces-out"
                          ? `Managed by Laces Out${set.managed?.modelVersion ? ` · ${set.managed.modelVersion}` : ""}`
                          : `${set.isOwnedByCurrentUser ? "You" : (set.creatorDisplayName ?? "League member")}${set.sourceFileName ? ` · ${set.sourceFileName}` : ""}`}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {set.horizon === "week" ? `Week ${set.week ?? "—"}` : "Rest of season"}
                      </strong>
                      <small>
                        {set.season} ·{" "}
                        {set.horizon === "week" ? "single week" : "published league-scored window"}
                      </small>
                    </td>
                    <td>{set.playerCount.toLocaleString()}</td>
                    <td>
                      <span className={styles.accessLabel}>
                        {set.visibility === "private" ? (
                          <LockKeyhole size={13} aria-hidden="true" />
                        ) : (
                          <Users size={13} aria-hidden="true" />
                        )}
                        {set.visibility === "private" ? "Only me" : "League"}
                      </span>
                    </td>
                    <td>
                      {set.origin === "laces-out" && set.managed
                        ? readableDate(set.managed.inputCheckedAt)
                        : projectionSourceAsOfText(set, readableDate)}
                      {set.origin === "custom" && set.sourceObservedAtStatus === "unverified" ? (
                        <small>Legacy import; no trustworthy source timestamp</small>
                      ) : null}
                    </td>
                    <td>
                      {readableDate(
                        set.origin === "laces-out" && set.managed
                          ? set.managed.computedAt
                          : set.importedAt,
                      )}
                    </td>
                    <td>
                      <code title={set.inputChecksum}>{shortenedChecksum(set.inputChecksum)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.savedEmpty}>
            <FileSpreadsheet size={19} aria-hidden="true" />
            No saved projection sets are available for this league season.
          </div>
        )}
      </section>
    </div>
  );
}
