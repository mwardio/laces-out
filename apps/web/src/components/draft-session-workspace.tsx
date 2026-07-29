"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeDollarSign,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Database,
  Dices,
  FastForward,
  Gavel,
  Keyboard,
  Link2,
  ListFilter,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  StepForward,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  parseAuthenticatedSession,
  parseDraftMarketBaseline,
  parseDraftMutation,
  parseDraftSession,
  parseLeagueDashboard,
  parseLeagueListResponse,
  parseRankingListResponse,
  parseRankingVersionResponse,
  type DraftMarketBaseline,
  type DraftSessionSnapshot,
  type LeagueDashboard,
  type LeagueListResponse,
  type RankingList,
  type RankingVersion,
} from "../lib/api-client";
import {
  analyzeAuctionBoard,
  buildAuctionNominationQueue,
  buildDraftBoardRows,
  buildSnakeBestNowQueue,
  nextPickForTeam,
  type DraftBoardSort,
  type DraftBoardValue,
} from "../lib/draft-board";
import { preferNewerDraftSnapshot } from "../lib/draft-session-refresh";
import {
  browserDraftStreamConnect,
  subscribeToDraftStream,
  type DraftStreamState,
} from "../lib/draft-stream";
import {
  describeDraftSetupCapability,
  describeLiveDraft,
  describeMobileDecision,
} from "../lib/live-draft-status";
import {
  advanceLocalDraftMock,
  createLocalDraftMock,
  draftMockAvailability,
  localMockEvents,
  recordLocalControlledSelection,
  replayLocalDraftFromEvent,
  undoLatestLocalDraftEvent,
  type LocalDraftMock,
} from "../lib/draft-mock";
import { LatestRequest } from "../lib/latest-request";
import { useByeWeeks } from "../lib/use-bye-weeks";
import { DraftAnalysisPanel } from "./draft-analysis-panel";
import { DraftWorkspace as DemoDraftWorkspace } from "./draft-workspace";

/** Renders nothing when the schedule cannot affirm a bye, rather than showing a guess. */
function byeLabel(byeWeeks: ReadonlyMap<string, number>, team: string | null | undefined): string {
  const week = team ? byeWeeks.get(team.toUpperCase()) : undefined;
  return week === undefined ? "" : ` · Bye ${String(week)}`;
}

type BoardPlayer = DraftSessionSnapshot["config"]["players"][number];

/* The live-draft clock re-renders the workspace every second; the board is up
   to 250 rows of ~15 elements, so each row bails out here unless its own
   data, selection, or coverage changed. */
const BoardRow = memo(function BoardRow({
  player,
  value,
  covered,
  selected,
  byeWeeks,
  onSelect,
}: {
  player: BoardPlayer;
  value: DraftBoardValue | null;
  covered: boolean;
  selected: boolean;
  byeWeeks: ReadonlyMap<string, number>;
  onSelect: (playerId: string) => void;
}) {
  return (
    <tr
      className={[selected ? "is-selected" : "", covered ? "" : "is-board-missing"]
        .filter(Boolean)
        .join(" ")}
    >
      <td>
        <span className="rank-cell">{value?.overallRank ?? "—"}</span>
      </td>
      <th scope="row">
        <button className="player-name-button" type="button" onClick={() => onSelect(player.id)}>
          <span
            className={`position-avatar position-avatar--${player.positions[0]?.toLowerCase() ?? "all"}`}
          >
            {player.positions[0]}
          </span>
          <span>
            <strong>{player.name}</strong>
            <small>
              {player.positions.join(" · ")} · {player.nflTeam ?? "FA"}
              {byeLabel(byeWeeks, player.nflTeam)}
            </small>
          </span>
        </button>
      </th>
      <td>{value?.tier ? <span className="tier-pill">T{value.tier}</span> : "—"}</td>
      <td>{value?.adp?.toFixed(1) ?? "—"}</td>
      <td>{value?.aav !== null && value?.aav !== undefined ? "$" + String(value.aav) : "—"}</td>
      <td>
        {value?.target ? (
          <span className="board-signal board-signal--value">Target</span>
        ) : value?.avoid ? (
          <span className="board-signal board-signal--risk">Avoid</span>
        ) : !covered ? (
          <span className="board-signal">Not on board</span>
        ) : (
          <span className="board-signal">{player.status ?? "Ranked"}</span>
        )}
      </td>
      <td>{selected ? <Check size={15} /> : null}</td>
    </tr>
  );
});

const EMPTY_TEAM_STATES: never[] = [];

type BootState = "loading" | "signed-out" | "ready" | "error";
type RequestState = "idle" | "loading";
type RankingLoadState = "idle" | "loading" | "ready" | "error";
type CoverageFilter = "covered" | "all" | "missing";

interface ProblemBody {
  readonly detail?: unknown;
  readonly title?: unknown;
  readonly currentSequence?: unknown;
}

function problemMessage(problem: ProblemBody | null, fallback: string): string {
  if (typeof problem?.detail === "string") return problem.detail;
  if (typeof problem?.title === "string") return problem.title;
  return fallback;
}

async function readProblem(response: Response): Promise<ProblemBody | null> {
  return (await response.json().catch(() => null)) as ProblemBody | null;
}

function staleFor(lastSyncedAt: number | null): string {
  if (lastSyncedAt === null) return "no update yet";
  const seconds = Math.max(0, Math.round((Date.now() - lastSyncedAt) / 1000));
  if (seconds < 60) return `last update ${seconds}s ago`;
  return `last update ${Math.round(seconds / 60)}m ago`;
}

function providerLabel(provider: string): string {
  if (provider === "espn") return "ESPN";
  if (provider === "yahoo") return "Yahoo";
  return "Manual";
}

function eventLabel(event: DraftSessionSnapshot["events"][number]["event"]): string {
  switch (event.type) {
    case "SNAKE_PLAYER_SELECTED":
      return `Pick ${event.overallPick}`;
    case "SNAKE_KEEPER_ASSIGNED":
      return `Keeper · pick ${event.overallPick}`;
    case "AUCTION_KEEPER_ASSIGNED":
      return `Keeper · $${event.price}`;
    case "AUCTION_NOMINATION_STARTED":
      return `Nomination ${event.nominationNumber}`;
    case "AUCTION_BID_PLACED":
      return `Bid $${event.amount}`;
    case "AUCTION_PLAYER_SOLD":
      return `$${event.price}`;
    case "DRAFT_EVENT_REVERTED":
      return "Reverted";
  }
}

function randomMutationKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function draftDollar(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `$${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`;
}

