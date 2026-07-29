"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  Clipboard,
  CloudUpload,
  Copy,
  Download,
  FileJson,
  FileSpreadsheet,
  History,
  GitCompareArrows,
  Link2,
  ListPlus,
  LoaderCircle,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { LatestRequest } from "../lib/latest-request";
import {
  guardedNavigationCommitEvent,
  guardedNavigationRequestEvent,
} from "../lib/navigation-guard";
import { loginUrlForCurrentPath } from "../lib/safe-return-to";
import { DemoRankingsStudio } from "./demo-rankings-studio";

type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST" | "LB" | "DL" | "DB" | "IDP";
type ListKind = "rankings" | "adp" | "auction-values" | "cheat-sheet";
type ScoringFormat = "STANDARD" | "HALF_PPR" | "PPR" | "CUSTOM";
type RequestState = "idle" | "working" | "done" | "error";
const rankingsHistoryGuardKey = "__lacesOutRankingsDirtyGuard";

interface RankingList {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly description: string | null;
  readonly season: number;
  readonly kind: ListKind;
  readonly scoringContext: {
    readonly format: ScoringFormat;
    readonly label: string | null;
  };
  readonly visibility:
    | { readonly scope: "private" }
    | {
        readonly scope: "league";
        readonly leagueIds: readonly string[];
        readonly allowClone: boolean;
      }
    | {
        readonly scope: "shared-link";
        readonly allowClone: boolean;
      };
  readonly capabilities: {
    readonly canEdit: boolean;
    readonly canClone: boolean;
    readonly canCompare: boolean;
  };
  readonly currentVersionId: string | null;
  readonly latestPublishedVersionId: string | null;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface SourcedValue<T> {
  readonly value: T;
  readonly kind: "user" | "derived";
}

interface RankingEntry {
  readonly playerId: string;
  readonly position: Position | null;
  readonly overallRank: SourcedValue<number> | null;
  readonly positionRank: SourcedValue<number> | null;
  readonly tier: SourcedValue<number> | null;
  readonly adp: SourcedValue<number> | null;
  readonly aav: SourcedValue<number> | null;
  readonly floorPrice: SourcedValue<number> | null;
  readonly targetPrice: SourcedValue<number> | null;
  readonly ceilingPrice: SourcedValue<number> | null;
  readonly confidence: SourcedValue<number> | null;
  readonly tags: SourcedValue<readonly string[]> | null;
  readonly notes: SourcedValue<string> | null;
  readonly target: SourcedValue<boolean> | null;
  readonly avoid: SourcedValue<boolean> | null;
}

interface RankingVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly state: "draft" | "published";
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly changeNote: string | null;
  readonly checksumSha256: string;
  readonly entries: readonly RankingEntry[];
  readonly provenance: {
    readonly operation: string;
    readonly sources: readonly {
      readonly kind: string;
      readonly label: string | null;
      readonly observedAt: string | null;
    }[];
  };
}

interface PlayerIdentity {
  readonly id: string;
  readonly fullName: string;
  readonly position: Position;
}

interface EditableEntry {
  readonly playerId: string;
  readonly fullName: string;
  position: Position | "";
  overallRank: string;
  positionRank: string;
  tier: string;
  adp: string;
  aav: string;
  floorPrice: string;
  targetPrice: string;
  ceilingPrice: string;
  confidence: string;
  tags: string;
  notes: string;
  target: boolean;
  avoid: boolean;
}

interface CsvPreview {
  readonly previewChecksumSha256: string;
  readonly canCommitAll: boolean;
  readonly summary: {
    readonly total: number;
    readonly ready: number;
    readonly invalid: number;
    readonly unresolved: number;
    readonly duplicate: number;
  };
  readonly rows: readonly {
    readonly rowNumber: number;
    readonly status: "ready" | "invalid" | "unresolved" | "duplicate";
    readonly diagnostics: readonly { readonly message: string }[];
  }[];
  readonly diagnostics: readonly { readonly message: string }[];
}

interface ShareReceipt {
  readonly id: string;
  readonly shareUrl: string;
  readonly expiresAt: string | null;
}

interface RankingComparison {
  readonly left: { readonly list: RankingList; readonly version: RankingVersion };
  readonly right: { readonly list: RankingList; readonly version: RankingVersion };
  readonly players: readonly PlayerIdentity[];
}

interface RankingComparisonRow {
  readonly playerId: string;
  readonly fullName: string;
  readonly position: Position | null;
  readonly leftRank: number | null;
  readonly rightRank: number | null;
  readonly rankDelta: number | null;
  readonly leftTier: number | null;
  readonly rightTier: number | null;
  readonly leftAdp: number | null;
  readonly rightAdp: number | null;
  readonly leftAav: number | null;
  readonly rightAav: number | null;
}

const csvColumnLabels = {
  playerId: "Player ID",
  playerName: "Player name",
  position: "Position",
  overallRank: "Overall rank",
  tier: "Tier",
  adp: "ADP",
  aav: "Auction value",
  targetPrice: "Target price",
  notes: "Notes",
} as const;
type CsvColumnField = keyof typeof csvColumnLabels;
type CsvColumns = Record<CsvColumnField, string>;

const defaultCsvFileName = "custom-rankings.csv";
const defaultCsvColumns: CsvColumns = {
  playerId: "",
  playerName: "name",
  position: "position",
  overallRank: "rank",
  tier: "tier",
  adp: "adp",
  aav: "aav",
  targetPrice: "target_price",
  notes: "notes",
};

interface BoundCsvPreview {
  readonly boardId: string;
  readonly source: string;
  readonly sourceFileName: string;
  readonly mapping: Readonly<Record<string, string>>;
  readonly preview: CsvPreview;
  readonly importKey: string;
}

class RankingUiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RankingUiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readableError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.detail === "string") return value.detail;
  if (typeof value.title === "string") return value.title;
  return fallback;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    throw new RankingUiError("Sign in required", 401);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RankingUiError(readableError(body, "The ranking request failed."), response.status);
  }
  return body as T;
}

function valueText<T extends number | string>(field: SourcedValue<T> | null): string {
  return field === null ? "" : String(field.value);
}

function editableEntries(
  version: RankingVersion,
  players: readonly PlayerIdentity[],
): EditableEntry[] {
  const names = new Map(players.map((player) => [player.id, player.fullName]));
  return version.entries.map((entry) => ({
    playerId: entry.playerId,
    fullName: names.get(entry.playerId) ?? "Unknown player",
    position: entry.position ?? "",
    overallRank: valueText(entry.overallRank),
    positionRank: valueText(entry.positionRank),
    tier: valueText(entry.tier),
    adp: valueText(entry.adp),
    aav: valueText(entry.aav),
    floorPrice: valueText(entry.floorPrice),
    targetPrice: valueText(entry.targetPrice),
    ceilingPrice: valueText(entry.ceilingPrice),
    confidence: valueText(entry.confidence),
    tags: entry.tags?.value.join(", ") ?? "",
    notes: valueText(entry.notes),
    target: entry.target?.value === true,
    avoid: entry.avoid?.value === true,
  }));
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new RankingUiError(`“${value}” is not a number.`, 400);
  return parsed;
}

const ROW_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST", "LB", "DL", "DB", "IDP"] as const;

/* Every keystroke into a rank cell replaces one entry object; with the board
   unbounded (300+ players × ~16 controls each), reconciling every row per
   digit made typing visibly lag. Each row bails out here unless its own
   entry, position in the list, or the shared disabled state changed. */