export function DraftSessionWorkspace() {
  const accountId = useRef("");
  const mutationInFlight = useRef(false);
  const backgroundRefreshInFlight = useRef(false);
  const selectedRankingVersionRef = useRef("");
  const claimedDraftTeamAppliedRef = useRef("");
  const dashboardRequestRef = useRef<AbortController | null>(null);
  const dashboardRequestGate = useRef(new LatestRequest());
  const [bootState, setBootState] = useState<BootState>("loading");
  const [portfolio, setPortfolio] = useState<LeagueListResponse | null>(null);
  const [session, setSession] = useState<DraftSessionSnapshot | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedLeagueId, setSelectedLeagueId] = useState("");
  const [dashboard, setDashboard] = useState<LeagueDashboard | null>(null);
  const [dashboardLeagueId, setDashboardLeagueId] = useState("");
  const [dashboardState, setDashboardState] = useState<RequestState>("idle");
  const [mode, setMode] = useState<"snake" | "auction">("snake");
  const [teamOrder, setTeamOrder] = useState<readonly string[]>([]);
  const [budget, setBudget] = useState("200");
  const [minimumBid, setMinimumBid] = useState("1");
  const [reconnectId, setReconnectId] = useState("");
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [pollFailures, setPollFailures] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("ALL");
  const [selectedPlayerId, setSelectedPlayerId] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [salePrice, setSalePrice] = useState("1");
  const [rankingLists, setRankingLists] = useState<readonly RankingList[]>([]);
  const [selectedRankingListId, setSelectedRankingListId] = useState("");
  const [selectedRankingVersionId, setSelectedRankingVersionId] = useState("");
  const [rankingVersion, setRankingVersion] = useState<RankingVersion | null>(null);
  const [rankingState, setRankingState] = useState<RankingLoadState>("idle");
  const [rankingError, setRankingError] = useState("");
  const [draftMarket, setDraftMarket] = useState<DraftMarketBaseline | null>(null);
  const [draftMarketState, setDraftMarketState] = useState<RankingLoadState>("idle");
  const [boardSort, setBoardSort] = useState<DraftBoardSort>("rank");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("covered");
  const [showMockSetup, setShowMockSetup] = useState(false);
  const [mockSeed, setMockSeed] = useState("");
  const [mockTeamId, setMockTeamId] = useState("");
  const [localMock, setLocalMock] = useState<LocalDraftMock | null>(null);
  const [mockReplayEventId, setMockReplayEventId] = useState("");
  const [streamState, setStreamState] = useState<DraftStreamState>("polling");
  const [manualBackupState, setManualBackupState] = useState<RequestState>("idle");
  const [manualBackupOpen, setManualBackupOpen] = useState(false);
  // Freshness has to keep ageing while the poll is failing, otherwise a dead feed
  // sits on "updated 2s ago" for as long as nothing new arrives.
  const [clockMs, setClockMs] = useState(() => Date.now());

  const rememberSession = useCallback((next: DraftSessionSnapshot) => {
    localStorage.setItem(`laces-out:last-draft-session:${accountId.current}`, next.id);
    const url = new URL(window.location.href);
    url.searchParams.set("session", next.id);
    window.history.replaceState({}, "", url);
    setReconnectId(next.id);
    setSession(next);
  }, []);

  const loadSession = useCallback(
    async (
      draftId: string,
      options: { readonly background?: boolean; readonly quiet?: boolean } = {},
    ): Promise<boolean> => {
      const normalized = draftId.trim();
      if (!normalized) return false;
      if (!options.quiet) setRequestState("loading");
      try {
        const response = await fetch(`${apiBaseUrl}/v1/drafts/${encodeURIComponent(normalized)}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) {
          const problem = await readProblem(response);
          throw new Error(problemMessage(problem, "That draft session could not be opened."));
        }
        const parsed = parseDraftSession(await response.json());
        if (!parsed) throw new Error("The draft session response was invalid.");
        if (options.background) {
          setSession((current) => preferNewerDraftSnapshot(current, parsed));
        } else {
          rememberSession(parsed);
        }
        if (!options.quiet) {
          setNotice(`Reconnected at event ${parsed.sequence}. Laces Out ledger is current.`);
        }
        setLastSyncedAt(Date.now());
        setPollFailures(0);
        return true;
      } catch (error) {
        if (!options.quiet) {
          setNotice(error instanceof Error ? error.message : "That session could not be opened.");
        }
        // The background poll is quiet, so without this a dead connection left
        // the header asserting "auto-refresh on" against a frozen sequence —
        // and a follow-only viewer has no write path that would reveal it.
        setPollFailures((current) => current + 1);
        return false;
      } finally {
        if (!options.quiet) setRequestState("idle");
      }
    },
    [rememberSession],
  );

  const bootstrap = useCallback(async () => {
    setBootState("loading");
    setNotice("");
    try {
      const sessionResponse = await fetch(`${apiBaseUrl}/v1/auth/session`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (sessionResponse.status === 401) {
        setBootState("signed-out");
        return;
      }
      if (!sessionResponse.ok) {
        throw new Error("Your account session could not be verified.");
      }
      const account = parseAuthenticatedSession(await sessionResponse.json());
      if (!account) throw new Error("Your account session could not be verified.");
      accountId.current = account.user.id;
      const leaguesResponse = await fetch(`${apiBaseUrl}/v1/leagues`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!leaguesResponse.ok) throw new Error("Your synchronized leagues could not be loaded.");
      const leagues = parseLeagueListResponse(await leaguesResponse.json());
      if (!leagues) throw new Error("The league list response was invalid.");
      setPortfolio(leagues);
      const firstLeague = leagues.leagues.find((league) => league.season !== null);
      setSelectedLeagueId(firstLeague?.id ?? "");
      setBootState("ready");

      const queryId = new URLSearchParams(window.location.search).get("session");
      const rememberedId = localStorage.getItem(`laces-out:last-draft-session:${account.user.id}`);
      const candidate = queryId ?? rememberedId;
      if (candidate) {
        setReconnectId(candidate);
        const opened = await loadSession(candidate, { quiet: true });
        if (!opened && queryId) setNotice("That shared session is unavailable to this account.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The draft room could not load.");
      setBootState("error");
    }
  }, [loadSession]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const refreshInBackground = useCallback(
    (draftId: string) => {
      if (mutationInFlight.current || backgroundRefreshInFlight.current) return;
      backgroundRefreshInFlight.current = true;
      void loadSession(draftId, { background: true, quiet: true }).finally(() => {
        backgroundRefreshInFlight.current = false;
      });
    },
    [loadSession],
  );

  useEffect(() => {
    if (!session) return;
    const draftId = session.id;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      refreshInBackground(draftId);
    };
    // Kept at five seconds unconditionally. The stream is a latency optimization, not
    // the correctness path, so every viewer converges even if it never connects.
    const interval = window.setInterval(refresh, 5_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshInBackground, session?.id]);

  useEffect(() => {
    if (!session) return;
    const draftId = session.id;
    // A build or browser without EventSource is not an error: the poll above is the
    // contract, and the strip says "checking every 5 seconds" rather than warning.
    if (typeof EventSource === "undefined") {
      setStreamState("polling");
      return;
    }
    setStreamState("connecting");
    const subscription = subscribeToDraftStream({
      draftId,
      url: `${apiBaseUrl}/v1/drafts/${encodeURIComponent(draftId)}/stream`,
      connect: browserDraftStreamConnect,
      onInvalidate: () => refreshInBackground(draftId),
      onStateChange: setStreamState,
      setTimer: (handler, delayMs) => window.setTimeout(handler, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle),
    });
    // A backgrounded tab can have its stream dropped past the retry ceiling; give it a
    // fresh chance the moment someone looks at the draft again.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") subscription.retry();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      subscription.close();
    };
  }, [refreshInBackground, session?.id]);

  const providerBackedSession = session?.providerFeed !== null && session !== null;
  useEffect(() => {
    if (!providerBackedSession) return;
    const tick = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, [providerBackedSession]);

  useEffect(() => {
    dashboardRequestRef.current?.abort();
    dashboardRequestRef.current = null;
    dashboardRequestGate.current.invalidate();
    setDashboard(null);
    setDashboardLeagueId("");
    setTeamOrder([]);
    if (!portfolio || !selectedLeagueId) {
      setDashboardState("idle");
      return;
    }
    const selected = portfolio.leagues.find((league) => league.id === selectedLeagueId);
    const configuredMode = selected?.season?.draftType.toLowerCase().includes("auction")
      ? "auction"
      : "snake";
    setMode(configuredMode);
    setDashboardState("loading");
    const controller = new AbortController();
    const request = dashboardRequestGate.current.begin(selectedLeagueId);
    dashboardRequestRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted && dashboardRequestGate.current.isCurrent(request);
    void fetch(`${apiBaseUrl}/v1/leagues/${encodeURIComponent(selectedLeagueId)}/dashboard`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("League setup details could not be loaded.");
        const parsed = parseLeagueDashboard(await response.json());
        if (!parsed) throw new Error("League setup details were invalid.");
        if (!isCurrent()) return;
        setDashboard(parsed);
        setDashboardLeagueId(selectedLeagueId);
        setTeamOrder(parsed.teams.map((team) => team.id));
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setDashboard(null);
        setDashboardLeagueId("");
        setTeamOrder([]);
        setNotice(error instanceof Error ? error.message : "League setup could not be loaded.");
      })
      .finally(() => {
        if (!isCurrent()) return;
        dashboardRequestRef.current = null;
        setDashboardState("idle");
      });
    return () => {
      controller.abort();
      if (dashboardRequestRef.current === controller) dashboardRequestRef.current = null;
      dashboardRequestGate.current.invalidate();
    };
  }, [portfolio, selectedLeagueId]);

  function selectLeagueForSetup(leagueId: string) {
    dashboardRequestRef.current?.abort();
    dashboardRequestRef.current = null;
    dashboardRequestGate.current.invalidate();
    setDashboard(null);
    setDashboardLeagueId("");
    setTeamOrder([]);
    setDashboardState(leagueId ? "loading" : "idle");
    setSelectedLeagueId(leagueId);
  }

  const selectedLeague = portfolio?.leagues.find(
    (league) => league.season?.id === session?.leagueSeasonId,
  );
  const draftLeagueId = selectedLeague?.id;
  const draftSeason = selectedLeague?.season?.season;
  // The practice room has always shown byes; the real room had none until now.
  const byeWeeks = useByeWeeks(draftSeason);

  useEffect(() => {
    if (!session) {
      setDraftMarket(null);
      setDraftMarketState("idle");
      return;
    }
    let cancelled = false;
    setDraftMarket(null);
    setDraftMarketState("loading");
    void fetch(`${apiBaseUrl}/v1/drafts/${encodeURIComponent(session.id)}/market`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Draft-market context could not be loaded.");
        const parsed = parseDraftMarketBaseline(await response.json());
        if (!parsed) throw new Error("Draft-market context response was invalid.");
        if (cancelled) return;
        setDraftMarket(parsed);
        setDraftMarketState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDraftMarket(null);
        setDraftMarketState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session || !draftLeagueId || draftSeason === undefined) {
      setRankingLists([]);
      setSelectedRankingListId("");
      setSelectedRankingVersionId("");
      setRankingVersion(null);
      setRankingState("idle");
      setRankingError("");
      return;
    }
    let cancelled = false;
    selectedRankingVersionRef.current = "";
    setRankingVersion(null);
    setRankingState("loading");
    setRankingError("");
    void fetch(`${apiBaseUrl}/v1/rankings`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Draft boards could not be loaded.");
        const lists = parseRankingListResponse(await response.json());
        if (!lists) throw new Error("The draft board list response was invalid.");
        const compatible = lists.filter(
          (list) =>
            list.archivedAt === null &&
            list.season === draftSeason &&
            list.currentVersionId !== null &&
            (list.scoringContext.leagueId === null ||
              list.scoringContext.leagueId === draftLeagueId),
        );
        if (cancelled) return;
        setRankingLists(compatible);
        setSelectedRankingListId((current) =>
          compatible.some((list) => list.id === current) ? current : (compatible[0]?.id ?? ""),
        );
        if (compatible.length === 0) {
          setSelectedRankingVersionId("");
          setRankingVersion(null);
          setRankingState("ready");
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRankingLists([]);
        setSelectedRankingListId("");
        setSelectedRankingVersionId("");
        setRankingVersion(null);
        setRankingState("error");
        setRankingError(error instanceof Error ? error.message : "Draft boards could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [draftLeagueId, draftSeason, session?.id]);

  const selectedRankingList = rankingLists.find((list) => list.id === selectedRankingListId);
  const selectableRankingVersions = useMemo(() => {
    if (!selectedRankingList) return [];
    const versions: { readonly id: string; readonly label: string }[] = [];
    if (selectedRankingList.currentVersionId) {
      versions.push({ id: selectedRankingList.currentVersionId, label: "Current working version" });
    }
    if (
      selectedRankingList.latestPublishedVersionId &&
      selectedRankingList.latestPublishedVersionId !== selectedRankingList.currentVersionId
    ) {
      versions.push({
        id: selectedRankingList.latestPublishedVersionId,
        label: "Latest published version",
      });
    }
    return versions;
  }, [selectedRankingList]);

  useEffect(() => {
    if (!selectedRankingList || selectableRankingVersions.length === 0) return;
    setSelectedRankingVersionId((current) =>
      selectableRankingVersions.some((version) => version.id === current)
        ? current
        : (selectableRankingVersions[0]?.id ?? ""),
    );
  }, [selectableRankingVersions, selectedRankingList]);

  useEffect(() => {
    if (!selectedRankingListId || !selectedRankingVersionId) return;
    let cancelled = false;
    setRankingState("loading");
    setRankingError("");
    const query = new URLSearchParams({ versionId: selectedRankingVersionId });
    void fetch(
      `${apiBaseUrl}/v1/rankings/${encodeURIComponent(selectedRankingListId)}/version?${query.toString()}`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("The selected draft board version could not be loaded.");
        const version = parseRankingVersionResponse(await response.json());
        if (!version) throw new Error("The selected draft board version was invalid.");
        if (cancelled) return;
        setRankingVersion(version);
        setRankingState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRankingVersion(null);
        setRankingState("error");
        setRankingError(
          error instanceof Error ? error.message : "The selected draft board could not load.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRankingListId, selectedRankingVersionId, session?.id]);

  const activeDraftState = localMock?.state ?? session?.state;
  const availablePlayers = useMemo(() => {
    if (!session || !activeDraftState) return [];
    const drafted = new Set(activeDraftState.draftedPlayerIds);
    return session.config.players.filter((player) => !drafted.has(player.id));
  }, [activeDraftState, session]);

  const boardValues = useMemo<readonly DraftBoardValue[]>(() => {
    const values = new Map<string, DraftBoardValue>();
    if (draftMarket?.state === "available") {
      for (const row of draftMarket.players) {
        values.set(row.playerId, {
          playerId: row.playerId,
          overallRank: null,
          positionRank: row.positionRank,
          tier: null,
          adp: row.overallAdp,
          adpStandardDeviation: row.standardDeviation,
          adpSampleSize: row.sampleSize,
          aav: null,
          targetPrice: null,
          ceilingPrice: null,
          target: false,
          avoid: false,
        });
      }
    }
    for (const entry of rankingVersion?.entries ?? []) {
      const market = values.get(entry.playerId);
      const authoredAdp = entry.adp?.value ?? null;
      values.set(entry.playerId, {
        playerId: entry.playerId,
        overallRank: entry.overallRank?.value ?? null,
        positionRank: entry.positionRank?.value ?? market?.positionRank ?? null,
        tier: entry.tier?.value ?? null,
        adp: authoredAdp ?? market?.adp ?? null,
        adpStandardDeviation: authoredAdp === null ? (market?.adpStandardDeviation ?? null) : null,
        adpSampleSize: authoredAdp === null ? (market?.adpSampleSize ?? null) : null,
        aav: entry.aav?.value ?? null,
        targetPrice: entry.targetPrice?.value ?? null,
        ceilingPrice: entry.ceilingPrice?.value ?? null,
        target: entry.target?.value === true,
        avoid: entry.avoid?.value === true,
      });
    }
    return [...values.values()];
  }, [draftMarket, rankingVersion]);

  const boardRows = useMemo(
    () => buildDraftBoardRows(availablePlayers, boardValues, boardSort),
    [availablePlayers, boardSort, boardValues],
  );
  const coveredPlayerCount = useMemo(
    () => boardRows.reduce((count, row) => count + Number(row.covered), 0),
    [boardRows],
  );
  const mockAvailability = useMemo(
    () => (session ? draftMockAvailability(session, boardValues) : null),
    [boardValues, session],
  );

  const positions = useMemo(
    () => ["ALL", ...new Set(availablePlayers.flatMap((player) => player.positions))],
    [availablePlayers],
  );

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return boardRows
      .filter(
        (row) =>
          (coverageFilter === "covered"
            ? row.covered
            : query.length > 0 && (coverageFilter === "all" || !row.covered)) &&
          (position === "ALL" || row.player.positions.some((item) => item === position)) &&
          (!query ||
            `${row.player.name} ${row.player.positions.join(" ")} ${row.player.nflTeam ?? ""}`
              .toLowerCase()
              .includes(query)),
      )
      .slice(0, 250);
  }, [boardRows, coverageFilter, position, search]);

  /* The ledger renders at 1 Hz during provider-backed drafts: reversing the
     full event list and scanning the player pool per row are per-render costs
     worth paying once per snapshot instead. */
  const recentEvents = useMemo(
    () => (session ? [...session.events].reverse().slice(0, 12) : []),
    [session],
  );
  const playersById = useMemo(
    () => new Map((session?.config.players ?? []).map((player) => [player.id, player])),
    [session?.config.players],
  );
  const teamsById = useMemo(
    () => new Map((session?.config.teams ?? []).map((team) => [team.id, team])),
    [session?.config.teams],
  );

  useEffect(() => {
    if (!session) return;
    if (!availablePlayers.some((player) => player.id === selectedPlayerId)) {
      setSelectedPlayerId(boardRows.find((row) => row.covered)?.player.id ?? "");
    }
    if (!session.config.teams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(session.config.teams[0]?.id ?? "");
    }
    if (session.config.mode === "AUCTION") setSalePrice(String(session.config.minimumBid));
  }, [availablePlayers, boardRows, selectedPlayerId, selectedTeamId, session]);

  useEffect(() => {
    const claimedTeamId =
      dashboardLeagueId === draftLeagueId ? dashboard?.membership.claimedFantasyTeamId : null;
    if (
      session &&
      claimedTeamId &&
      claimedDraftTeamAppliedRef.current !== session.id &&
      session.config.teams.some((team) => team.id === claimedTeamId)
    ) {
      claimedDraftTeamAppliedRef.current = session.id;
      setSelectedTeamId(claimedTeamId);
    }
  }, [dashboard?.membership.claimedFantasyTeamId, dashboardLeagueId, draftLeagueId, session]);

  useEffect(() => {
    if (!session) {
      setLocalMock(null);
      setShowMockSetup(false);
      setMockReplayEventId("");
      return;
    }
    setLocalMock((current) => (current?.sourceSessionId === session.id ? current : null));
    setMockSeed((current) => current || `laces-${session.id.slice(0, 8)}`);
    setMockTeamId((current) =>
      session.config.teams.some((team) => team.id === current)
        ? current
        : session.config.teams.some((team) => team.id === selectedTeamId)
          ? selectedTeamId
          : (session.config.teams[0]?.id ?? ""),
    );
  }, [selectedTeamId, session]);

  useEffect(() => {
    if (!rankingVersion) return;
    if (selectedRankingVersionRef.current === rankingVersion.id) return;
    selectedRankingVersionRef.current = rankingVersion.id;
    setSelectedPlayerId((current) => {
      const currentRow = boardRows.find((row) => row.player.id === current);
      return currentRow?.covered
        ? current
        : (boardRows.find((row) => row.covered)?.player.id ?? "");
    });
  }, [boardRows, rankingVersion?.id]);

  const selectedPlayer = session?.config.players.find((player) => player.id === selectedPlayerId);
  const selectedBoardRow = boardRows.find((row) => row.player.id === selectedPlayerId);
  const canMutate = session?.accessRole === "owner" || session?.accessRole === "commissioner";
  // Provider and manual control must never interleave invisibly (§16.5): typing a pick into a
  // room a live feed is still driving is how duplicates get made. Manual backup is the door.
  const providerLocksManualEntry =
    session !== null &&
    session.transport !== "manual" &&
    session.providerFeed !== null &&
    !session.providerFeed.manualBackupActive;
  const canRecord = localMock !== null || (canMutate && !providerLocksManualEntry);
  const teamStates = activeDraftState?.teams ?? EMPTY_TEAM_STATES;
  const selectedTeam = teamStates.find((team) => team.teamId === selectedTeamId);
  const onClockTeamId =
    session?.config.mode === "SNAKE" ? activeDraftState?.nextPick?.teamId : undefined;
  const onClockTeam = teamStates.find((team) => team.teamId === onClockTeamId);
  const activeTeamId =
    localMock?.controlledTeamId ??
    (session?.config.teams.some((team) => team.id === selectedTeamId) === true
      ? selectedTeamId
      : onClockTeamId);
  const activeTeam = teamStates.find((team) => team.teamId === activeTeamId);
  const localAwaitingSelection =
    localMock !== null &&
    (localMock.stopReason === "CONTROLLED_PICK" ||
      localMock.stopReason === "CONTROLLED_NOMINATION");
  const activeTeamNextPick =
    session?.config.mode === "SNAKE" && activeDraftState?.nextPick && activeTeamId
      ? nextPickForTeam(
          session.config.pickOrder,
          activeDraftState.nextPick.overallPick,
          activeTeamId,
        )
      : null;
  const snakeQueue = useMemo(() => {
    if (!session || session.config.mode !== "SNAKE" || !activeTeamId || !activeTeam) return [];
    const team = session.config.teams.find((candidate) => candidate.id === activeTeamId);
    if (!team) return [];
    return buildSnakeBestNowQueue({
      availablePlayers,
      values: boardValues,
      allPlayers: session.config.players,
      rosteredPlayerIds: activeTeam.roster.map((item) => item.playerId),
      rosterSlots: team.rosterSlots,
      ...(activeDraftState?.nextPick ? { currentPick: activeDraftState.nextPick.overallPick } : {}),
      nextPick: activeTeamNextPick,
      limit: 5,
    });
  }, [
    activeDraftState?.nextPick,
    activeTeam,
    activeTeamId,
    activeTeamNextPick,
    availablePlayers,
    boardValues,
    session,
  ]);
  const auctionAnalysis = useMemo(() => {
    if (!session || session.config.mode !== "AUCTION") return null;
    return analyzeAuctionBoard({
      availablePlayerIds: availablePlayers.map((player) => player.id),
      values: boardValues,
      teams: teamStates.map((team) => ({
        teamId: team.teamId,
        remainingBudget: team.remainingBudget,
        openSlots: team.openSlots,
      })),
      selectedPlayerId,
      selectedTeamId,
      minimumBid: session.config.minimumBid,
    });
  }, [availablePlayers, boardValues, selectedPlayerId, selectedTeamId, session, teamStates]);
  const auctionNominations = useMemo(
    () =>
      session?.config.mode === "AUCTION"
        ? buildAuctionNominationQueue({
            availablePlayers,
            values: boardValues,
            limit: 5,
          })
        : [],
    [availablePlayers, boardValues, session?.config.mode],
  );

  function moveTeam(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= teamOrder.length) return;
    setTeamOrder((current) => {
      const next = [...current];
      const selected = next[index];
      const displaced = next[destination];
      if (!selected || !displaced) return current;
      next[index] = displaced;
      next[destination] = selected;
      return next;
    });
  }

  async function createSession() {
    const league = portfolio?.leagues.find((item) => item.id === selectedLeagueId);
    if (!league?.season || !dashboard || dashboardLeagueId !== selectedLeagueId) return;
    setRequestState("loading");
    setNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/drafts`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueSeasonId: league.season.id,
          mode,
          ...(mode === "snake"
            ? { teamOrder }
            : { budgetPerTeam: Number(budget), minimumBid: Number(minimumBid) }),
        }),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new Error(problemMessage(problem, "The draft session could not be created."));
      }
      const parsed = parseDraftSession(await response.json());
      if (!parsed) throw new Error("The new draft session response was invalid.");
      rememberSession(parsed);
      setNotice(
        parsed.transport === "espn-live"
          ? "Shared draft room created and attached to the ESPN live feed. Picks arrive once a paired desktop browser opens the ESPN draft room."
          : "Shared draft ledger created. Entries are recorded by hand here; no provider feed is attached to this room.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The draft session could not be created.");
    } finally {
      setRequestState("idle");
    }
  }

  async function mutate(path: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    if (!session || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setRequestState("loading");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/drafts/${session.id}/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = await readProblem(response);
        if (response.status === 409 && typeof problem?.currentSequence === "number") {
          // Not quiet: this is the recovery path for an out-of-sync client, and
          // silencing it meant the resync could fail without anyone knowing.
          await loadSession(session.id, {});
        }
        throw new Error(problemMessage(problem, "The draft ledger rejected that entry."));
      }
      const parsed = parseDraftMutation(await response.json());
      if (!parsed) throw new Error("The draft mutation response was invalid.");
      rememberSession(parsed.session);
      setNotice(
        parsed.idempotent
          ? `Entry ${parsed.appendedSequences.join(", ")} was already safely recorded.`
          : `Recorded event ${parsed.appendedSequences.join(", ")}.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The draft ledger rejected that entry.");
    } finally {
      mutationInFlight.current = false;
      setRequestState("idle");
    }
  }

  /**
   * Manual backup is a shared-state change, so it goes through the API rather than local state:
   * every viewer must see the same freeze. The server keeps validating and counting incoming
   * provider snapshots while it is on, which is what `pendingReconciliation` reports.
   */
  async function setManualBackup(
    active: boolean,
    reconciliation?: "accept-provider" | "keep-manual",
  ): Promise<void> {
    if (!session || !canMutate || manualBackupState === "loading") return;
    setManualBackupState("loading");
    try {
      const response = await fetch(`${apiBaseUrl}/v1/drafts/${session.id}/manual-backup`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedSequence: session.sequence,
          idempotencyKey: randomMutationKey("manual-backup"),
          active,
          ...(reconciliation ? { reconciliation } : {}),
        }),
      });
      if (response.status === 404) {
        throw new Error("This server does not offer manual backup control yet.");
      }
      if (!response.ok) {
        const problem = await readProblem(response);
        throw new Error(problemMessage(problem, "Manual backup could not be changed."));
      }
      const body: unknown = await response.json();
      const mutation = parseDraftMutation(body);
      const next = mutation?.session ?? parseDraftSession(body);
      if (!next) throw new Error("The manual backup response was invalid.");
      rememberSession(next);
      setManualBackupOpen(false);
      setNotice(
        active
          ? "Manual backup active. Provider picks are held for review until you return to provider sync."
          : reconciliation === "keep-manual"
            ? "Returned to provider sync. The held provider differences were discarded in favor of this ledger."
            : reconciliation === "accept-provider"
              ? "Returned to provider sync. The held provider board was applied to this ledger."
              : "Returned to provider sync.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Manual backup could not be changed.");
    } finally {
      setManualBackupState("idle");
    }
  }

  function startLocalMock() {
    if (!session) return;
    try {
      const created = createLocalDraftMock(session, boardValues, mockSeed, mockTeamId);
      setLocalMock(created);
      setSelectedTeamId(mockTeamId);
      setMockReplayEventId("");
      setShowMockSetup(false);
      setNotice(
        `Local mock started from room event ${session.sequence}. Nothing in this simulation is saved or sent to a fantasy provider.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The local mock could not start.");
    }
  }

  function advanceMock(target: "event" | "controlled-turn") {
    if (!localMock) return;
    try {
      const previousCount = localMock.events.length;
      const next = advanceLocalDraftMock(localMock, target);
      setLocalMock(next);
      const added = next.events.length - previousCount;
      if (next.stopReason === "CONTROLLED_PICK") {
        setNotice(
          added > 0
            ? `Simulated ${added} local event${added === 1 ? "" : "s"}. Your team is on the clock.`
            : "Your team is on the clock. Select a player from the board to make the local pick.",
        );
      } else if (next.stopReason === "CONTROLLED_NOMINATION") {
        setNotice(
          added > 0
            ? `Simulated ${added} local event${added === 1 ? "" : "s"}. Choose your nomination.`
            : "Choose a player from the board to make your local nomination.",
        );
      } else if (next.stopReason === "COMPLETE") {
        setNotice("Local mock complete. The shared room remains unchanged.");
      } else if (next.stopReason === "PLAYER_POOL_EXHAUSTED") {
        setNotice(
          "The local model ran out of legally rosterable players with the required board data.",
        );
      } else {
        setNotice(`Advanced ${added || 0} local event${added === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The local mock could not advance.");
    }
  }

  function stopLocalMock() {
    setLocalMock(null);
    setMockReplayEventId("");
    setNotice("Local mock closed. The shared manual room was never changed.");
  }

  function replayMockFromEvent(eventId = mockReplayEventId) {
    if (!localMock || !eventId) return;
    try {
      const replayed = replayLocalDraftFromEvent(localMock, eventId);
      setLocalMock(replayed);
      setMockReplayEventId(eventId);
      setNotice("Replayed locally from that event using the same seed.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That local replay could not run.");
    }
  }

  async function recordSelection() {
    if (!session || !selectedPlayer) return;
    if (localMock) {
      try {
        const next = recordLocalControlledSelection(
          localMock,
          selectedPlayer.id,
          `local-${crypto.randomUUID()}`,
        );
        setLocalMock(next);
        setNotice(
          session.config.mode === "SNAKE"
            ? `${selectedPlayer.name} added to your local mock roster. Advance when ready.`
            : `${selectedPlayer.name} nominated locally. The model will resolve bidding when you advance.`,
        );
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "That local action was rejected.");
      }
      return;
    }
    if (!canMutate) return;
    if (session.config.mode === "SNAKE") {
      const nextPick = session.state.nextPick;
      if (!nextPick) return;
      await mutate("events", {
        expectedSequence: session.sequence,
        idempotencyKey: randomMutationKey("snake-pick"),
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: nextPick.teamId,
          playerId: selectedPlayer.id,
          overallPick: nextPick.overallPick,
        },
      });
      return;
    }
    const price = Number(salePrice);
    const teamState = session.state.teams.find((team) => team.teamId === selectedTeamId);
    if (!Number.isSafeInteger(price) || price < session.config.minimumBid) {
      setNotice(`Sale price must be at least $${session.config.minimumBid}.`);
      return;
    }
    if (teamState?.maximumBid !== undefined && price > teamState.maximumBid) {
      setNotice(`${teamState.name} has a legal maximum bid of $${teamState.maximumBid}.`);
      return;
    }
    await mutate("events", {
      expectedSequence: session.sequence,
      idempotencyKey: randomMutationKey("auction-sale"),
      action: {
        type: "AUCTION_PLAYER_SOLD",
        teamId: selectedTeamId,
        playerId: selectedPlayer.id,
        price,
      },
    });
  }

  async function undoLast() {
    if (localMock) {
      const before = localMock.events.length;
      const next = undoLatestLocalDraftEvent(localMock, `local-undo-${crypto.randomUUID()}`);
      setLocalMock(next);
      setNotice(
        next.events.length === before
          ? "There is no active local mock event to undo."
          : "Latest local mock event undone. The shared room remains unchanged.",
      );
      return;
    }
    if (!session || !canMutate || session.sequence === 0) return;
    await mutate("undo", {
      expectedSequence: session.sequence,
      idempotencyKey: randomMutationKey("draft-undo"),
    });
  }

  function closeSession() {
    localStorage.removeItem(`laces-out:last-draft-session:${accountId.current}`);
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState({}, "", url);
    setSession(null);
    setNotice("Session closed on this device. Its stored event ledger was not deleted.");
  }

  async function copySessionLink() {
    if (!session) return;
    const url = new URL(window.location.href);
    url.searchParams.set("session", session.id);
    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice("Session link copied. League membership is still required to open it.");
    } catch {
      setNotice(`Share this session ID: ${session.id}`);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if ((key === "j" || key === "k") && !event.shiftKey && filteredRows.length > 0) {
        event.preventDefault();
        const currentIndex = filteredRows.findIndex((row) => row.player.id === selectedPlayerId);
        const direction = key === "j" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? direction > 0
              ? 0
              : filteredRows.length - 1
            : Math.min(filteredRows.length - 1, Math.max(0, currentIndex + direction));
        const next = filteredRows[nextIndex];
        if (next) setSelectedPlayerId(next.player.id);
        return;
      }
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.repeat &&
        canRecord &&
        requestState !== "loading" &&
        !activeDraftState?.complete
      ) {
        event.preventDefault();
        void recordSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDraftState?.complete, canRecord, filteredRows, requestState, selectedPlayerId]);

  if (showDemo || bootState === "signed-out") return <DemoDraftWorkspace />;

  if (bootState === "loading") {
    return (
      <div className="draft-session-gate" role="status">
        <LoaderCircle className="spin" size={22} />
        <div>
          <strong>Opening draft studio</strong>
          <span>Checking your account and synchronized leagues.</span>
        </div>
      </div>
    );
  }

  if (bootState === "error") {
    return (
      <section className="panel draft-session-gate">
        <span className="draft-session-gate__icon">
          <CircleAlert size={20} />
        </span>
        <div>
          <p className="eyebrow">Draft studio</p>
          <h1>Live draft data is unavailable.</h1>
          <p>{notice}</p>
          <div className="draft-session-actions">
            <button className="button button--dark" type="button" onClick={() => void bootstrap()}>
              Retry <RefreshCw size={14} />
            </button>
            <button className="button button--soft" type="button" onClick={() => setShowDemo(true)}>
              View labeled demo
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!session) {
    const league = portfolio?.leagues.find((item) => item.id === selectedLeagueId);
    const mayCreate =
      league?.membership.role === "owner" || league?.membership.role === "commissioner";
    return (
      <div className="draft-page draft-session-setup">
        <header className="page-heading">
          <div>
            <Link className="back-link" href="/app">
              <ArrowLeft size={16} /> Overview
            </Link>
            <p className="eyebrow">Draft studio</p>
            <h1>Start or reopen a draft room.</h1>
            <p className="page-subtitle">
              {describeDraftSetupCapability(league?.season?.provider ?? null)}
            </p>
          </div>
          <button className="button button--soft" type="button" onClick={() => setShowDemo(true)}>
            View sample draft
          </button>
        </header>

        {notice ? (
          <div className="draft-notice draft-notice--paused" role="status">
            <span>
              <CircleAlert size={14} /> {notice}
            </span>
          </div>
        ) : null}

        <div className="draft-session-setup-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">New room</p>
                <h2>Configure from a connected league</h2>
                <p>Roster slots, teams, and the player pool are copied when you start.</p>
              </div>
              <Database size={18} />
            </div>
            {portfolio?.leagues.some((item) => item.season !== null) ? (
              <div className="draft-session-form">
                <label>
                  <span>League season</span>
                  <select
                    value={selectedLeagueId}
                    onChange={(event) => selectLeagueForSetup(event.target.value)}
                  >
                    {portfolio.leagues.flatMap((item) =>
                      item.season
                        ? [
                            <option value={item.id} key={item.id}>
                              {item.name} · {item.season.season} ·{" "}
                              {providerLabel(item.season.provider)}
                            </option>,
                          ]
                        : [],
                    )}
                  </select>
                </label>
                <fieldset>
                  <legend>Draft format</legend>
                  <div className="mode-switch">
                    <button
                      type="button"
                      className={mode === "snake" ? "is-active" : ""}
                      aria-pressed={mode === "snake"}
                      onClick={() => setMode("snake")}
                    >
                      Snake
                    </button>
                    <button
                      type="button"
                      className={mode === "auction" ? "is-active" : ""}
                      aria-pressed={mode === "auction"}
                      onClick={() => setMode("auction")}
                    >
                      Auction
                    </button>
                  </div>
                </fieldset>
                {mode === "auction" ? (
                  <div className="draft-session-money-grid">
                    <label>
                      <span>Budget per team</span>
                      <input
                        inputMode="numeric"
                        value={budget}
                        onChange={(event) => setBudget(event.target.value.replace(/[^0-9]/g, ""))}
                      />
                    </label>
                    <label>
                      <span>Minimum bid</span>
                      <input
                        inputMode="numeric"
                        value={minimumBid}
                        onChange={(event) =>
                          setMinimumBid(event.target.value.replace(/[^0-9]/g, ""))
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <div className="draft-session-order">
                    <div>
                      <strong>Snake order</strong>
                      <span>Move teams into their actual first-round order.</span>
                    </div>
                    {dashboardState === "loading" ? (
                      <span className="draft-session-inline-loading">
                        <LoaderCircle className="spin" size={14} /> Loading teams
                      </span>
                    ) : null}
                    {teamOrder.map((teamId, index) => {
                      const team = dashboard?.teams.find((item) => item.id === teamId);
                      return (
                        <div className="draft-session-order-row" key={teamId}>
                          <span>{index + 1}</span>
                          <strong>{team?.name ?? teamId}</strong>
                          <button
                            type="button"
                            onClick={() => moveTeam(index, -1)}
                            disabled={index === 0}
                            aria-label={`Move ${team?.name ?? "team"} up`}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveTeam(index, 1)}
                            disabled={index === teamOrder.length - 1}
                            aria-label={`Move ${team?.name ?? "team"} down`}
                          >
                            <ArrowDown size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!mayCreate ? (
                  <p className="draft-session-permission">
                    <ShieldCheck size={14} /> Only the league owner or a commissioner can create the
                    shared room. Members can reopen one by ID.
                  </p>
                ) : null}
                <button
                  className="button button--dark"
                  type="button"
                  onClick={() => void createSession()}
                  disabled={
                    !dashboard ||
                    dashboardLeagueId !== selectedLeagueId ||
                    dashboardState === "loading" ||
                    !mayCreate ||
                    requestState === "loading"
                  }
                >
                  {requestState === "loading" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Play size={14} />
                  )}{" "}
                  Start shared room
                </button>
              </div>
            ) : (
              <div className="draft-session-empty">
                <Users size={20} />
                <strong>No synchronized league season is available.</strong>
                <Link href="/connections">Connect a league first</Link>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Reconnect</p>
                <h2>Open an existing room</h2>
                <p>Use the ID from this device or a league mate’s shared link.</p>
              </div>
              <Link2 size={18} />
            </div>
            <div className="draft-session-reconnect">
              <label>
                <span>Draft session ID</span>
                <input
                  value={reconnectId}
                  onChange={(event) => setReconnectId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                />
              </label>
              <button
                className="button button--soft"
                type="button"
                onClick={() => void loadSession(reconnectId)}
                disabled={!reconnectId.trim() || requestState === "loading"}
              >
                {requestState === "loading" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}{" "}
                Reconnect
              </button>
              <p>
                <ShieldCheck size={14} /> The API verifies league membership before returning any
                draft data.
              </p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const generatedMockEvents = localMock ? [...localMockEvents(localMock)] : [];
  const recordDisabled =
    !selectedPlayer ||
    !canRecord ||
    activeDraftState?.complete ||
    requestState === "loading" ||
    (localMock !== null && !localAwaitingSelection);
  const recordActionLabel = localMock
    ? session.config.mode === "AUCTION"
      ? "Nominate in local mock"
      : `Make local pick ${activeDraftState?.nextPick?.overallPick ?? "—"}`
    : session.config.mode === "AUCTION"
      ? `Record sale${salePrice ? ` at $${salePrice}` : ""}`
      : `Record pick ${activeDraftState?.nextPick?.overallPick ?? "—"}`;
  const mobileSnakeRecommendation = session.config.mode === "SNAKE" ? snakeQueue[0] : undefined;
  const mobileAuctionRecommendation =
    session.config.mode === "AUCTION" ? auctionNominations[0] : undefined;
  const mobileRecommendation =
    mobileSnakeRecommendation?.player ?? mobileAuctionRecommendation?.player;
  const mobileRecommendationNote =
    mobileSnakeRecommendation?.needLabel ??
    mobileAuctionRecommendation?.reason ??
    (session.config.mode === "SNAKE" ? "Best available fit" : "Nomination board");
  const liveStatus = describeLiveDraft({
    session,
    pollFailures,
    lastSyncedAt,
    now: clockMs,
    streaming: streamState === "streaming",
    localMock: localMock !== null,
  });
  const liveStrip = liveStatus.strip;
  const manualBackup = liveStatus.manualBackup;
  const mobileDecision = describeMobileDecision(session, activeTeamId, liveStatus);
  const providerAuction = session.providerFeed?.currentAuction ?? null;
  const providerAuctionNominator = providerAuction?.nominatingTeamId
    ? session.config.teams.find((team) => team.id === providerAuction.nominatingTeamId)
    : undefined;
  const providerAuctionHighBidder = providerAuction?.highBidTeamId
    ? session.config.teams.find((team) => team.id === providerAuction.highBidTeamId)
    : undefined;

  return (
    <div className="draft-page draft-session-live">
      <header className="draft-header">
        <div className="draft-title-group">
          <button className="back-link" type="button" onClick={closeSession}>
            <ArrowLeft size={16} /> Draft rooms
          </button>
          <div className="draft-title-line">
            <div>
              <p className="eyebrow">
                {selectedLeague?.name ?? "Shared league"} · {session.config.mode.toLowerCase()}
              </p>
              <h1>Draft studio</h1>
            </div>
          </div>
        </div>
        <div className="draft-header-actions">
          <div className="connection-indicator">
            <span
              className={`connection-indicator__dot${
                liveStatus.indicator === "mock" ? " connection-indicator__dot--mock" : ""
              }${liveStatus.indicator === "stale" ? " connection-indicator__dot--stale" : ""}`}
            />
            <span>
              <strong>{liveStatus.indicatorTitle}</strong>
              <small>
                {localMock
                  ? `${generatedMockEvents.length} practice events · not saved`
                  : pollFailures > 0 && !liveStatus.providerBacked
                    ? `Event ${session.sequence} · ${staleFor(lastSyncedAt)}`
                    : liveStatus.indicatorDetail}
              </small>
            </span>
          </div>
          <button
            className="button button--soft button--small"
            type="button"
            onClick={() => setShowMockSetup((current) => !current)}
            aria-expanded={showMockSetup}
            aria-controls="draft-mock-panel"
          >
            <Dices size={14} /> {localMock ? "Mock settings" : "Start mock"}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void copySessionLink()}
            aria-label="Copy session link"
            title="Copy session link"
          >
            <Clipboard size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadSession(session.id)}
            aria-label="Reload draft session"
            title="Reload draft session"
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="button button--soft button--small"
            type="button"
            onClick={() => void undoLast()}
            disabled={
              localMock
                ? generatedMockEvents.length === 0
                : !canMutate || session.sequence === 0 || requestState === "loading"
            }
          >
            <RotateCcw size={14} /> {localMock ? "Undo local" : "Undo"}
          </button>
        </div>
      </header>

      <section
        className={`draft-notice${
          notice.toLowerCase().includes("reject") ||
          notice.toLowerCase().includes("could not") ||
          (!notice && (liveStatus.tone === "warning" || liveStatus.tone === "critical"))
            ? " draft-notice--paused"
            : ""
        }`}
        aria-live="polite"
      >
        <span>
          {localMock ? (
            <Dices size={14} />
          ) : liveStatus.tone === "critical" ? (
            <TriangleAlert size={14} />
          ) : liveStatus.providerBacked ? (
            <Radio size={14} />
          ) : (
            <Database size={14} />
          )}{" "}
          {notice || `${liveStatus.heading}. ${liveStatus.detail}`}
        </span>
        <span className="draft-notice__meta">
          <ShieldCheck size={14} /> {liveStatus.transportChip}
        </span>
      </section>

      {liveStrip ? (
        <section
          className={`draft-live-strip draft-live-strip--${liveStatus.tone}`}
          aria-label={`${liveStrip.providerName} live draft feed`}
        >
          <div className="draft-live-strip__status">
            <span
              className={`live-freshness-dot live-freshness-dot--${liveStrip.freshness}`}
              aria-hidden="true"
            />
            <span>
              <strong>{liveStrip.statusLabel}</strong>
              <small>{liveStrip.sourceLabel}</small>
            </span>
          </div>
          <dl className="draft-live-strip__facts">
            <div>
              <dt>{liveStrip.currentActionCaption}</dt>
              <dd>{liveStrip.currentActionLabel}</dd>
            </div>
            <div>
              <dt>Feed</dt>
              <dd>
                {liveStrip.freshnessLabel} · {liveStrip.lastAcceptedLabel}
              </dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>
                {liveStrip.pickCountLabel} · {liveStrip.updateChannelLabel}
              </dd>
            </div>
            <div>
              <dt>Mapping</dt>
              <dd>
                {liveStrip.issueCount > 0
                  ? `${liveStrip.issueCount} held for review`
                  : "All rows matched"}
              </dd>
            </div>
          </dl>
          <div className="draft-live-strip__notes">
            {liveStrip.issueLabel ? (
              <p className="draft-live-strip__issue">
                <TriangleAlert size={13} /> {liveStrip.issueLabel}
              </p>
            ) : null}
            {liveStrip.reconnectGuidance ? (
              <p className="draft-live-strip__guidance">{liveStrip.reconnectGuidance}</p>
            ) : null}
            {liveStatus.sourceRequirement ? (
              <p className="draft-live-strip__guidance">{liveStatus.sourceRequirement}</p>
            ) : null}
            {liveStrip.standbyLabel ? (
              <p className="draft-live-strip__meta">{liveStrip.standbyLabel}</p>
            ) : null}
            {liveStrip.verificationLabel ? (
              <p className="draft-live-strip__meta">{liveStrip.verificationLabel}</p>
            ) : null}
          </div>
          {manualBackup.available && manualBackup.authorized ? (
            <div className="draft-live-strip__actions">
              {manualBackup.active ? (
                manualBackup.requiresChoice ? (
                  <button
                    className="button button--soft button--small"
                    type="button"
                    onClick={() => setManualBackupOpen((current) => !current)}
                    aria-expanded={manualBackupOpen}
                    aria-controls="draft-manual-backup-panel"
                  >
                    {manualBackup.returnLabel}
                  </button>
                ) : (
                  <button
                    className="button button--dark button--small"
                    type="button"
                    onClick={() => void setManualBackup(false)}
                    disabled={manualBackupState === "loading"}
                  >
                    {manualBackupState === "loading" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Radio size={14} />
                    )}{" "}
                    {manualBackup.returnLabel}
                  </button>
                )
              ) : (
                <button
                  className="button button--soft button--small"
                  type="button"
                  onClick={() => void setManualBackup(true)}
                  disabled={manualBackupState === "loading"}
                >
                  {manualBackupState === "loading" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}{" "}
                  {manualBackup.activateLabel}
                </button>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {manualBackup.available && manualBackup.active ? (
        <section
          className="draft-manual-backup"
          id="draft-manual-backup-panel"
          aria-labelledby="draft-manual-backup-title"
        >
          <div className="draft-manual-backup__intro">
            <span className="draft-manual-backup__icon">
              <ShieldCheck size={18} />
            </span>
            <div>
              <p className="eyebrow">Conflict control</p>
              <h2 id="draft-manual-backup-title">Manual backup active</h2>
              <p>{manualBackup.summary}</p>
            </div>
            <span className="draft-manual-backup__count">
              <strong>{manualBackup.pendingReconciliation}</strong>
              <small>held {liveStatus.providerName} updates</small>
            </span>
          </div>
          {manualBackup.choiceSummary ? (
            <p className="draft-manual-backup__choice">{manualBackup.choiceSummary}</p>
          ) : null}
          {!manualBackup.authorized ? (
            <p className="draft-session-permission">
              <ShieldCheck size={14} /> You can follow this room, but only its owner or commissioner
              can change backup mode.
            </p>
          ) : manualBackup.requiresChoice ? (
            <div className="draft-manual-backup__actions">
              <button
                className="button button--dark button--small"
                type="button"
                onClick={() => void setManualBackup(false, "accept-provider")}
                disabled={manualBackupState === "loading"}
              >
                Apply the {liveStatus.providerName} board
              </button>
              <button
                className="button button--soft button--small"
                type="button"
                onClick={() => void setManualBackup(false, "keep-manual")}
                disabled={manualBackupState === "loading"}
              >
                Keep these manual entries
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {providerAuction ? (
        <section className="draft-live-auction" aria-label="Current auction nomination">
          <span className="draft-live-auction__icon">
            <Gavel size={18} />
          </span>
          <div className="draft-live-auction__player">
            <small>Nomination {providerAuction.nominationNumber}</small>
            <strong>{providerAuction.playerName}</strong>
            <span>
              {[providerAuction.position, providerAuction.proTeam].filter(Boolean).join(" · ") ||
                "position unavailable"}
              {providerAuctionNominator ? ` · nominated by ${providerAuctionNominator.name}` : ""}
            </span>
          </div>
          <div className="draft-live-auction__bid">
            <small>Current high bid</small>
            <strong>
              {providerAuction.highBid === null ? "No bid yet" : `$${providerAuction.highBid}`}
            </strong>
            <span>{providerAuctionHighBidder?.name ?? "no high bidder reported"}</span>
          </div>
          <p className="draft-live-auction__note">
            Nomination state is observed live and is not written to the ledger. Only the completed
            sale becomes a saved event.
          </p>
        </section>
      ) : null}

      {showMockSetup || localMock ? (
        <section
          className={`draft-mock-panel${localMock ? " is-running" : ""}`}
          id="draft-mock-panel"
          aria-labelledby="draft-mock-title"
        >
          <div className="draft-mock-panel__intro">
            <span className="draft-mock-panel__icon">
              <Dices size={18} />
            </span>
            <div>
              <p className="eyebrow">Practice room</p>
              <h2 id="draft-mock-title">
                {localMock ? "Local mock in progress" : "Fork this room locally"}
              </h2>
              <p>
                Uses this room’s teams, roster rules, players, and current board. Synthetic events
                stay in this browser memory and never enter the shared ledger.{" "}
                {liveStatus.providerBacked
                  ? `The ${liveStatus.providerName} feed keeps running underneath and is never sent anything.`
                  : "Nothing here is sent to a fantasy provider."}
              </p>
            </div>
          </div>
          {!localMock ? (
            <div className="draft-mock-panel__setup">
              <label>
                <span>Repeatable seed</span>
                <input
                  value={mockSeed}
                  onChange={(event) => setMockSeed(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Your team</span>
                <select value={mockTeamId} onChange={(event) => setMockTeamId(event.target.value)}>
                  {session.config.teams.map((team) => (
                    <option value={team.id} key={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button--dark"
                type="button"
                onClick={startLocalMock}
                disabled={!mockAvailability?.available || !mockSeed.trim() || !mockTeamId}
              >
                <Play size={14} /> Confirm and start
              </button>
              <div
                className={`draft-mock-panel__coverage${mockAvailability?.available ? " is-ready" : ""}`}
                role="status"
              >
                {mockAvailability?.available ? <Check size={14} /> : <CircleAlert size={14} />}
                <span>{mockAvailability?.message ?? "Checking board coverage."}</span>
              </div>
            </div>
          ) : (
            <div className="draft-mock-panel__running">
              <dl>
                <div>
                  <dt>Seed</dt>
                  <dd>{localMock.seed}</dd>
                </div>
                <div>
                  <dt>Your team</dt>
                  <dd>
                    {session.config.teams.find((team) => team.id === localMock.controlledTeamId)
                      ?.name ?? localMock.controlledTeamId}
                  </dd>
                </div>
                <div>
                  <dt>Forked at</dt>
                  <dd>Room event {localMock.baseSequence}</dd>
                </div>
                <div>
                  <dt>Model state</dt>
                  <dd>{localMock.stopReason.replaceAll("_", " ").toLowerCase()}</dd>
                </div>
              </dl>
              <div className="draft-mock-panel__actions">
                <button
                  className="button button--soft"
                  type="button"
                  onClick={() => advanceMock("event")}
                  disabled={
                    localMock.state.complete ||
                    localMock.stopReason === "CONTROLLED_PICK" ||
                    localMock.stopReason === "CONTROLLED_NOMINATION"
                  }
                >
                  <StepForward size={14} /> Advance one event
                </button>
                <button
                  className="button button--dark"
                  type="button"
                  onClick={() => advanceMock("controlled-turn")}
                  disabled={
                    localMock.state.complete ||
                    localMock.stopReason === "CONTROLLED_PICK" ||
                    localMock.stopReason === "CONTROLLED_NOMINATION"
                  }
                >
                  <FastForward size={14} /> Run to my next turn
                </button>
                <button className="button button--soft" type="button" onClick={stopLocalMock}>
                  <X size={14} /> End local mock
                </button>
              </div>
              {generatedMockEvents.length > 0 ? (
                <div className="draft-mock-panel__replay">
                  <label>
                    <span>Replay point</span>
                    <select
                      value={mockReplayEventId}
                      onChange={(event) => setMockReplayEventId(event.target.value)}
                    >
                      <option value="">Choose a local event</option>
                      {generatedMockEvents.map((event, index) => {
                        const player =
                          "playerId" in event
                            ? session.config.players.find((item) => item.id === event.playerId)
                            : undefined;
                        return (
                          <option value={event.id} key={event.id}>
                            {index + 1}. {eventLabel(event)}
                            {player ? ` · ${player.name}` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <button
                    className="button button--soft"
                    type="button"
                    onClick={() => replayMockFromEvent()}
                    disabled={!mockReplayEventId}
                  >
                    <RotateCcw size={14} /> Replay from event
                  </button>
                </div>
              ) : null}
              {session.sequence !== localMock.baseSequence ? (
                <p className="draft-mock-panel__fork-note">
                  The shared room has advanced to event {session.sequence}. This mock remains pinned
                  to event {localMock.baseSequence} until you end it.
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <section className="draft-board-source" aria-labelledby="draft-board-source-title">
        <div className="draft-board-source__heading">
          <span className="draft-board-source__icon">
            <ChartNoAxesColumnIncreasing size={17} />
          </span>
          <div>
            <p className="eyebrow">Decision source</p>
            <h2 id="draft-board-source-title">Your draft board</h2>
          </div>
        </div>
        {rankingState === "loading" && rankingLists.length === 0 ? (
          <span className="draft-board-source__message" role="status">
            <LoaderCircle className="spin" size={14} /> Loading compatible boards
          </span>
        ) : rankingState === "error" && rankingLists.length === 0 ? (
          <span className="draft-board-source__message draft-board-source__message--error">
            <CircleAlert size={14} /> {rankingError}
          </span>
        ) : rankingLists.length === 0 ? (
          <span className="draft-board-source__message">
            No compatible {draftSeason ?? "current-season"} board.{" "}
            <Link href="/rankings">Create or import one in Rankings</Link>.
          </span>
        ) : (
          <div className="draft-board-source__controls">
            <label>
              <span>Board</span>
              <select
                value={selectedRankingListId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  const next = rankingLists.find((list) => list.id === nextId);
                  setSelectedRankingListId(nextId);
                  setSelectedRankingVersionId(next?.currentVersionId ?? "");
                  setRankingVersion(null);
                }}
              >
                {rankingLists.map((list) => (
                  <option value={list.id} key={list.id}>
                    {list.name} · {list.kind.replaceAll("-", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Version</span>
              <select
                value={selectedRankingVersionId}
                onChange={(event) => setSelectedRankingVersionId(event.target.value)}
              >
                {selectableRankingVersions.map((version) => (
                  <option value={version.id} key={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Order</span>
              <select
                value={boardSort}
                onChange={(event) => setBoardSort(event.target.value as DraftBoardSort)}
              >
                <option value="rank">Overall rank / ADP</option>
                <option value="tier">Tier</option>
                <option value="aav">Auction value</option>
                <option value="name">Player name</option>
              </select>
            </label>
          </div>
        )}
        <div className="draft-board-source__status">
          {rankingVersion ? (
            <>
              <strong>
                Version {rankingVersion.versionNumber} · {rankingVersion.state}
              </strong>
              <span>
                {coveredPlayerCount} of {availablePlayers.length} available players covered
              </span>
            </>
          ) : rankingLists.length > 0 ? (
            <span>
              {rankingState === "loading"
                ? "Loading board values"
                : rankingError || "Board unavailable"}
            </span>
          ) : (
            <span>Unranked catalog players stay hidden until you search for them.</span>
          )}
        </div>
      </section>

      <section className="room-strip" aria-label="Draft room state">
        <article>
          <span className="room-stat-icon room-stat-icon--lime">
            <Database size={18} />
          </span>
          <div>
            <span>{localMock ? "Local events" : "Ledger"}</span>
            <strong>{localMock ? generatedMockEvents.length : session.sequence}</strong>
            <small>{localMock ? "browser memory" : session.persistedState}</small>
          </div>
        </article>
        <article>
          <span className="room-stat-icon">
            <Users size={18} />
          </span>
          <div>
            <span>Teams</span>
            <strong>{activeDraftState?.teams.length ?? 0}</strong>
            <small>
              {activeDraftState?.teams.reduce((sum, team) => sum + team.openSlots, 0) ?? 0} open{" "}
              slots
            </small>
          </div>
        </article>
        <article>
          <span className="room-stat-icon">
            <Search size={18} />
          </span>
          <div>
            <span>Available</span>
            <strong>{availablePlayers.length}</strong>
            <small>of {session.config.players.length} players</small>
          </div>
        </article>
        <article>
          <span className="room-stat-icon">
            <Check size={18} />
          </span>
          <div>
            <span>{session.config.mode === "SNAKE" ? "On the clock" : "Selected team"}</span>
            <strong>
              {session.config.mode === "SNAKE"
                ? (onClockTeam?.name ?? "Complete")
                : (activeTeam?.name ?? "Select a team")}
            </strong>
            <small>
              {session.config.mode === "SNAKE" && activeDraftState?.nextPick
                ? `Pick ${activeDraftState.nextPick.overallPick}`
                : activeDraftState?.complete
                  ? "Draft complete"
                  : "Manual sale entry"}
            </small>
          </div>
        </article>
      </section>

      <section className="opponent-budget-strip" aria-label="Team state">
        <div className="opponent-budget-strip__label">
          <span>{localMock ? "Mock room" : "League room"}</span>
          <small>
            {session.config.mode === "AUCTION"
              ? "remaining · max"
              : "tap advice team · rostered · open"}
          </small>
        </div>
        <div className="opponent-team-scroll">
          {teamStates.map((team) => {
            const content = (
              <>
                <span>{team.name.slice(0, 8)}</span>
                <strong>
                  {session.config.mode === "AUCTION"
                    ? `$${team.remainingBudget ?? 0} · $${team.maximumBid ?? 0}`
                    : `${team.roster.length} · ${team.openSlots}`}
                </strong>
              </>
            );
            return (
              <button
                type="button"
                key={team.teamId}
                className={team.teamId === activeTeamId ? "is-selected" : ""}
                onClick={() => setSelectedTeamId(team.teamId)}
                aria-pressed={team.teamId === activeTeamId}
                title={
                  session.config.mode === "SNAKE" && team.teamId === onClockTeamId
                    ? `${team.name} is on the clock`
                    : `Show advice for ${team.name}`
                }
              >
                {content}
              </button>
            );
          })}
        </div>
      </section>

      <div className="draft-workspace-grid">
        <section className="board-panel" aria-labelledby="live-player-board-title">
          <div className="board-panel__header">
            <div>
              <p className="eyebrow">{selectedRankingList?.name ?? "Stored player catalog"}</p>
              <h2 id="live-player-board-title">Available players</h2>
            </div>
            <div className="board-header-meta">
              <span>
                {filteredRows.length}
                {filteredRows.length < availablePlayers.length
                  ? ` of ${availablePlayers.length}`
                  : ""}{" "}
                shown
              </span>
            </div>
          </div>
          <div className="board-toolbar">
            <label className="search-field">
              <Search size={16} />
              <span className="sr-only">Search available players</span>
              <input
                type="search"
                placeholder="Search player, team, or position"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="position-tabs" role="group" aria-label="Filter by position">
              {positions.slice(0, 8).map((item) => (
                <button
                  type="button"
                  className={position === item ? "is-active" : ""}
                  aria-pressed={position === item}
                  onClick={() => setPosition(item)}
                  key={item}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="coverage-tabs" role="group" aria-label="Filter by board coverage">
              <button
                type="button"
                className={coverageFilter === "covered" ? "is-active" : ""}
                aria-pressed={coverageFilter === "covered"}
                onClick={() => setCoverageFilter("covered")}
              >
                Ranked
              </button>
              <button
                type="button"
                className={coverageFilter === "all" ? "is-active" : ""}
                aria-pressed={coverageFilter === "all"}
                onClick={() => setCoverageFilter("all")}
                title="Search the full stored catalog"
              >
                <ListFilter size={12} /> Catalog
              </button>
              <button
                type="button"
                className={coverageFilter === "missing" ? "is-active" : ""}
                aria-pressed={coverageFilter === "missing"}
                onClick={() => setCoverageFilter("missing")}
              >
                Missing
              </button>
            </div>
          </div>
          <div
            className="player-table-wrap"
            role="region"
            aria-label="Draft player rankings; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table className="player-table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Player</th>
                  <th scope="col">Tier</th>
                  <th scope="col">ADP</th>
                  <th scope="col">AAV</th>
                  <th scope="col">Signal</th>
                  <th scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(({ player, value, covered }) => (
                  <BoardRow
                    key={player.id}
                    player={player}
                    value={value}
                    covered={covered}
                    selected={player.id === selectedPlayerId}
                    byeWeeks={byeWeeks}
                    onSelect={setSelectedPlayerId}
                  />
                ))}
              </tbody>
            </table>
            {filteredRows.length === 0 ? (
              <div className="board-empty">
                <Search size={20} />
                <strong>
                  {coverageFilter === "covered"
                    ? rankingVersion
                      ? "No ranked players match."
                      : "Choose a draft board or search the catalog."
                    : search.trim()
                      ? "No catalog players match."
                      : "Enter a player name to search the stored catalog."}
                </strong>
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setPosition("ALL");
                    setCoverageFilter("covered");
                  }}
                >
                  Reset filters
                </button>
              </div>
            ) : null}
          </div>
          <div className="board-footer">
            <span>Showing up to 250 matches.</span>
            <span>
              {coveredPlayerCount} board-covered · {availablePlayers.length - coveredPlayerCount}{" "}
              catalog-only
            </span>
          </div>
        </section>

        <aside
          className="draft-rail"
          aria-label={localMock ? "Local mock controls" : "Manual draft entry"}
        >
          <section className="draft-intel-card" aria-labelledby="draft-intel-title">
            <div className="recommendation-card__head">
              <span>
                {session.config.mode === "AUCTION" ? (
                  <BadgeDollarSign size={16} />
                ) : (
                  <ChartNoAxesColumnIncreasing size={16} />
                )}{" "}
                <span id="draft-intel-title">
                  {session.config.mode === "AUCTION" ? "Live price check" : "Best now"}
                </span>
              </span>
              <span className="status-chip">
                {session.config.mode === "AUCTION"
                  ? "Budget model"
                  : draftMarket?.state === "available"
                    ? "Live ADP + need"
                    : "Board ADP + need"}
              </span>
            </div>
            {session.config.mode === "SNAKE" ? (
              !rankingVersion && draftMarket?.state !== "available" ? (
                <div className="draft-intel-unavailable">
                  <CircleAlert size={16} />
                  <p>
                    {draftMarketState === "loading"
                      ? "Loading the compatible draft-market baseline…"
                      : draftMarket?.state === "unavailable"
                        ? draftMarket.detail
                        : "Select a compatible draft board to build the queue."}
                  </p>
                </div>
              ) : snakeQueue.length > 0 ? (
                <>
                  <ol className="draft-best-now">
                    {snakeQueue.map((row, index) => (
                      <li key={row.player.id}>
                        <button
                          type="button"
                          className={row.player.id === selectedPlayerId ? "is-selected" : ""}
                          onClick={() => setSelectedPlayerId(row.player.id)}
                        >
                          <span>{index + 1}</span>
                          <span>
                            <strong>{row.player.name}</strong>
                            <small>
                              {row.needLabel} · base {row.baseRank.toFixed(1)}
                              {row.availability
                                ? ` · ${Math.round(row.availability.probabilityAvailable * 100)}% next turn`
                                : ""}
                            </small>
                          </span>
                          <span>{row.player.positions[0]}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <p className="draft-intel-note">
                    {activeTeamNextPick === null
                      ? "Rank or ADP gets an explainable starter-need adjustment. No later pick remains for the selected advice team, so wait risk is not shown."
                      : `Rank or ADP gets an explainable starter-need adjustment. Where ADP exists, wait risk is the conditional chance this still-available player reaches pick ${activeTeamNextPick}; source dispersion is used when available, with a conservative fallback otherwise.`}
                  </p>
                  {draftMarket?.state === "available" ? (
                    <p className="draft-intel-note">
                      ADP context: {draftMarket.context.teamCount}-team{" "}
                      {draftMarket.context.scoringFormat.toUpperCase()} · as of{" "}
                      {new Date(draftMarket.source.sourceAsOf).toLocaleDateString()} ·{" "}
                      {Math.round(draftMarket.source.matchRate * 100)}% identity coverage
                      {draftMarket.source.attributionUrl ? (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={draftMarket.source.attributionUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {draftMarket.source.attribution ?? draftMarket.source.name}
                          </a>
                        </>
                      ) : null}
                      {draftMarket.warnings.map((warning) => ` · ${warning}`)}
                    </p>
                  ) : null}
                  <div className="draft-model-gate">
                    <CircleAlert size={14} />
                    <span>
                      VBD remains off until a compatible season projection feed is available. Rank
                      is never converted into invented fantasy points.
                    </span>
                  </div>
                </>
              ) : (
                <div className="draft-intel-unavailable">
                  <CircleAlert size={16} />
                  <p>The selected board has no rank or ADP coverage for available players.</p>
                </div>
              )
            ) : !rankingVersion || !auctionAnalysis ? (
              <div className="draft-intel-unavailable">
                <CircleAlert size={16} />
                <p>Select a compatible board with AAV data to enable live pricing.</p>
              </div>
            ) : auctionAnalysis.available ? (
              <>
                <div className="draft-price-grid">
                  <div>
                    <span>Fair now</span>
                    <strong>{draftDollar(auctionAnalysis.fairValue)}</strong>
                  </div>
                  <div className="is-primary">
                    <span>Target</span>
                    <strong>{draftDollar(auctionAnalysis.targetPrice)}</strong>
                  </div>
                  <div>
                    <span>Legal ceiling</span>
                    <strong>{draftDollar(auctionAnalysis.legalMaximumBid)}</strong>
                  </div>
                </div>
                <p className="draft-intel-note">
                  {auctionAnalysis.inflationFactor.toFixed(2)}× live inflation ·{" "}
                  {auctionAnalysis.coveredPlayers} AAVs for {auctionAnalysis.requiredPlayers} open
                  slots.
                </p>
                {selectedBoardRow?.value?.targetPrice !== null &&
                selectedBoardRow?.value?.targetPrice !== undefined ? (
                  <p className="draft-intel-note">
                    Your board target: {draftDollar(selectedBoardRow.value.targetPrice)}
                    {selectedBoardRow.value.ceilingPrice !== null ? (
                      <> · ceiling {draftDollar(selectedBoardRow.value.ceilingPrice)}</>
                    ) : null}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="draft-intel-unavailable">
                <CircleAlert size={16} />
                <div>
                  <p>{auctionAnalysis.message}</p>
                  <small>
                    Coverage: {auctionAnalysis.coveredPlayers} of {auctionAnalysis.requiredPlayers}{" "}
                    required.
                  </small>
                </div>
              </div>
            )}
            {session.config.mode === "AUCTION" && rankingVersion ? (
              auctionNominations.length > 0 ? (
                <>
                  <p className="draft-nomination-head">Nomination board</p>
                  <ol className="draft-best-now draft-nomination-list">
                    {auctionNominations.map((row) => (
                      <li key={row.player.id}>
                        <button
                          type="button"
                          className={row.player.id === selectedPlayerId ? "is-selected" : ""}
                          onClick={() => setSelectedPlayerId(row.player.id)}
                        >
                          <span>{row.rank}</span>
                          <span>
                            <strong>{row.player.name}</strong>
                            <small>{row.reason}</small>
                          </span>
                          <span
                            className={`nomination-strategy nomination-strategy--${row.strategy}`}
                          >
                            {row.strategy}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <p className="draft-intel-note">
                    Uses only explicit board target prices versus AAV; players missing either field
                    are omitted.
                  </p>
                </>
              ) : (
                <div className="draft-model-gate">
                  <CircleAlert size={14} />
                  <span>Add both target price and AAV to board rows for nomination advice.</span>
                </div>
              )
            ) : null}
            <p className="draft-keyboard-note">
              <Keyboard size={14} /> J / K selects · Shift + Enter records
            </p>
          </section>

          <section className="recommendation-card">
            <div className="recommendation-card__head">
              <span>
                {localMock ? <Dices size={16} /> : <Database size={16} />}{" "}
                {localMock
                  ? "Local action"
                  : manualBackup.active
                    ? "Manual backup entry"
                    : "Manual entry"}
              </span>
              <span className="status-chip">
                {localMock ? "Not saved" : providerLocksManualEntry ? "Provider driven" : "Stored"}
              </span>
            </div>
            {selectedPlayer ? (
              <div className="recommendation-player">
                <span
                  className={`position-avatar position-avatar--large position-avatar--${selectedPlayer.positions[0]?.toLowerCase() ?? "all"}`}
                >
                  {selectedPlayer.positions[0]}
                </span>
                <div>
                  <p>{session.config.mode === "SNAKE" ? "Selection" : "Winning player"}</p>
                  <h2>{selectedPlayer.name}</h2>
                  <span>
                    {selectedPlayer.positions.join(" · ")} ·{" "}
                    {selectedPlayer.nflTeam ?? "Free agent"}
                    {byeLabel(byeWeeks, selectedPlayer.nflTeam)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="draft-session-empty">
                <strong>No player selected.</strong>
              </div>
            )}
            {session.config.mode === "AUCTION" && !localMock ? (
              <div className="auction-entry">
                <label>
                  <span>Winning team</span>
                  <select
                    value={selectedTeamId}
                    onChange={(event) => setSelectedTeamId(event.target.value)}
                  >
                    {teamStates.map((team) => (
                      <option value={team.teamId} key={team.teamId}>
                        {team.name} · ${team.remainingBudget ?? 0}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </label>
                <label>
                  <span>Sale price</span>
                  <div className="money-input">
                    <span>$</span>
                    <input
                      inputMode="numeric"
                      value={salePrice}
                      onChange={(event) => setSalePrice(event.target.value.replace(/[^0-9]/g, ""))}
                    />
                  </div>
                </label>
              </div>
            ) : session.config.mode === "SNAKE" ? (
              <div className="snake-comparison">
                <div>
                  <span>Pick</span>
                  <strong>{activeDraftState?.nextPick?.overallPick ?? "—"}</strong>
                </div>
                <div>
                  <span>Team</span>
                  <strong>{activeTeam?.name ?? "—"}</strong>
                </div>
                <div>
                  <span>Open</span>
                  <strong>{activeTeam?.openSlots ?? 0}</strong>
                </div>
              </div>
            ) : (
              <div className="draft-local-nomination-note">
                <Gavel size={16} />
                <span>
                  Choose your nomination. The seeded opponent model resolves bidding for every team
                  when you advance.
                </span>
              </div>
            )}
            {!canMutate && !localMock ? (
              <p className="draft-session-permission">
                <ShieldCheck size={14} /> You can follow this room, but only its owner or
                commissioner can record events.
              </p>
            ) : providerLocksManualEntry && !localMock ? (
              <p className="draft-session-permission">
                <ShieldCheck size={14} /> The {liveStatus.providerName} feed is driving this room.
                Activate manual backup first so provider and manual entries never interleave
                silently.
              </p>
            ) : null}
            <button
              className="button button--lime button--full button--record"
              type="button"
              onClick={() => void recordSelection()}
              disabled={recordDisabled}
            >
              {requestState === "loading" ? (
                <LoaderCircle className="spin" size={16} />
              ) : session.config.mode === "AUCTION" ? (
                <Gavel size={16} />
              ) : (
                <Check size={16} />
              )}{" "}
              {recordActionLabel}
            </button>
            {!localMock && selectedTeam?.maximumBid !== undefined ? (
              <p className="draft-session-legal-max">
                Legal maximum for {selectedTeam.name}: ${selectedTeam.maximumBid}
              </p>
            ) : null}
          </section>
        </aside>
      </div>

      <aside
        className={`draft-mobile-action draft-mobile-action--live${
          mobileDecision.stale ? " draft-mobile-action--stale" : ""
        }`}
        role="region"
        aria-label="Live draft controls"
      >
        {/* Everything below is decision-critical on a phone (§16.4): who is on the clock or
            nominated, feed health, roster needs, budget, and an unmissable stale state. */}
        <div className="draft-mobile-action__feed" aria-live="polite">
          <span className="draft-mobile-action__feed-status">
            <span
              className={`live-freshness-dot live-freshness-dot--${liveStatus.freshness}`}
              aria-hidden="true"
            />
            {mobileDecision.feedLabel}
          </span>
          <span className="draft-mobile-action__feed-clock">
            <small>{mobileDecision.headlineCaption}</small>
            <strong>{mobileDecision.headline}</strong>
          </span>
        </div>
        {mobileDecision.staleLabel ? (
          <p className="draft-mobile-action__stale" role="status">
            <TriangleAlert size={13} /> {mobileDecision.staleLabel}
          </p>
        ) : null}
        <div className="draft-mobile-action__needs">
          <span>{mobileDecision.needsLabel}</span>
          {mobileDecision.budgetLabel ? <span>{mobileDecision.budgetLabel}</span> : null}
        </div>

        <button
          className="draft-mobile-action__intel"
          type="button"
          onClick={() => {
            if (mobileRecommendation) setSelectedPlayerId(mobileRecommendation.id);
          }}
          disabled={!mobileRecommendation}
        >
          <span className="draft-mobile-action__intel-icon">
            {session.config.mode === "AUCTION" ? (
              <BadgeDollarSign size={17} />
            ) : (
              <ChartNoAxesColumnIncreasing size={17} />
            )}
          </span>
          <span className="draft-mobile-action__intel-copy">
            <small>{session.config.mode === "AUCTION" ? "Nominate next" : "Best now"}</small>
            <strong>{mobileRecommendation?.name ?? "Recommendation unavailable"}</strong>
          </span>
          <span className="draft-mobile-action__intel-note">
            {session.config.mode === "AUCTION" && auctionAnalysis?.available
              ? `${draftDollar(auctionAnalysis.targetPrice)} target · ${draftDollar(auctionAnalysis.legalMaximumBid)} max`
              : mobileRecommendationNote}
          </span>
        </button>

        <div className="draft-mobile-action__action">
          {session.config.mode === "AUCTION" && !localMock ? (
            <div className="draft-mobile-action__auction-fields">
              <label>
                <span className="sr-only">Winning team</span>
                <select
                  aria-label="Winning team"
                  value={selectedTeamId}
                  onChange={(event) => setSelectedTeamId(event.target.value)}
                >
                  {teamStates.map((team) => (
                    <option value={team.teamId} key={team.teamId}>
                      {team.name} · ${team.remainingBudget ?? 0}
                    </option>
                  ))}
                </select>
              </label>
              <label className="draft-mobile-action__price">
                <span aria-hidden="true">$</span>
                <input
                  aria-label="Sale price"
                  inputMode="numeric"
                  value={salePrice}
                  onChange={(event) => setSalePrice(event.target.value.replace(/[^0-9]/g, ""))}
                />
              </label>
            </div>
          ) : (
            <div className="draft-mobile-action__selection" aria-live="polite">
              <small>{localMock ? "Your move" : "Selected"}</small>
              <strong>{selectedPlayer?.name ?? "Choose a player"}</strong>
            </div>
          )}
          <button
            className="button button--lime draft-mobile-action__record"
            type="button"
            onClick={() => void recordSelection()}
            disabled={recordDisabled}
          >
            {requestState === "loading" ? (
              <LoaderCircle className="spin" size={16} />
            ) : session.config.mode === "AUCTION" ? (
              <Gavel size={16} />
            ) : (
              <Check size={16} />
            )}
            <span>{recordActionLabel}</span>
          </button>
        </div>
      </aside>

      <section className="draft-log" aria-labelledby="live-draft-log-title">
        <div className="draft-log__heading">
          <div>
            <p className="eyebrow">{localMock ? "Practice history" : "Draft history"}</p>
            <h2 id="live-draft-log-title">
              {localMock ? "Recent local events" : "Recent entries"}
            </h2>
          </div>
          <button
            className="text-action"
            type="button"
            onClick={() => void undoLast()}
            disabled={
              localMock
                ? generatedMockEvents.length === 0
                : !canMutate || session.sequence === 0 || requestState === "loading"
            }
          >
            <RotateCcw size={14} /> Undo last {localMock ? "local event" : "active action"}
          </button>
        </div>
        {localMock && generatedMockEvents.length ? (
          <div className="draft-log__events">
            {generatedMockEvents
              .map((event, index) => ({ event, index }))
              .reverse()
              .slice(0, 12)
              .map(({ event, index }) => {
                const player =
                  "playerId" in event
                    ? session.config.players.find((item) => item.id === event.playerId)
                    : undefined;
                const team =
                  "teamId" in event
                    ? session.config.teams.find((item) => item.id === event.teamId)
                    : undefined;
                return (
                  <article className="draft-event draft-event--mock" key={event.id}>
                    <span className="draft-event__pick">L{index + 1}</span>
                    <div>
                      <strong>
                        {player?.name ??
                          (event.type === "DRAFT_EVENT_REVERTED"
                            ? "Local undo"
                            : "Simulated action")}
                      </strong>
                      <span>{team?.name ?? event.type.replaceAll("_", " ").toLowerCase()}</span>
                    </div>
                    <strong>{eventLabel(event)}</strong>
                    <button
                      className="draft-event__replay"
                      type="button"
                      onClick={() => replayMockFromEvent(event.id)}
                      aria-label={`Replay local mock from event ${index + 1}`}
                    >
                      Replay
                    </button>
                  </article>
                );
              })}
          </div>
        ) : recentEvents.length && !localMock ? (
          <div className="draft-log__events">
            {recentEvents.map((record) => {
              const event = record.event;
              const player = "playerId" in event ? playersById.get(event.playerId) : undefined;
              const team = "teamId" in event ? teamsById.get(event.teamId) : undefined;
              return (
                <article className="draft-event draft-event--local" key={record.sequence}>
                  <span className="draft-event__pick">{record.sequence}</span>
                  <div>
                    <strong>
                      {player?.name ??
                        (event.type === "DRAFT_EVENT_REVERTED" ? "Undo recorded" : "Draft action")}
                    </strong>
                    <span>{team?.name ?? event.type.replaceAll("_", " ").toLowerCase()}</span>
                  </div>
                  <strong>{eventLabel(event)}</strong>
                  {/* Provenance is on the record, not assumed: a provider-backed room
                      interleaves observed picks with manual backup entries. */}
                  <small>{record.source === "espn" ? "ESPN" : "Manual"}</small>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="draft-session-empty">
            {localMock ? <Dices size={18} /> : <Database size={18} />}
            <strong>
              {localMock
                ? "No local events yet. Advance the seeded simulation when ready."
                : "No events yet. Select a player to record the first entry."}
            </strong>
          </div>
        )}
        <p className="draft-log__note">
          <ShieldCheck size={13} />
          {liveStatus.ledgerNote}
        </p>
      </section>

      <DraftAnalysisPanel
        draftId={session.id}
        sequence={session.sequence}
        mode={session.config.mode}
        enabled={!localMock}
      />
    </div>
  );
}