const RankingRow = memo(function RankingRow({
  entry,
  index,
  disabled,
  isLast,
  onUpdate,
  onMove,
  onRemove,
}: {
  entry: EditableEntry;
  index: number;
  disabled: boolean;
  isLast: boolean;
  onUpdate: (index: number, patch: Partial<EditableEntry>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <tr>
      <td>
        <strong>{entry.fullName}</strong>
        <small>{entry.playerId.slice(0, 8)}</small>
      </td>
      <td>
        <select
          aria-label={`${entry.fullName} position`}
          value={entry.position}
          disabled={disabled}
          onChange={(event) =>
            onUpdate(index, {
              position: event.target.value as Position | "",
            })
          }
        >
          <option value="">—</option>
          {ROW_POSITIONS.map((position) => (
            <option value={position} key={position}>
              {position}
            </option>
          ))}
        </select>
      </td>
      {(["overallRank", "tier", "adp", "aav", "targetPrice"] as const).map((field) => (
        <td key={field}>
          <input
            aria-label={`${entry.fullName} ${field}`}
            inputMode="decimal"
            value={entry[field]}
            disabled={disabled}
            onChange={(event) => onUpdate(index, { [field]: event.target.value })}
          />
        </td>
      ))}
      <td>
        <input
          className="ranking-notes-input"
          aria-label={`${entry.fullName} notes`}
          value={entry.notes}
          disabled={disabled}
          onChange={(event) => onUpdate(index, { notes: event.target.value })}
        />
      </td>
      <td>
        <label className="ranking-flag">
          <input
            type="checkbox"
            checked={entry.target}
            disabled={disabled}
            onChange={(event) =>
              onUpdate(index, {
                target: event.target.checked,
                ...(event.target.checked ? { avoid: false } : {}),
              })
            }
          />{" "}
          Target
        </label>
        <label className="ranking-flag">
          <input
            type="checkbox"
            checked={entry.avoid}
            disabled={disabled}
            onChange={(event) =>
              onUpdate(index, {
                avoid: event.target.checked,
                ...(event.target.checked ? { target: false } : {}),
              })
            }
          />{" "}
          Avoid
        </label>
      </td>
      <td>
        <div className="ranking-order-controls">
          <button
            className="icon-button icon-button--small"
            type="button"
            aria-label={`Move ${entry.fullName} up one rank`}
            disabled={disabled || index === 0}
            onClick={() => onMove(index, -1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="icon-button icon-button--small"
            type="button"
            aria-label={`Move ${entry.fullName} down one rank`}
            disabled={disabled || isLast}
            onClick={() => onMove(index, 1)}
          >
            <ArrowDown size={14} />
          </button>
        </div>
      </td>
      <td>
        <button
          className="icon-button icon-button--small"
          type="button"
          aria-label={`Remove ${entry.fullName}`}
          disabled={disabled}
          onClick={() => onRemove(index)}
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
});

function manualEntry(entry: EditableEntry) {
  const tags = entry.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    playerId: entry.playerId,
    position: entry.position || null,
    overallRank: numberOrNull(entry.overallRank),
    positionRank: numberOrNull(entry.positionRank),
    tier: numberOrNull(entry.tier),
    adp: numberOrNull(entry.adp),
    aav: numberOrNull(entry.aav),
    floorPrice: numberOrNull(entry.floorPrice),
    targetPrice: numberOrNull(entry.targetPrice),
    ceilingPrice: numberOrNull(entry.ceilingPrice),
    confidence: numberOrNull(entry.confidence),
    tags: tags.length ? tags : null,
    notes: entry.notes.trim() || null,
    target: entry.target,
    avoid: entry.avoid,
  };
}

function kindLabel(kind: ListKind): string {
  return {
    rankings: "Rankings",
    adp: "ADP",
    "auction-values": "Auction values",
    "cheat-sheet": "Cheat sheet",
  }[kind];
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function comparisonRows(comparison: RankingComparison): readonly RankingComparisonRow[] {
  const players = new Map(comparison.players.map((player) => [player.id, player]));
  const left = new Map(comparison.left.version.entries.map((entry) => [entry.playerId, entry]));
  const right = new Map(comparison.right.version.entries.map((entry) => [entry.playerId, entry]));
  const playerIds = [
    ...comparison.left.version.entries.map((entry) => entry.playerId),
    ...comparison.right.version.entries
      .map((entry) => entry.playerId)
      .filter((playerId) => !left.has(playerId)),
  ];
  return playerIds
    .map((playerId) => {
      const leftEntry = left.get(playerId);
      const rightEntry = right.get(playerId);
      const leftRank = leftEntry?.overallRank?.value ?? null;
      const rightRank = rightEntry?.overallRank?.value ?? null;
      return {
        playerId,
        fullName: players.get(playerId)?.fullName ?? "Unknown player",
        position: leftEntry?.position ?? rightEntry?.position ?? null,
        leftRank,
        rightRank,
        rankDelta: leftRank === null || rightRank === null ? null : leftRank - rightRank,
        leftTier: leftEntry?.tier?.value ?? null,
        rightTier: rightEntry?.tier?.value ?? null,
        leftAdp: leftEntry?.adp?.value ?? null,
        rightAdp: rightEntry?.adp?.value ?? null,
        leftAav: leftEntry?.aav?.value ?? null,
        rightAav: rightEntry?.aav?.value ?? null,
      };
    })
    .sort((leftRow, rightRow) => {
      const leftBest = Math.min(
        leftRow.leftRank ?? Number.MAX_SAFE_INTEGER,
        leftRow.rightRank ?? Number.MAX_SAFE_INTEGER,
      );
      const rightBest = Math.min(
        rightRow.leftRank ?? Number.MAX_SAFE_INTEGER,
        rightRow.rightRank ?? Number.MAX_SAFE_INTEGER,
      );
      return leftBest - rightBest || leftRow.fullName.localeCompare(rightRow.fullName);
    });
}

function comparisonValue(value: number | null, prefix = ""): string {
  return value === null ? "—" : `${prefix}${value}`;
}

export function RankingsStudio() {
  const [lists, setLists] = useState<RankingList[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceBoardId, setWorkspaceBoardId] = useState<string | null>(null);
  const [version, setVersion] = useState<RankingVersion | null>(null);
  const [entries, setEntries] = useState<EditableEntry[]>([]);
  const [entriesDirty, setEntriesDirty] = useState(false);
  const [pageState, setPageState] = useState<RequestState>("working");
  const [versionState, setVersionState] = useState<RequestState>("idle");
  const [actionState, setActionState] = useState<RequestState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const noticeIsError =
    actionState === "error" || pageState === "error" || versionState === "error";
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("My 2026 draft board");
  const [newKind, setNewKind] = useState<ListKind>("cheat-sheet");
  const [newSeason, setNewSeason] = useState(new Date().getFullYear());
  const [newFormat, setNewFormat] = useState<ScoringFormat>("PPR");
  const [metadataName, setMetadataName] = useState("");
  const [metadataDescription, setMetadataDescription] = useState("");
  const [csvSource, setCsvSource] = useState("");
  const [csvFileName, setCsvFileName] = useState(defaultCsvFileName);
  const [csvColumns, setCsvColumns] = useState<CsvColumns>({ ...defaultCsvColumns });
  const [boundCsvPreview, setBoundCsvPreview] = useState<BoundCsvPreview | null>(null);
  const [csvDirty, setCsvDirty] = useState(false);
  const [csvState, setCsvState] = useState<RequestState>("idle");
  const [csvMessage, setCsvMessage] = useState<string | null>(null);
  const [share, setShare] = useState<ShareReceipt | null>(null);
  const [shareRevokeArmed, setShareRevokeArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [comparisonTargetId, setComparisonTargetId] = useState("");
  const [comparison, setComparison] = useState<RankingComparison | null>(null);
  const [comparisonState, setComparisonState] = useState<RequestState>("idle");
  const [mutationInFlight, setMutationInFlight] = useState(false);
  const [versionReload, setVersionReload] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const selectedIdRef = useRef<string | null>(null);
  const workspaceBoardIdRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const mutationRef = useRef(false);
  const controlsBusyRef = useRef(false);
  const listsRequestRef = useRef<AbortController | null>(null);
  const listsRequestGate = useRef(new LatestRequest());
  const versionRequestRef = useRef<AbortController | null>(null);
  const versionRequestGate = useRef(new LatestRequest());
  const csvPreviewRequestRef = useRef<AbortController | null>(null);
  const csvPreviewRequestGate = useRef(new LatestRequest());

  const selected = useMemo(
    () => lists.find((candidate) => candidate.id === selectedId) ?? null,
    [lists, selectedId],
  );
  const selectedBoardId = selected?.id ?? null;
  const selectedVersionId = selected?.currentVersionId ?? null;
  const workspaceMatches = selectedBoardId !== null && workspaceBoardId === selectedBoardId;
  const visibleVersion = workspaceMatches ? version : null;
  const visibleEntries = workspaceMatches ? entries : [];
  const availableComparisonBoards = useMemo(
    () => lists.filter((list) => list.id !== selectedBoardId && list.currentVersionId !== null),
    [lists, selectedBoardId],
  );
  const visibleComparisonRows = useMemo(
    () => (comparison ? comparisonRows(comparison) : []),
    [comparison],
  );
  const csvPreview =
    workspaceMatches && boundCsvPreview?.boardId === selectedBoardId
      ? boundCsvPreview.preview
      : null;
  const metadataDirty =
    workspaceMatches &&
    selected !== null &&
    (metadataName !== selected.name || metadataDescription !== (selected.description ?? ""));
  const hasUnsavedChanges = workspaceMatches && (entriesDirty || metadataDirty || csvDirty);
  const controlsBusy =
    mutationInFlight ||
    actionState === "working" ||
    csvState === "working" ||
    comparisonState === "working" ||
    pageState === "working";
  selectedIdRef.current = selectedId;
  workspaceBoardIdRef.current = workspaceBoardId;
  dirtyRef.current = hasUnsavedChanges;
  controlsBusyRef.current = controlsBusy;

  const resetWorkspace = useCallback((boardId: string | null) => {
    versionRequestRef.current?.abort();
    versionRequestRef.current = null;
    versionRequestGate.current.invalidate();
    csvPreviewRequestRef.current?.abort();
    csvPreviewRequestRef.current = null;
    csvPreviewRequestGate.current.invalidate();
    setWorkspaceBoardId(boardId);
    setVersion(null);
    setEntries([]);
    setEntriesDirty(false);
    setVersionState("idle");
    setMetadataName("");
    setMetadataDescription("");
    setShare(null);
    setShareRevokeArmed(false);
    setCopied(false);
    setComparison(null);
    setComparisonState("idle");
    setCsvSource("");
    setCsvFileName(defaultCsvFileName);
    setCsvColumns({ ...defaultCsvColumns });
    setBoundCsvPreview(null);
    setCsvDirty(false);
    setCsvState("idle");
    setCsvMessage(null);
    dirtyRef.current = false;
  }, []);

  const loadLists = useCallback(
    async (
      preferredId?: string,
      options: { readonly reloadVersion?: boolean; readonly resetMetadata?: boolean } = {},
    ) => {
      listsRequestRef.current?.abort();
      const controller = new AbortController();
      const request = listsRequestGate.current.begin(
        preferredId ?? selectedIdRef.current ?? "first",
      );
      listsRequestRef.current = controller;
      const isCurrent = () =>
        !controller.signal.aborted && listsRequestGate.current.isCurrent(request);
      setPageState("working");
      try {
        const result = await apiJson<{ lists: RankingList[] }>("/v1/rankings", {
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        setLists(result.lists);
        const preferred = preferredId ?? selectedIdRef.current;
        const nextList =
          result.lists.find((list) => list.id === preferred) ?? result.lists[0] ?? null;
        const nextId = nextList?.id ?? null;
        if (nextId !== selectedIdRef.current) {
          selectedIdRef.current = nextId;
          resetWorkspace(nextId);
          setSelectedId(nextId);
        }
        if (options.resetMetadata && nextList) {
          setMetadataName(nextList.name);
          setMetadataDescription(nextList.description ?? "");
        }
        if (options.reloadVersion) setVersionReload((current) => current + 1);
        setPageState("done");
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof RankingUiError && error.status === 401) {
          setDemoMode(true);
          setPageState("done");
          return;
        }
        setMessage(error instanceof Error ? error.message : "Rankings could not be loaded.");
        setPageState("error");
      } finally {
        if (isCurrent()) listsRequestRef.current = null;
      }
    },
    [resetWorkspace],
  );

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    setWorkspaceBoardId(selectedBoardId);
    setShare(null);
    setShareRevokeArmed(false);
    setCopied(false);
    csvPreviewRequestRef.current?.abort();
    csvPreviewRequestRef.current = null;
    csvPreviewRequestGate.current.invalidate();
    setBoundCsvPreview(null);
    setCsvSource("");
    setCsvFileName(defaultCsvFileName);
    setCsvColumns({ ...defaultCsvColumns });
    setCsvDirty(false);
    setCsvState("idle");
    setCsvMessage(null);
    setComparison(null);
    setComparisonState("idle");
    if (!selected) {
      setMetadataName("");
      setMetadataDescription("");
      return;
    }
    setMetadataName(selected.name);
    setMetadataDescription(selected.description ?? "");
  }, [selectedBoardId]);

  useEffect(() => {
    setComparisonTargetId((current) =>
      current && current !== selectedBoardId && lists.some((list) => list.id === current)
        ? current
        : (lists.find((list) => list.id !== selectedBoardId && list.currentVersionId)?.id ?? ""),
    );
  }, [lists, selectedBoardId]);

  useEffect(() => {
    setComparison(null);
    setComparisonState("idle");
  }, [selectedVersionId]);

  useEffect(() => {
    versionRequestRef.current?.abort();
    versionRequestRef.current = null;
    versionRequestGate.current.invalidate();
    setVersion(null);
    setEntries([]);
    setEntriesDirty(false);
    if (!selectedBoardId || !selectedVersionId) {
      setVersion(null);
      setEntries([]);
      setVersionState(selectedBoardId ? "done" : "idle");
      return;
    }

    const controller = new AbortController();
    const request = versionRequestGate.current.begin(
      `${selectedBoardId}:${selectedVersionId}:${versionReload}`,
    );
    versionRequestRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      versionRequestGate.current.isCurrent(request) &&
      selectedIdRef.current === selectedBoardId;
    setVersionState("working");
    void apiJson<{ version: RankingVersion; players: PlayerIdentity[] }>(
      `/v1/rankings/${selectedBoardId}/version`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!isCurrent()) return;
        setVersion(result.version);
        setEntries(editableEntries(result.version, result.players));
        setEntriesDirty(false);
        setVersionState("done");
      })
      .catch((error: unknown) => {
        if (!isCurrent() || (error instanceof RankingUiError && error.status === 401)) return;
        setVersionState("error");
        setMessage(error instanceof Error ? error.message : "The ranking version could not load.");
      })
      .finally(() => {
        if (isCurrent()) versionRequestRef.current = null;
      });
    return () => {
      controller.abort();
      if (versionRequestRef.current === controller) versionRequestRef.current = null;
      versionRequestGate.current.invalidate();
    };
  }, [selectedBoardId, selectedVersionId, versionReload]);

  useEffect(
    () => () => {
      listsRequestRef.current?.abort();
      versionRequestRef.current?.abort();
      csvPreviewRequestRef.current?.abort();
      listsRequestGate.current.invalidate();
      versionRequestGate.current.invalidate();
      csvPreviewRequestGate.current.invalidate();
    },
    [],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const guardId = crypto.randomUUID();
    let pendingDestination: string | null = null;
    const guardedHistoryState = () => ({
      ...((history.state as Record<string, unknown> | null) ?? {}),
      [rankingsHistoryGuardKey]: guardId,
    });
    const pushHistoryGuard = () => {
      history.pushState(guardedHistoryState(), "", window.location.href);
    };
    const clearHistoryGuard = () => {
      const currentState = (history.state as Record<string, unknown> | null) ?? {};
      if (currentState[rankingsHistoryGuardKey] !== guardId) return false;
      const nextState = { ...currentState };
      delete nextState[rankingsHistoryGuardKey];
      history.replaceState(nextState, "", window.location.href);
      return true;
    };
    pushHistoryGuard();
    let guardedNavigationApproved = false;

    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const warnBeforeHistoryNavigation = () => {
      if (pendingDestination !== null) {
        const destination = pendingDestination;
        pendingDestination = null;
        window.location.assign(destination);
        return;
      }
      if (!dirtyRef.current) return;
      if (controlsBusyRef.current || mutationRef.current) {
        pushHistoryGuard();
        return;
      }
      if (window.confirm("Discard unsaved board edits and CSV work before leaving this page?")) {
        dirtyRef.current = false;
        history.back();
        return;
      }
      pushHistoryGuard();
    };
    const warnBeforeClientNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      const anchor = target instanceof Element ? target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.download) {
        return;
      }
      if (controlsBusyRef.current || mutationRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (
        !["http:", "https:"].includes(destination.protocol) ||
        destination.href === window.location.href
      ) {
        return;
      }
      if (!window.confirm("Discard unsaved board edits and CSV work before leaving this page?")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dirtyRef.current = false;
      pendingDestination = destination.href;
      history.back();
    };
    const warnBeforeGuardedNavigation = (event: Event) => {
      guardedNavigationApproved = false;
      if (
        controlsBusyRef.current ||
        mutationRef.current ||
        !window.confirm("Discard unsaved board edits and CSV work before signing out?")
      ) {
        event.preventDefault();
        return;
      }
      guardedNavigationApproved = true;
    };
    const commitGuardedNavigation = () => {
      if (!guardedNavigationApproved) return;
      guardedNavigationApproved = false;
      dirtyRef.current = false;
      clearHistoryGuard();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("popstate", warnBeforeHistoryNavigation);
    window.addEventListener(guardedNavigationRequestEvent, warnBeforeGuardedNavigation);
    window.addEventListener(guardedNavigationCommitEvent, commitGuardedNavigation);
    document.addEventListener("click", warnBeforeClientNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("popstate", warnBeforeHistoryNavigation);
      window.removeEventListener(guardedNavigationRequestEvent, warnBeforeGuardedNavigation);
      window.removeEventListener(guardedNavigationCommitEvent, commitGuardedNavigation);
      document.removeEventListener("click", warnBeforeClientNavigation, true);
      if (clearHistoryGuard()) history.back();
    };
  }, [hasUnsavedChanges]);

  function beginMutation(): boolean {
    if (mutationRef.current) return false;
    mutationRef.current = true;
    setMutationInFlight(true);
    return true;
  }

  function finishMutation() {
    mutationRef.current = false;
    setMutationInFlight(false);
  }

  function confirmDiscardChanges(): boolean {
    return (
      !dirtyRef.current ||
      window.confirm("Discard unsaved board edits and CSV work before continuing?")
    );
  }

  function selectBoard(boardId: string) {
    if (boardId === selectedIdRef.current || controlsBusy || mutationRef.current) return;
    if (!confirmDiscardChanges()) return;
    selectedIdRef.current = boardId;
    resetWorkspace(boardId);
    setSelectedId(boardId);
  }

  function openCreateForm() {
    if (controlsBusy || mutationRef.current || !confirmDiscardChanges()) return;
    setShowCreate(true);
  }

  function refreshStudio() {
    if (controlsBusy || mutationRef.current || !confirmDiscardChanges()) return;
    resetWorkspace(selectedIdRef.current);
    void loadLists(selectedIdRef.current ?? undefined, {
      reloadVersion: true,
      resetMetadata: true,
    });
  }

  async function cloneBoard() {
    if (
      !selected?.currentVersionId ||
      !selected.capabilities.canClone ||
      controlsBusy ||
      !confirmDiscardChanges() ||
      !beginMutation()
    )
      return;
    const source = selected;
    const name = `${source.name} (my board)`.slice(0, 160);
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<{ list: { readonly id: string }; version: RankingVersion }>(
        `/v1/rankings/${source.id}/clone`,
        {
          method: "POST",
          body: JSON.stringify({
            name,
            sourceVersionId: source.currentVersionId,
            changeNote: `Started from ${source.name}`,
          }),
        },
      );
      selectedIdRef.current = result.list.id;
      resetWorkspace(result.list.id);
      setSelectedId(result.list.id);
      await loadLists(result.list.id, { reloadVersion: true, resetMetadata: true });
      setActionState("done");
      setMessage(`Baseline copied into an independent private draft.`);
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "The baseline could not be copied.");
    } finally {
      finishMutation();
    }
  }

  async function compareBoards() {
    if (
      !selected?.currentVersionId ||
      !comparisonTargetId ||
      entriesDirty ||
      controlsBusy ||
      mutationRef.current
    )
      return;
    setComparisonState("working");
    setComparison(null);
    setMessage(null);
    try {
      const result = await apiJson<RankingComparison>("/v1/rankings/compare", {
        method: "POST",
        body: JSON.stringify({
          left: { listId: selected.id, versionId: selected.currentVersionId },
          right: { listId: comparisonTargetId },
        }),
      });
      setComparison(result);
      setComparisonState("done");
    } catch (error) {
      setComparisonState("error");
      setMessage(error instanceof Error ? error.message : "The boards could not be compared.");
    }
  }

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (controlsBusy || !confirmDiscardChanges() || !beginMutation()) return;
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<{ list: RankingList }>("/v1/rankings", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          season: newSeason,
          kind: newKind,
          scoringContext: {
            format: newFormat,
            leagueId: null,
            settingsChecksumSha256: null,
            label: newFormat.replace("_", " "),
          },
          visibility: { scope: "private" },
        }),
      });
      setShowCreate(false);
      setMessage("Board created. Import a CSV below to save its first version.");
      selectedIdRef.current = result.list.id;
      resetWorkspace(result.list.id);
      setSelectedId(result.list.id);
      await loadLists(result.list.id, { reloadVersion: true });
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "The board could not be created.");
    } finally {
      finishMutation();
    }
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !selected?.capabilities.canEdit ||
      !workspaceMatches ||
      !metadataDirty ||
      controlsBusy ||
      !beginMutation()
    )
      return;
    const boardId = selected.id;
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<{ list: RankingList }>(`/v1/rankings/${boardId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: metadataName.trim(),
          description: metadataDescription.trim() || null,
        }),
      });
      setLists((current) => current.map((list) => (list.id === boardId ? result.list : list)));
      setMetadataName(result.list.name);
      setMetadataDescription(result.list.description ?? "");
      setActionState("done");
      setMessage("Board metadata saved.");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "Metadata could not be saved.");
    } finally {
      finishMutation();
    }
  }

  const canEditSelected = selected?.capabilities.canEdit === true;

  /* Stable references so memoized RankingRows survive sibling keystrokes. */
  const updateEntry = useCallback(
    (index: number, patch: Partial<EditableEntry>) => {
      if (!canEditSelected || !workspaceMatches || controlsBusy || mutationRef.current) return;
      setEntries((current) =>
        current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
      );
      setEntriesDirty(true);
      dirtyRef.current = true;
    },
    [canEditSelected, controlsBusy, workspaceMatches],
  );

  const moveEntry = useCallback(
    (index: number, direction: -1 | 1) => {
      const targetIndex = index + direction;
      if (!canEditSelected || targetIndex < 0 || targetIndex >= entries.length || controlsBusy)
        return;
      setEntries((current) => {
        const reordered = [...current];
        const [moved] = reordered.splice(index, 1);
        if (!moved) return current;
        reordered.splice(targetIndex, 0, moved);
        return reordered.map((entry, entryIndex) => ({
          ...entry,
          overallRank: String(entryIndex + 1),
        }));
      });
      setEntriesDirty(true);
      dirtyRef.current = true;
    },
    [canEditSelected, controlsBusy, entries.length],
  );

  const removeEntry = useCallback((index: number) => {
    setEntries((current) => current.filter((_, candidateIndex) => candidateIndex !== index));
    setEntriesDirty(true);
    dirtyRef.current = true;
  }, []);

  async function saveEntries() {
    if (
      !selected?.capabilities.canEdit ||
      !workspaceMatches ||
      !entriesDirty ||
      controlsBusy ||
      !beginMutation()
    )
      return;
    const boardId = selected.id;
    const expectedCurrentVersionId = selected.currentVersionId;
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<{ version: RankingVersion }>(`/v1/rankings/${boardId}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          expectedCurrentVersionId,
          entries: entries.map(manualEntry),
          changeNote: "Edited in Rankings Studio",
        }),
      });
      setMessage(`Draft v${result.version.versionNumber} saved with its source details.`);
      setEntriesDirty(false);
      await loadLists(boardId, { reloadVersion: true });
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "Draft edits could not be saved.");
    } finally {
      finishMutation();
    }
  }

  async function publishVersion() {
    if (
      !selected?.currentVersionId ||
      !selected.capabilities.canEdit ||
      !workspaceMatches ||
      entriesDirty ||
      controlsBusy ||
      !beginMutation()
    )
      return;
    const boardId = selected.id;
    const expectedCurrentVersionId = selected.currentVersionId;
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<{ version: RankingVersion }>(`/v1/rankings/${boardId}/publish`, {
        method: "POST",
        body: JSON.stringify({
          expectedCurrentVersionId,
          changeNote: "Published from Rankings Studio",
        }),
      });
      setMessage(`Published v${result.version.versionNumber}.`);
      await loadLists(boardId, { reloadVersion: true });
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "The version could not be published.");
    } finally {
      finishMutation();
    }
  }

  function csvMapping() {
    return Object.fromEntries(
      Object.entries(csvColumns).flatMap(([field, column]) =>
        column.trim() ? [[field, column.trim()]] : [],
      ),
    );
  }

  function invalidateCsvPreview() {
    csvPreviewRequestRef.current?.abort();
    csvPreviewRequestRef.current = null;
    csvPreviewRequestGate.current.invalidate();
    setBoundCsvPreview(null);
  }

  function markCsvChanged() {
    invalidateCsvPreview();
    setCsvDirty(true);
    setCsvMessage(null);
    dirtyRef.current = true;
  }

  async function previewCsv() {
    if (!selected?.capabilities.canEdit || !workspaceMatches || controlsBusy || mutationRef.current)
      return;
    const boardId = selected.id;
    const source = csvSource;
    const sourceFileName = csvFileName.trim();
    const mapping = csvMapping();
    csvPreviewRequestRef.current?.abort();
    const controller = new AbortController();
    const request = csvPreviewRequestGate.current.begin(
      JSON.stringify([boardId, source, sourceFileName, mapping]),
    );
    csvPreviewRequestRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      csvPreviewRequestGate.current.isCurrent(request) &&
      selectedIdRef.current === boardId &&
      workspaceBoardIdRef.current === boardId;
    setCsvState("working");
    setCsvMessage(null);
    setBoundCsvPreview(null);
    try {
      const result = await apiJson<{ preview: CsvPreview }>(
        `/v1/rankings/${boardId}/imports/csv/preview`,
        {
          method: "POST",
          body: JSON.stringify({ source, mapping, hasHeader: true }),
          signal: controller.signal,
        },
      );
      if (!isCurrent()) return;
      setBoundCsvPreview({
        boardId,
        source,
        sourceFileName,
        mapping,
        preview: result.preview,
        importKey: crypto.randomUUID(),
      });
      setCsvState("done");
    } catch (error) {
      if (!isCurrent()) return;
      setCsvState("error");
      setCsvMessage(error instanceof Error ? error.message : "The CSV preview failed.");
    } finally {
      if (isCurrent()) csvPreviewRequestRef.current = null;
    }
  }

  async function commitCsv() {
    const receipt = boundCsvPreview;
    if (
      !selected ||
      !selected.capabilities.canEdit ||
      !workspaceMatches ||
      entriesDirty ||
      controlsBusy ||
      !receipt ||
      receipt.boardId !== selected.id
    )
      return;
    const boardId = selected.id;
    const expectedCurrentVersionId = selected.currentVersionId;
    const readyRows = receipt.preview.rows
      .filter((row) => row.status === "ready")
      .map((row) => row.rowNumber);
    if (readyRows.length === 0) {
      setCsvMessage("There are no valid rows to commit.");
      return;
    }
    if (!beginMutation()) return;
    setCsvState("working");
    setCsvMessage(null);
    try {
      const decision = receipt.preview.canCommitAll
        ? {
            mode: "all-valid" as const,
            previewChecksumSha256: receipt.preview.previewChecksumSha256,
          }
        : {
            mode: "selected-rows" as const,
            previewChecksumSha256: receipt.preview.previewChecksumSha256,
            rowNumbers: readyRows,
          };
      const result = await apiJson<{ version: RankingVersion }>(
        `/v1/rankings/${boardId}/imports/csv`,
        {
          method: "POST",
          body: JSON.stringify({
            source: receipt.source,
            sourceFileName: receipt.sourceFileName || null,
            mapping: receipt.mapping,
            hasHeader: true,
            expectedCurrentVersionId,
            idempotencyKey: receipt.importKey,
            decision,
            changeNote: "Imported in Rankings Studio",
          }),
        },
      );
      setCsvState("done");
      setCsvMessage(
        `Imported ${readyRows.length} players into draft v${result.version.versionNumber}.`,
      );
      setBoundCsvPreview(null);
      setCsvSource("");
      setCsvFileName(defaultCsvFileName);
      setCsvColumns({ ...defaultCsvColumns });
      setCsvDirty(false);
      await loadLists(boardId, { reloadVersion: true });
    } catch (error) {
      setCsvState("error");
      setCsvMessage(error instanceof Error ? error.message : "The CSV could not be committed.");
    } finally {
      finishMutation();
    }
  }

  async function exportBoard(format: "json" | "csv") {
    if (!selected || !visibleVersion || entriesDirty || !beginMutation()) return;
    const board = selected;
    setActionState("working");
    setMessage(null);
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/rankings/${board.id}/export?format=${format}`,
        { credentials: "include" },
      );
      if (response.status === 401) {
        window.location.assign(loginUrlForCurrentPath());
        return;
      }
      if (!response.ok)
        throw new RankingUiError("The export could not be created.", response.status);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${
        board.name
          .replace(/[^a-z0-9]+/giu, "-")
          .replace(/^-|-$/gu, "")
          .toLowerCase() || "rankings"
      }.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setActionState("done");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "The export failed.");
    } finally {
      finishMutation();
    }
  }

  async function createShare() {
    if (!selected?.capabilities.canEdit || !visibleVersion || entriesDirty || !beginMutation())
      return;
    const boardId = selected.id;
    setActionState("working");
    setMessage(null);
    try {
      const result = await apiJson<ShareReceipt>(`/v1/rankings/${boardId}/shares`, {
        method: "POST",
        body: JSON.stringify({ label: "Rankings Studio share", allowCopy: true, maxUses: 100 }),
      });
      setShare(result);
      setShareRevokeArmed(false);
      setActionState("done");
      setMessage("Private share created. Its access key stays in the link fragment.");
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "A share could not be created.");
    } finally {
      finishMutation();
    }
  }

  async function copyShare() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("Copy was blocked by the browser. Select the link manually.");
    }
  }

  async function revokeShare() {
    if (!selected || !share) return;
    if (!shareRevokeArmed) {
      setShareRevokeArmed(true);
      setMessage("Confirm that you want to revoke this private link.");
      return;
    }
    if (!beginMutation()) return;
    const boardId = selected.id;
    const shareId = share.id;
    setActionState("working");
    try {
      await apiJson(`/v1/rankings/${boardId}/shares/${shareId}`, { method: "DELETE" });
      setShare(null);
      setShareRevokeArmed(false);
      setActionState("done");
      setMessage("Share revoked. The old link no longer opens this board.");
      await loadLists(boardId);
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "The share could not be revoked.");
    } finally {
      finishMutation();
    }
  }

  if (demoMode) return <DemoRankingsStudio />;

  return (
    <div className="rankings-page">
      <section className="page-heading rankings-heading">
        <div>
          <p className="eyebrow">Your board, your numbers</p>
          <h1>Rankings Studio</h1>
          <p className="page-subtitle">
            Build rankings, ADP, auction values, and cheat sheets. Keep every revision, see where
            each number came from, and match CSV imports against the daily player catalog before
            saving.
          </p>
        </div>
        <div className="heading-actions">
          <Link
            className="button button--outline"
            href="/projections"
            aria-disabled={controlsBusy}
            onClick={(event) => {
              if (controlsBusy || mutationRef.current || !confirmDiscardChanges()) {
                event.preventDefault();
              }
            }}
          >
            <ChartNoAxesCombined size={15} /> Projection sets
          </Link>
          <button
            className="button button--outline"
            type="button"
            disabled={controlsBusy}
            onClick={refreshStudio}
          >
            <RefreshCw size={15} /> Refresh
          </button>
          <button
            className="button button--dark"
            type="button"
            disabled={controlsBusy}
            onClick={openCreateForm}
          >
            <Plus size={15} /> New board
          </button>
        </div>
      </section>

      {/* A load failure sets pageState, not actionState, so keying the tone off
          actionState alone rendered "Failed to fetch" as a green checkmark. */}
      {message ? (
        <div
          className={`ranking-notice ranking-notice--${noticeIsError ? "error" : "info"}`}
          role={noticeIsError ? "alert" : "status"}
        >
          {noticeIsError ? <TriangleAlert size={16} /> : <Check size={16} />}
          <span>{message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setMessage(null)}>
            <X size={15} />
          </button>
        </div>
      ) : null}

      {showCreate ? (
        <form className="panel ranking-create" onSubmit={(event) => void createList(event)}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">New board</p>
              <h2>Create a private board</h2>
            </div>
            <button
              className="icon-button icon-button--small"
              type="button"
              aria-label="Close create form"
              onClick={() => setShowCreate(false)}
            >
              <X size={15} />
            </button>
          </div>
          <div className="ranking-form-grid">
            <label>
              <span>Name</span>
              <input
                value={newName}
                maxLength={160}
                required
                disabled={controlsBusy}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label>
              <span>Board type</span>
              <select
                value={newKind}
                disabled={controlsBusy}
                onChange={(event) => setNewKind(event.target.value as ListKind)}
              >
                <option value="rankings">Rankings</option>
                <option value="adp">ADP</option>
                <option value="auction-values">Auction values</option>
                <option value="cheat-sheet">Cheat sheet</option>
              </select>
            </label>
            <label>
              <span>Season</span>
              <input
                type="number"
                min={2000}
                max={2100}
                value={newSeason}
                disabled={controlsBusy}
                onChange={(event) => setNewSeason(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Scoring</span>
              <select
                value={newFormat}
                disabled={controlsBusy}
                onChange={(event) => setNewFormat(event.target.value as ScoringFormat)}
              >
                <option value="STANDARD">Standard</option>
                <option value="HALF_PPR">Half PPR</option>
                <option value="PPR">PPR</option>
                <option value="CUSTOM">Custom</option>
              </select>
            </label>
          </div>
          <div className="ranking-form-actions">
            <span>
              <ShieldCheck size={14} /> Private until you explicitly share it
            </span>
            <button className="button button--lime" disabled={controlsBusy} type="submit">
              {actionState === "working" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <ListPlus size={15} />
              )}{" "}
              Create board
            </button>
          </div>
        </form>
      ) : null}

      <div className="ranking-studio-grid">
        <aside className="panel ranking-library" aria-label="Ranking boards">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Library</p>
              <h2>Available boards</h2>
            </div>
            <span className="count-badge">{lists.length}</span>
          </div>
          {pageState === "working" ? (
            <div className="ranking-loading">
              <LoaderCircle className="spin" size={18} /> Loading boards…
            </div>
          ) : null}
          {/* "done" only — a failed load left lists empty and claimed the user
              had no boards. */}
          {pageState === "done" && lists.length === 0 ? (
            <div className="ranking-empty">
              <FileSpreadsheet size={24} />
              <strong>No boards yet</strong>
              <p>Create one, then import a custom CSV.</p>
            </div>
          ) : null}
          {pageState === "error" ? (
            <div className="ranking-empty">
              <TriangleAlert size={24} />
              <strong>Your boards could not be loaded</strong>
              <p>They are still saved. Try again in a moment.</p>
            </div>
          ) : null}
          <div className="ranking-list">
            {lists.map((list) => (
              <button
                className={list.id === selectedId ? "is-selected" : ""}
                type="button"
                key={list.id}
                aria-pressed={list.id === selectedId}
                disabled={controlsBusy}
                onClick={() => selectBoard(list.id)}
              >
                <span className="ranking-kind-icon">
                  {list.kind === "auction-values" ? "$" : list.kind === "adp" ? "A" : "#"}
                </span>
                <span>
                  <strong>{list.name}</strong>
                  <small>
                    {list.season} · {kindLabel(list.kind)} ·{" "}
                    {list.scoringContext.label ?? list.scoringContext.format} ·{" "}
                    {list.capabilities.canEdit ? "Yours" : "League baseline"}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </aside>

        <div className="ranking-workspace">
          {!selected ? (
            <section className="panel ranking-welcome">
              <FileSpreadsheet size={34} />
              <h2>Select or create a board</h2>
              <p>
                CSV is the quickest start: use headers{" "}
                <code>name, position, rank, tier, adp, aav, target_price, notes</code>.
              </p>
              <button className="button button--dark" type="button" onClick={openCreateForm}>
                <Plus size={15} /> Create first board
              </button>
            </section>
          ) : (
            <>
              <section className="panel ranking-board-head">
                <form onSubmit={(event) => void saveMetadata(event)}>
                  <div className="ranking-board-title">
                    <div>
                      <span className="status-chip">{selected.visibility.scope}</span>
                      <span className="status-chip">{kindLabel(selected.kind)}</span>
                      {selected.archivedAt ? (
                        <span className="status-chip">
                          <Archive size={11} /> archived
                        </span>
                      ) : null}
                    </div>
                    <label>
                      <span className="sr-only">Board name</span>
                      <input
                        value={metadataName}
                        maxLength={160}
                        required
                        disabled={controlsBusy || !selected.capabilities.canEdit}
                        onChange={(event) => setMetadataName(event.target.value)}
                      />
                    </label>
                    <label>
                      <span className="sr-only">Description</span>
                      <textarea
                        value={metadataDescription}
                        maxLength={4000}
                        placeholder="What makes this board different?"
                        disabled={controlsBusy || !selected.capabilities.canEdit}
                        onChange={(event) => setMetadataDescription(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="ranking-board-actions">
                    <button
                      className="button button--outline button--small"
                      type="button"
                      disabled={!visibleVersion || !selected.capabilities.canClone || controlsBusy}
                      onClick={() => void cloneBoard()}
                    >
                      <Copy size={14} /> Use as baseline
                    </button>
                    {selected.capabilities.canEdit ? (
                      <button
                        className="button button--outline button--small"
                        type="submit"
                        disabled={!metadataDirty || controlsBusy}
                      >
                        <PencilLine size={14} /> Save metadata
                      </button>
                    ) : null}
                  </div>
                </form>
                <div className="ranking-version-strip">
                  {visibleVersion ? (
                    <>
                      <span
                        className={`ranking-version-state ranking-version-state--${visibleVersion.state}`}
                      >
                        {visibleVersion.state}
                      </span>
                      <strong>v{visibleVersion.versionNumber}</strong>
                      <span>
                        <History size={13} /> {dateLabel(visibleVersion.createdAt)}
                      </span>
                      <span className="ranking-checksum" title={visibleVersion.checksumSha256}>
                        SHA {visibleVersion.checksumSha256.slice(0, 12)}
                      </span>
                      <span>
                        {visibleVersion.provenance.operation} ·{" "}
                        {visibleVersion.provenance.sources
                          .map((source) => source.label ?? source.kind)
                          .join(" + ") || "manual"}
                      </span>
                    </>
                  ) : (
                    <span>No saved version yet</span>
                  )}
                </div>
              </section>

              <section className="panel ranking-comparison" aria-labelledby="board-compare-title">
                <div className="ranking-comparison-toolbar">
                  <div>
                    <p className="eyebrow">Board comparison</p>
                    <h2 id="board-compare-title">Pressure-test the baseline</h2>
                    <p>Compare saved ranks and market values without changing either board.</p>
                  </div>
                  <div className="ranking-comparison-controls">
                    <label>
                      <span className="sr-only">Board to compare with {selected.name}</span>
                      <select
                        value={comparisonTargetId}
                        disabled={availableComparisonBoards.length === 0 || controlsBusy}
                        onChange={(event) => {
                          setComparisonTargetId(event.target.value);
                          setComparison(null);
                          setComparisonState("idle");
                        }}
                      >
                        {availableComparisonBoards.length === 0 ? (
                          <option value="">No other saved boards</option>
                        ) : null}
                        {availableComparisonBoards.map((list) => (
                          <option value={list.id} key={list.id}>
                            {list.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button button--dark button--small"
                      type="button"
                      disabled={!comparisonTargetId || entriesDirty || controlsBusy}
                      onClick={() => void compareBoards()}
                    >
                      {comparisonState === "working" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <GitCompareArrows size={14} />
                      )}{" "}
                      Compare saved boards
                    </button>
                  </div>
                </div>
                {availableComparisonBoards.length === 0 ? (
                  <p className="ranking-comparison-empty">
                    Create or copy another saved board to compare assumptions side by side.
                  </p>
                ) : null}
                {comparison ? (
                  <div className="ranking-comparison-result">
                    <div className="ranking-comparison-summary" aria-live="polite">
                      <strong>{comparison.left.list.name}</strong>
                      <GitCompareArrows size={15} />
                      <strong>{comparison.right.list.name}</strong>
                      <span>{visibleComparisonRows.length} players across both boards</span>
                    </div>
                    <div
                      className="ranking-table-wrap"
                      role="region"
                      aria-label="Board comparison; scroll horizontally to view all columns"
                      tabIndex={0}
                    >
                      <table className="ranking-table ranking-comparison-table">
                        <thead>
                          <tr>
                            <th scope="col">Player</th>
                            <th scope="col">Pos</th>
                            <th scope="col">A rank</th>
                            <th scope="col">B rank</th>
                            <th scope="col">B movement</th>
                            <th scope="col">A / B tier</th>
                            <th scope="col">A / B ADP</th>
                            <th scope="col">A / B AAV</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleComparisonRows.map((row) => (
                            <tr key={row.playerId}>
                              <td>
                                <strong>{row.fullName}</strong>
                                <small>{row.playerId.slice(0, 8)}</small>
                              </td>
                              <td>{row.position ?? "—"}</td>
                              <td>{comparisonValue(row.leftRank)}</td>
                              <td>{comparisonValue(row.rightRank)}</td>
                              <td>
                                {row.rankDelta === null ? (
                                  <span className="ranking-comparison-muted">
                                    {row.leftRank === null ? "Only B" : "Only A"}
                                  </span>
                                ) : row.rankDelta === 0 ? (
                                  <span className="ranking-comparison-muted">Even</span>
                                ) : (
                                  <span
                                    className={
                                      row.rankDelta > 0
                                        ? "ranking-movement ranking-movement--up"
                                        : "ranking-movement ranking-movement--down"
                                    }
                                  >
                                    {row.rankDelta > 0 ? "↑" : "↓"} {Math.abs(row.rankDelta)}
                                  </span>
                                )}
                              </td>
                              <td>
                                {comparisonValue(row.leftTier)} / {comparisonValue(row.rightTier)}
                              </td>
                              <td>
                                {comparisonValue(row.leftAdp)} / {comparisonValue(row.rightAdp)}
                              </td>
                              <td>
                                {comparisonValue(row.leftAav, "$")} /{" "}
                                {comparisonValue(row.rightAav, "$")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="panel ranking-editor">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">
                      {selected.capabilities.canEdit ? "Editable draft" : "Available baseline"}
                    </p>
                    <h2>{visibleEntries.length} ranked players</h2>
                    <p>
                      {selected.capabilities.canEdit
                        ? "Edits create a new child version; previous snapshots never change."
                        : "Copy this board to make private changes without altering its source."}
                    </p>
                  </div>
                  <div className="ranking-editor-actions">
                    <button
                      className="button button--outline button--small"
                      type="button"
                      disabled={
                        !selected.capabilities.canEdit ||
                        !visibleVersion ||
                        entriesDirty ||
                        controlsBusy
                      }
                      onClick={() => void publishVersion()}
                    >
                      <Send size={14} /> Publish
                    </button>
                    <button
                      className="button button--lime button--small"
                      type="button"
                      disabled={
                        !selected.capabilities.canEdit ||
                        !visibleVersion ||
                        !entriesDirty ||
                        controlsBusy
                      }
                      onClick={() => void saveEntries()}
                    >
                      {actionState === "working" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Save size={14} />
                      )}{" "}
                      Save draft
                    </button>
                  </div>
                </div>
                {versionState === "working" ? (
                  <div className="ranking-loading">
                    <LoaderCircle className="spin" size={18} /> Loading saved version…
                  </div>
                ) : null}
                {versionState !== "working" && visibleEntries.length === 0 ? (
                  <div className="ranking-empty ranking-empty--editor">
                    <CloudUpload size={25} />
                    <strong>Import your first player set below</strong>
                    <p>
                      Names are resolved against the player catalog before a version can be
                      committed.
                    </p>
                  </div>
                ) : null}
                {visibleEntries.length > 0 ? (
                  <div
                    className="ranking-table-wrap"
                    role="region"
                    aria-label="Ranking board; scroll horizontally to view all columns"
                    tabIndex={0}
                  >
                    <table className="ranking-table">
                      <thead>
                        <tr>
                          <th scope="col">Player</th>
                          <th scope="col">Pos</th>
                          <th scope="col">Rank</th>
                          <th scope="col">Tier</th>
                          <th scope="col">ADP</th>
                          <th scope="col">AAV</th>
                          <th scope="col">Target $</th>
                          <th scope="col">Notes</th>
                          <th scope="col">Flags</th>
                          <th scope="col">Order</th>
                          <th scope="col">
                            <span className="sr-only">Remove</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleEntries.map((entry, index) => (
                          <RankingRow
                            key={entry.playerId}
                            entry={entry}
                            index={index}
                            disabled={controlsBusy || !selected.capabilities.canEdit}
                            isLast={index === visibleEntries.length - 1}
                            onUpdate={updateEntry}
                            onMove={moveEntry}
                            onRemove={removeEntry}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </section>

              <div className="ranking-tools-grid">
                <section className="panel ranking-import">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Safe import</p>
                      <h2>Preview CSV before commit</h2>
                      <p>Nothing is persisted until you accept the resolved rows.</p>
                    </div>
                    <FileSpreadsheet size={20} />
                  </div>
                  <div className="ranking-import-body">
                    <label>
                      <span>Source filename</span>
                      <input
                        value={csvFileName}
                        maxLength={240}
                        disabled={controlsBusy || !selected.capabilities.canEdit}
                        onChange={(event) => {
                          setCsvFileName(event.target.value);
                          markCsvChanged();
                        }}
                      />
                    </label>
                    <label>
                      <span>CSV content</span>
                      <textarea
                        value={csvSource}
                        spellCheck={false}
                        disabled={controlsBusy || !selected.capabilities.canEdit}
                        placeholder={
                          "name,position,rank,tier,adp,aav,target_price,notes\nChristian McCaffrey,RB,1,1,1.4,62,58,Elite dual-threat"
                        }
                        onChange={(event) => {
                          setCsvSource(event.target.value);
                          markCsvChanged();
                        }}
                      />
                    </label>
                    <p className="ranking-column-note">
                      Map either player name or player ID. Leave fields blank when your file does
                      not include them.
                    </p>
                    <details className="ranking-mapping">
                      <summary>Column mapping</summary>
                      <div>
                        {(Object.keys(csvColumnLabels) as CsvColumnField[]).map((field) => (
                          <label key={field}>
                            <span>{csvColumnLabels[field]}</span>
                            <input
                              value={csvColumns[field]}
                              placeholder="Not mapped"
                              disabled={controlsBusy || !selected.capabilities.canEdit}
                              onChange={(event) => {
                                setCsvColumns((current) => ({
                                  ...current,
                                  [field]: event.target.value,
                                }));
                                markCsvChanged();
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                    {csvPreview ? (
                      <div className="ranking-preview">
                        <div>
                          <strong>{csvPreview.summary.ready}</strong>
                          <span>ready</span>
                        </div>
                        <div>
                          <strong>{csvPreview.summary.unresolved}</strong>
                          <span>unresolved</span>
                        </div>
                        <div>
                          <strong>
                            {csvPreview.summary.invalid + csvPreview.summary.duplicate}
                          </strong>
                          <span>needs work</span>
                        </div>
                        <p>
                          {csvPreview.canCommitAll
                            ? "Every row is ready."
                            : "Only ready rows will be committed; fix unresolved names and preview again to include them."}
                        </p>
                        {[
                          ...csvPreview.diagnostics,
                          ...csvPreview.rows.flatMap((row) => row.diagnostics),
                        ]
                          .slice(0, 4)
                          .map((diagnostic, index) => (
                            <small key={`${diagnostic.message}-${index}`}>
                              <TriangleAlert size={12} /> {diagnostic.message}
                            </small>
                          ))}
                      </div>
                    ) : null}
                    {csvMessage ? (
                      <p
                        className={`ranking-inline-message${csvState === "error" ? " ranking-inline-message--error" : ""}`}
                        role={csvState === "error" ? "alert" : "status"}
                        aria-live="polite"
                      >
                        {csvMessage}
                      </p>
                    ) : null}
                    <div className="ranking-import-actions">
                      <button
                        className="button button--outline"
                        type="button"
                        disabled={
                          !selected.capabilities.canEdit || !csvSource.trim() || controlsBusy
                        }
                        onClick={() => void previewCsv()}
                      >
                        {csvState === "working" ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <CloudUpload size={15} />
                        )}{" "}
                        Preview resolution
                      </button>
                      <button
                        className="button button--lime"
                        type="button"
                        disabled={
                          !csvPreview ||
                          !selected.capabilities.canEdit ||
                          csvPreview.summary.ready === 0 ||
                          entriesDirty ||
                          controlsBusy
                        }
                        onClick={() => void commitCsv()}
                      >
                        <Check size={15} /> Commit {csvPreview?.summary.ready ?? 0} rows
                      </button>
                    </div>
                  </div>
                </section>

                <section className="panel ranking-portability">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Portable by design</p>
                      <h2>Export or share</h2>
                      <p>JSON keeps complete versions and source details; CSV travels anywhere.</p>
                    </div>
                    <Download size={20} />
                  </div>
                  <div className="ranking-portability-body">
                    <button
                      className="ranking-tool-button"
                      type="button"
                      disabled={!visibleVersion || entriesDirty || controlsBusy}
                      onClick={() => void exportBoard("json")}
                    >
                      <FileJson size={19} />
                      <span>
                        <strong>Export JSON</strong>
                        <small>Complete backup with source details</small>
                      </span>
                      <Download size={14} />
                    </button>
                    <button
                      className="ranking-tool-button"
                      type="button"
                      disabled={!visibleVersion || entriesDirty || controlsBusy}
                      onClick={() => void exportBoard("csv")}
                    >
                      <FileSpreadsheet size={19} />
                      <span>
                        <strong>Export CSV</strong>
                        <small>Spreadsheet-friendly player rows</small>
                      </span>
                      <Download size={14} />
                    </button>
                    <button
                      className="ranking-tool-button"
                      type="button"
                      disabled={
                        !selected.capabilities.canEdit ||
                        !visibleVersion ||
                        entriesDirty ||
                        controlsBusy
                      }
                      onClick={() => void createShare()}
                    >
                      <Link2 size={19} />
                      <span>
                        <strong>Create private link</strong>
                        <small>100 uses · revocable · copy enabled</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                    {share ? (
                      <div className="ranking-share-receipt">
                        <div>
                          <ShieldCheck size={16} />
                          <span>
                            <strong>Fragment-protected share</strong>
                            <small>The access key is never sent in a URL path or query.</small>
                          </span>
                        </div>
                        <input
                          readOnly
                          aria-label="Private ranking share URL"
                          value={share.shareUrl}
                          onFocus={(event) => event.target.select()}
                        />
                        <div>
                          <button
                            className="button button--dark button--small"
                            type="button"
                            disabled={mutationInFlight}
                            onClick={() => void copyShare()}
                          >
                            <Clipboard size={14} /> {copied ? "Copied" : "Copy link"}
                          </button>
                          <button
                            className="button button--outline button--small"
                            type="button"
                            disabled={mutationInFlight}
                            onClick={() => void revokeShare()}
                          >
                            <Trash2 size={14} />
                            {shareRevokeArmed ? "Yes, revoke link" : "Revoke link"}
                          </button>
                          {shareRevokeArmed ? (
                            <button
                              className="button button--soft button--small"
                              type="button"
                              disabled={mutationInFlight}
                              onClick={() => {
                                setShareRevokeArmed(false);
                                setMessage(null);
                              }}
                            >
                              Keep link
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
