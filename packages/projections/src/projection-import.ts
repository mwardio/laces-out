const UTF8_ENCODER = new TextEncoder();

export const PROJECTION_IMPORT_HARD_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 32,
  maxFieldBytes: 16 * 1024,
});

export const PROJECTION_IMPORT_DEFAULT_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxRows: 5_000,
  maxColumns: 16,
  maxFieldBytes: 2 * 1024,
});

export const PROJECTION_POINT_BOUNDS = Object.freeze({ minimum: -100, maximum: 300 });

export type ProjectionImportHorizon = "week" | "rest-of-season";

export interface ProjectionImportMetadataInput {
  readonly season: number;
  readonly week: number;
  readonly horizon: ProjectionImportHorizon;
  readonly sourceLabel: string;
  /** When the source itself last observed or published these projections. */
  readonly sourceObservedAt: string;
}

export interface ProjectionImportMetadata {
  readonly season: number;
  readonly week: number;
  readonly horizon: ProjectionImportHorizon;
  readonly sourceLabel: string;
  /** Canonical UTC ISO timestamp for the source data, not the later import time. */
  readonly sourceObservedAt: string;
}

export interface ProjectionCsvLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxFieldBytes: number;
}

export type ProjectionCsvColumn =
  "player_id" | "player_name" | "mean_points" | "floor_points" | "ceiling_points" | "confidence";

export interface ProjectionCsvHeader {
  readonly index: number;
  readonly source: string;
  readonly canonical: ProjectionCsvColumn | null;
}

export interface ParsedProjectionCsvRow {
  /** One-based physical line on which the CSV record starts. */
  readonly rowNumber: number;
  readonly fieldCount: number;
  /** Source fields are retained for deterministic input fingerprinting. */
  readonly sourceFields: readonly string[];
  readonly values: Readonly<Partial<Record<ProjectionCsvColumn, string>>>;
}

export interface ParsedProjectionCsv {
  readonly byteCount: number;
  readonly headerRowNumber: number;
  readonly headers: readonly ProjectionCsvHeader[];
  readonly rows: readonly ParsedProjectionCsvRow[];
}

export type ProjectionCsvErrorCode =
  | "byte_limit_exceeded"
  | "row_limit_exceeded"
  | "column_limit_exceeded"
  | "field_limit_exceeded"
  | "invalid_csv"
  | "missing_header"
  | "missing_required_column"
  | "duplicate_column";

export class ProjectionCsvError extends Error {
  readonly code: ProjectionCsvErrorCode;
  readonly rowNumber: number | null;
  readonly columnNumber: number | null;

  constructor(
    code: ProjectionCsvErrorCode,
    message: string,
    location: { readonly rowNumber?: number; readonly columnNumber?: number } = {},
  ) {
    super(message);
    this.name = "ProjectionCsvError";
    this.code = code;
    this.rowNumber = location.rowNumber ?? null;
    this.columnNumber = location.columnNumber ?? null;
  }
}

export type ProjectionImportMetadataErrorCode =
  | "invalid_season"
  | "invalid_week"
  | "invalid_horizon"
  | "invalid_source_label"
  | "invalid_source_observed_at";

export class ProjectionImportMetadataError extends Error {
  readonly code: ProjectionImportMetadataErrorCode;

  constructor(code: ProjectionImportMetadataErrorCode, message: string) {
    super(message);
    this.name = "ProjectionImportMetadataError";
    this.code = code;
  }
}

export interface ProjectionPlayerReference {
  readonly rowNumber: number;
  readonly playerId?: string;
  readonly playerName?: string;
}

export interface ProjectionPlayerCandidate {
  readonly playerId: string;
  readonly playerName?: string;
}

export type ProjectionPlayerResolution =
  | {
      readonly status: "resolved";
      /** The application's canonical player ID, not necessarily the supplied external ID. */
      readonly playerId: string;
      readonly playerName?: string;
    }
  | { readonly status: "unresolved" }
  | {
      readonly status: "ambiguous";
      readonly candidates?: readonly ProjectionPlayerCandidate[];
    };

export interface ProjectionPlayerResolutionContext {
  readonly metadata: ProjectionImportMetadata;
}

export type ProjectionPlayerResolver = (
  reference: ProjectionPlayerReference,
  context: ProjectionPlayerResolutionContext,
) => ProjectionPlayerResolution | Promise<ProjectionPlayerResolution>;

export type ProjectionImportDiagnosticCode =
  | "unknown_column"
  | "column_count_mismatch"
  | "missing_player_reference"
  | "invalid_player_reference"
  | "duplicate_player_reference"
  | "missing_mean_points"
  | "invalid_number"
  | "points_out_of_bounds"
  | "confidence_out_of_bounds"
  | "incoherent_range"
  | "player_unresolved"
  | "player_ambiguous"
  | "player_resolver_failed"
  | "invalid_player_resolution"
  | "duplicate_resolved_player";

export interface ProjectionImportDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: ProjectionImportDiagnosticCode;
  readonly rowNumber: number;
  readonly column: ProjectionCsvColumn | null;
  readonly message: string;
  readonly candidates?: readonly ProjectionPlayerCandidate[];
}

export interface NormalizedPlayerProjectionImport {
  readonly rowNumber: number;
  readonly playerId: string;
  readonly playerName?: string;
  readonly meanPoints: number;
  readonly floorPoints?: number;
  readonly ceilingPoints?: number;
  readonly confidence?: number;
}

/**
 * JSON-safe data that can be committed to a projection set and its player rows
 * in one transaction. `checksum` is derived from this normalized payload.
 */
export interface NormalizedProjectionImport {
  readonly metadata: ProjectionImportMetadata;
  readonly sourceChecksum: string;
  readonly checksum: string;
  readonly playerProjections: readonly NormalizedPlayerProjectionImport[];
}

export interface ProjectionImportPreview {
  readonly metadata: ProjectionImportMetadata;
  readonly sourceChecksum: string;
  readonly rowCount: number;
  readonly resolvedRowCount: number;
  readonly diagnostics: readonly ProjectionImportDiagnostic[];
  readonly canCommit: boolean;
  /** Present only when all rows are valid and uniquely resolved. */
  readonly normalized: NormalizedProjectionImport | null;
}

export interface PreviewProjectionImportInput {
  readonly csv: string;
  readonly metadata: ProjectionImportMetadataInput;
  readonly resolvePlayer: ProjectionPlayerResolver;
  readonly limits?: Partial<ProjectionCsvLimits>;
}

interface CsvRecord {
  readonly rowNumber: number;
  readonly fields: readonly string[];
}

const COLUMN_ALIASES: Readonly<Record<ProjectionCsvColumn, readonly string[]>> = Object.freeze({
  player_id: ["player_id", "playerid", "player id", "id"],
  player_name: ["player_name", "playername", "player name", "player", "name"],
  mean_points: [
    "mean_points",
    "meanpoints",
    "mean points",
    "mean",
    "projected_points",
    "projected points",
    "projection",
    "points",
    "fantasy_points",
    "fantasy points",
    "fpts",
  ],
  floor_points: [
    "floor_points",
    "floorpoints",
    "floor points",
    "projected_floor",
    "projected floor",
    "floor",
  ],
  ceiling_points: [
    "ceiling_points",
    "ceilingpoints",
    "ceiling points",
    "projected_ceiling",
    "projected ceiling",
    "ceiling",
    "ceil",
  ],
  confidence: ["confidence", "confidence_score", "confidence score"],
});

const ALIAS_TO_COLUMN = new Map<string, ProjectionCsvColumn>(
  Object.entries(COLUMN_ALIASES).flatMap(([column, aliases]) =>
    aliases.map((alias) => [normalizeHeader(alias), column as ProjectionCsvColumn] as const),
  ),
);

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const LETTER_OR_NUMBER_PATTERN = /[\p{L}\p{N}]/u;
const SOURCE_OBSERVED_AT_PATTERN =
  /^(20\d{2}|2100)-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
}

/**
 * Strictly parses the supported UTC ISO form and returns one canonical value.
 * Native `Date` parsing is deliberately not used as the validator because it
 * normalizes impossible dates on some runtimes.
 */
export function normalizeProjectionSourceObservedAt(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProjectionImportMetadataError(
      "invalid_source_observed_at",
      "Projection source as-of time must be a valid UTC ISO timestamp",
    );
  }
  const match = SOURCE_OBSERVED_AT_PATTERN.exec(value);
  if (!match) {
    throw new ProjectionImportMetadataError(
      "invalid_source_observed_at",
      "Projection source as-of time must be a valid UTC ISO timestamp",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  ) {
    throw new ProjectionImportMetadataError(
      "invalid_source_observed_at",
      "Projection source as-of time must be a valid UTC ISO timestamp",
    );
  }
  return parsed.toISOString();
}

function normalizeLimits(overrides: Partial<ProjectionCsvLimits> | undefined): ProjectionCsvLimits {
  const merged = { ...PROJECTION_IMPORT_DEFAULT_LIMITS, ...overrides };
  const keys = ["maxBytes", "maxRows", "maxColumns", "maxFieldBytes"] as const;

  for (const key of keys) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > PROJECTION_IMPORT_HARD_LIMITS[key]) {
      throw new RangeError(
        `${key} must be a positive integer no greater than ${PROJECTION_IMPORT_HARD_LIMITS[key]}`,
      );
    }
  }

  return Object.freeze(merged);
}

export function validateProjectionImportMetadata(
  input: ProjectionImportMetadataInput,
): ProjectionImportMetadata {
  if (!Number.isSafeInteger(input.season) || input.season < 2000 || input.season > 2100) {
    throw new ProjectionImportMetadataError(
      "invalid_season",
      "Projection season must be an integer between 2000 and 2100",
    );
  }
  if (!Number.isSafeInteger(input.week) || input.week < 1 || input.week > 18) {
    throw new ProjectionImportMetadataError(
      "invalid_week",
      "Projection week must be an integer between 1 and 18",
    );
  }
  if (input.horizon !== "week" && input.horizon !== "rest-of-season") {
    throw new ProjectionImportMetadataError(
      "invalid_horizon",
      "Projection horizon must be week or rest-of-season",
    );
  }

  if (typeof input.sourceLabel !== "string") {
    throw new ProjectionImportMetadataError(
      "invalid_source_label",
      "Projection source label must be 2-80 plain-text characters",
    );
  }
  const normalizedSourceLabel = input.sourceLabel.normalize("NFKC");
  const sourceLabel = normalizedSourceLabel.trim().replace(/ +/gu, " ");
  if (
    sourceLabel.length < 2 ||
    sourceLabel.length > 80 ||
    containsControlCharacter(normalizedSourceLabel) ||
    !LETTER_OR_NUMBER_PATTERN.test(sourceLabel)
  ) {
    throw new ProjectionImportMetadataError(
      "invalid_source_label",
      "Projection source label must be 2-80 plain-text characters",
    );
  }
  const sourceObservedAt = normalizeProjectionSourceObservedAt(input.sourceObservedAt);

  return Object.freeze({
    season: input.season,
    week: input.week,
    horizon: input.horizon,
    sourceLabel,
    sourceObservedAt,
  });
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function appendedUtf8ByteLength(value: string, priorValue: string): number {
  const codeUnit = value.charCodeAt(0);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) return 4;
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
    const priorCodeUnit = priorValue.charCodeAt(priorValue.length - 1);
    return priorCodeUnit >= 0xd800 && priorCodeUnit <= 0xdbff ? 0 : 3;
  }
  if (codeUnit <= 0x7f) return 1;
  if (codeUnit <= 0x7ff) return 2;
  return 3;
}

function parseCsvRecords(csv: string, limits: ProjectionCsvLimits): readonly CsvRecord[] {
  const byteCount = utf8ByteLength(csv);
  if (byteCount > limits.maxBytes) {
    throw new ProjectionCsvError(
      "byte_limit_exceeded",
      `CSV exceeds the ${limits.maxBytes}-byte limit`,
    );
  }

  const records: CsvRecord[] = [];
  let record: string[] = [];
  let field = "";
  let fieldBytes = 0;
  let state: "unquoted" | "quoted" | "after-quote" = "unquoted";
  let line = 1;
  let recordStartLine = 1;
  let endedWithRecordBreak = false;

  const append = (value: string): void => {
    for (const character of value) {
      fieldBytes += appendedUtf8ByteLength(character, field);
      field += character;
    }
    if (fieldBytes > limits.maxFieldBytes) {
      throw new ProjectionCsvError(
        "field_limit_exceeded",
        `CSV field exceeds the ${limits.maxFieldBytes}-byte limit`,
        { rowNumber: recordStartLine, columnNumber: record.length + 1 },
      );
    }
  };

  const finishField = (): void => {
    record.push(field);
    if (record.length > limits.maxColumns) {
      throw new ProjectionCsvError(
        "column_limit_exceeded",
        `CSV record exceeds the ${limits.maxColumns}-column limit`,
        { rowNumber: recordStartLine, columnNumber: record.length },
      );
    }
    field = "";
    fieldBytes = 0;
    state = "unquoted";
  };

  const finishRecord = (): void => {
    finishField();
    records.push({ rowNumber: recordStartLine, fields: record });
    if (records.length > limits.maxRows + 1) {
      throw new ProjectionCsvError(
        "row_limit_exceeded",
        `CSV exceeds the ${limits.maxRows}-data-row limit`,
        { rowNumber: recordStartLine },
      );
    }
    record = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const next = csv[index + 1];
    endedWithRecordBreak = false;

    if (state === "quoted") {
      if (character === '"') {
        if (next === '"') {
          append('"');
          index += 1;
        } else {
          state = "after-quote";
        }
      } else if (character === "\r") {
        append("\n");
        if (next === "\n") index += 1;
        line += 1;
      } else if (character === "\n") {
        append("\n");
        line += 1;
      } else {
        append(character ?? "");
      }
      continue;
    }

    if (state === "after-quote") {
      if (character === ",") {
        finishField();
      } else if (character === "\r" || character === "\n") {
        finishRecord();
        if (character === "\r" && next === "\n") index += 1;
        line += 1;
        recordStartLine = line;
        endedWithRecordBreak = true;
      } else if (character !== " " && character !== "\t") {
        throw new ProjectionCsvError(
          "invalid_csv",
          "Only a delimiter or record break may follow a closing quote",
          { rowNumber: line, columnNumber: record.length + 1 },
        );
      }
      continue;
    }

    if (character === ",") {
      finishField();
    } else if (character === '"') {
      if (field.length > 0) {
        throw new ProjectionCsvError("invalid_csv", "A quoted field must begin with a quote", {
          rowNumber: line,
          columnNumber: record.length + 1,
        });
      }
      state = "quoted";
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && next === "\n") index += 1;
      line += 1;
      recordStartLine = line;
      endedWithRecordBreak = true;
    } else {
      append(character ?? "");
    }
  }

  if (state === "quoted") {
    throw new ProjectionCsvError("invalid_csv", "CSV ends inside a quoted field", {
      rowNumber: recordStartLine,
      columnNumber: record.length + 1,
    });
  }
  if (!endedWithRecordBreak && (field.length > 0 || record.length > 0 || csv.length > 0)) {
    finishRecord();
  }

  return records;
}

function isBlankRecord(record: CsvRecord): boolean {
  return record.fields.every((field) => field.trim().length === 0);
}

export function parseProjectionCsv(
  csv: string,
  options: { readonly limits?: Partial<ProjectionCsvLimits> } = {},
): ParsedProjectionCsv {
  const limits = normalizeLimits(options.limits);
  const byteCount = utf8ByteLength(csv);
  const records = parseCsvRecords(csv, limits);
  const headerIndex = records.findIndex((record) => !isBlankRecord(record));
  const headerRecord = headerIndex >= 0 ? records[headerIndex] : undefined;

  if (!headerRecord) {
    throw new ProjectionCsvError("missing_header", "CSV must include a header row");
  }

  const seenColumns = new Set<ProjectionCsvColumn>();
  const headers: ProjectionCsvHeader[] = headerRecord.fields.map((source, index) => {
    const canonical = ALIAS_TO_COLUMN.get(normalizeHeader(source)) ?? null;
    if (canonical && seenColumns.has(canonical)) {
      throw new ProjectionCsvError(
        "duplicate_column",
        `More than one header maps to ${canonical}`,
        { rowNumber: headerRecord.rowNumber, columnNumber: index + 1 },
      );
    }
    if (canonical) seenColumns.add(canonical);
    return Object.freeze({ index, source: source.trim(), canonical });
  });

  if (!seenColumns.has("mean_points")) {
    throw new ProjectionCsvError(
      "missing_required_column",
      "CSV must include a mean_points column",
      { rowNumber: headerRecord.rowNumber },
    );
  }
  if (!seenColumns.has("player_id") && !seenColumns.has("player_name")) {
    throw new ProjectionCsvError(
      "missing_required_column",
      "CSV must include player_id or player_name",
      { rowNumber: headerRecord.rowNumber },
    );
  }

  const dataRecords = records.slice(headerIndex + 1).filter((record) => !isBlankRecord(record));
  if (dataRecords.length > limits.maxRows) {
    const overflowRecord = dataRecords[limits.maxRows];
    throw new ProjectionCsvError(
      "row_limit_exceeded",
      `CSV exceeds the ${limits.maxRows}-data-row limit`,
      { ...(overflowRecord ? { rowNumber: overflowRecord.rowNumber } : {}) },
    );
  }

  const rows = dataRecords.map((record): ParsedProjectionCsvRow => {
    const values: Partial<Record<ProjectionCsvColumn, string>> = {};
    for (const header of headers) {
      if (header.canonical) values[header.canonical] = record.fields[header.index] ?? "";
    }
    return Object.freeze({
      rowNumber: record.rowNumber,
      fieldCount: record.fields.length,
      sourceFields: Object.freeze([...record.fields]),
      values: Object.freeze(values),
    });
  });

  return Object.freeze({
    byteCount,
    headerRowNumber: headerRecord.rowNumber,
    headers: Object.freeze(headers),
    rows: Object.freeze(rows),
  });
}

function normalizeReferenceValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compatibilityNormalized = value.normalize("NFKC");
  if (containsControlCharacter(compatibilityNormalized)) return compatibilityNormalized;
  const normalized = compatibilityNormalized.trim().replace(/ +/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function isValidReferenceValue(value: string): boolean {
  return value.length <= 160 && !containsControlCharacter(value);
}

function parseNumber(
  raw: string | undefined,
  column: "mean_points" | "floor_points" | "ceiling_points" | "confidence",
  rowNumber: number,
  diagnostics: ProjectionImportDiagnostic[],
): number | undefined {
  const value = raw?.trim();
  if (!value) {
    if (column === "mean_points") {
      diagnostics.push({
        severity: "error",
        code: "missing_mean_points",
        rowNumber,
        column,
        message: "Mean points are required",
      });
    }
    return undefined;
  }
  if (!DECIMAL_PATTERN.test(value)) {
    diagnostics.push({
      severity: "error",
      code: "invalid_number",
      rowNumber,
      column,
      message: `${column} must be a finite decimal number`,
    });
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    diagnostics.push({
      severity: "error",
      code: "invalid_number",
      rowNumber,
      column,
      message: `${column} must be a finite decimal number`,
    });
    return undefined;
  }
  if (column === "confidence") {
    if (parsed < 0 || parsed > 1) {
      diagnostics.push({
        severity: "error",
        code: "confidence_out_of_bounds",
        rowNumber,
        column,
        message: "Confidence must be between 0 and 1",
      });
      return undefined;
    }
  } else if (parsed < PROJECTION_POINT_BOUNDS.minimum || parsed > PROJECTION_POINT_BOUNDS.maximum) {
    diagnostics.push({
      severity: "error",
      code: "points_out_of_bounds",
      rowNumber,
      column,
      message: `${column} must be between ${PROJECTION_POINT_BOUNDS.minimum} and ${PROJECTION_POINT_BOUNDS.maximum}`,
    });
    return undefined;
  }

  return Object.is(parsed, -0) ? 0 : parsed;
}

function addRangeDiagnostics(
  rowNumber: number,
  mean: number | undefined,
  floor: number | undefined,
  ceiling: number | undefined,
  diagnostics: ProjectionImportDiagnostic[],
): void {
  if (mean === undefined) return;
  if (floor !== undefined && floor > mean) {
    diagnostics.push({
      severity: "error",
      code: "incoherent_range",
      rowNumber,
      column: "floor_points",
      message: "Floor points cannot exceed mean points",
    });
  }
  if (ceiling !== undefined && mean > ceiling) {
    diagnostics.push({
      severity: "error",
      code: "incoherent_range",
      rowNumber,
      column: "ceiling_points",
      message: "Ceiling points cannot be less than mean points",
    });
  }
}

function referenceKeys(reference: ProjectionPlayerReference): readonly string[] {
  return [
    ...(reference.playerId ? [`id:${reference.playerId.toLowerCase()}`] : []),
    ...(reference.playerName ? [`name:${reference.playerName.toLowerCase()}`] : []),
  ];
}

function sortCandidates(candidates: unknown): readonly ProjectionPlayerCandidate[] | undefined {
  if (!Array.isArray(candidates)) return undefined;
  const candidateValues = candidates as readonly unknown[];
  return Object.freeze(
    candidateValues
      .flatMap((candidate): readonly ProjectionPlayerCandidate[] => {
        if (typeof candidate !== "object" || candidate === null) return [];
        const record = candidate as Readonly<Record<string, unknown>>;
        const playerId = normalizeReferenceValue(record.playerId);
        const playerName = normalizeReferenceValue(record.playerName);
        if (
          !playerId ||
          !isValidReferenceValue(playerId) ||
          (playerName !== undefined && !isValidReferenceValue(playerName))
        ) {
          return [];
        }
        return [{ playerId, ...(playerName ? { playerName } : {}) }];
      })
      .sort((left, right) =>
        left.playerId === right.playerId
          ? (left.playerName ?? "").localeCompare(right.playerName ?? "", "en")
          : left.playerId.localeCompare(right.playerId, "en"),
      )
      .slice(0, 20),
  );
}

const DIAGNOSTIC_COLUMN_ORDER: Readonly<Record<ProjectionCsvColumn, number>> = Object.freeze({
  player_id: 0,
  player_name: 1,
  mean_points: 2,
  floor_points: 3,
  ceiling_points: 4,
  confidence: 5,
});

function sortedDiagnostics(
  diagnostics: readonly ProjectionImportDiagnostic[],
): readonly ProjectionImportDiagnostic[] {
  return Object.freeze(
    [...diagnostics].sort(
      (left, right) =>
        left.rowNumber - right.rowNumber ||
        (left.column === null ? -1 : DIAGNOSTIC_COLUMN_ORDER[left.column]) -
          (right.column === null ? -1 : DIAGNOSTIC_COLUMN_ORDER[right.column]) ||
        left.code.localeCompare(right.code, "en") ||
        left.message.localeCompare(right.message, "en"),
    ),
  );
}

function stableSourcePayload(
  parsed: ParsedProjectionCsv,
  metadata: ProjectionImportMetadata,
): Record<string, unknown> {
  const canonicalHeaders = parsed.headers.map((header) => ({
    canonical: header.canonical,
    source: normalizeHeader(header.source),
  }));
  const rows = parsed.rows.map((row) => row.sourceFields.map((value) => value.trim()));
  return { schemaVersion: 1, metadata, headers: canonicalHeaders, rows };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function commitPayload(
  metadata: ProjectionImportMetadata,
  sourceChecksum: string,
  rows: readonly NormalizedPlayerProjectionImport[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    metadata,
    sourceChecksum,
    playerProjections: rows.map((row) => ({
      playerId: row.playerId,
      meanPoints: row.meanPoints,
      floorPoints: row.floorPoints ?? null,
      ceilingPoints: row.ceilingPoints ?? null,
      confidence: row.confidence ?? null,
    })),
  };
}

/**
 * Parses, validates, and resolves a user-supplied projection CSV. The returned
 * `normalized` value is deliberately all-or-nothing: callers must never commit
 * partial rows from a preview whose `canCommit` value is false.
 */
export async function previewProjectionImport(
  input: PreviewProjectionImportInput,
): Promise<ProjectionImportPreview> {
  const metadata = validateProjectionImportMetadata(input.metadata);
  const parsed = parseProjectionCsv(input.csv, {
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  });
  const sourceChecksum = await sha256(JSON.stringify(stableSourcePayload(parsed, metadata)));
  const diagnostics: ProjectionImportDiagnostic[] = parsed.headers.flatMap((header) =>
    header.canonical === null
      ? [
          {
            severity: "warning" as const,
            code: "unknown_column" as const,
            rowNumber: parsed.headerRowNumber,
            column: null,
            message: `Column ${header.source || header.index + 1} is ignored`,
          },
        ]
      : [],
  );
  const normalizedRows: NormalizedPlayerProjectionImport[] = [];
  const rawReferences = new Map<string, number>();
  const resolvedPlayers = new Map<string, number>();

  for (const row of parsed.rows) {
    const diagnosticsBeforeRow = diagnostics.length;
    if (row.fieldCount !== parsed.headers.length) {
      diagnostics.push({
        severity: "error",
        code: "column_count_mismatch",
        rowNumber: row.rowNumber,
        column: null,
        message: `Row has ${row.fieldCount} fields; expected ${parsed.headers.length}`,
      });
    }

    const playerId = normalizeReferenceValue(row.values.player_id);
    const playerName = normalizeReferenceValue(row.values.player_name);
    const reference: ProjectionPlayerReference = Object.freeze({
      rowNumber: row.rowNumber,
      ...(playerId ? { playerId } : {}),
      ...(playerName ? { playerName } : {}),
    });

    if (!playerId && !playerName) {
      diagnostics.push({
        severity: "error",
        code: "missing_player_reference",
        rowNumber: row.rowNumber,
        column: null,
        message: "A player ID or player name is required",
      });
    } else if (
      (playerId !== undefined && !isValidReferenceValue(playerId)) ||
      (playerName !== undefined && !isValidReferenceValue(playerName))
    ) {
      diagnostics.push({
        severity: "error",
        code: "invalid_player_reference",
        rowNumber: row.rowNumber,
        column: null,
        message: "Player references must be 1-160 printable characters",
      });
    } else {
      for (const key of referenceKeys(reference)) {
        const previousRow = rawReferences.get(key);
        if (previousRow !== undefined) {
          diagnostics.push({
            severity: "error",
            code: "duplicate_player_reference",
            rowNumber: row.rowNumber,
            column: key.startsWith("id:") ? "player_id" : "player_name",
            message: `Player reference duplicates row ${previousRow}`,
          });
        } else {
          rawReferences.set(key, row.rowNumber);
        }
      }
    }

    const meanPoints = parseNumber(
      row.values.mean_points,
      "mean_points",
      row.rowNumber,
      diagnostics,
    );
    const floorPoints = parseNumber(
      row.values.floor_points,
      "floor_points",
      row.rowNumber,
      diagnostics,
    );
    const ceilingPoints = parseNumber(
      row.values.ceiling_points,
      "ceiling_points",
      row.rowNumber,
      diagnostics,
    );
    const confidence = parseNumber(row.values.confidence, "confidence", row.rowNumber, diagnostics);
    addRangeDiagnostics(row.rowNumber, meanPoints, floorPoints, ceilingPoints, diagnostics);

    if (diagnostics.length !== diagnosticsBeforeRow) continue;

    let resolution: unknown;
    try {
      resolution = await input.resolvePlayer(reference, { metadata });
    } catch {
      diagnostics.push({
        severity: "error",
        code: "player_resolver_failed",
        rowNumber: row.rowNumber,
        column: null,
        message: "Player resolution failed",
      });
      continue;
    }

    if (
      typeof resolution !== "object" ||
      resolution === null ||
      !("status" in resolution) ||
      (resolution.status !== "resolved" &&
        resolution.status !== "unresolved" &&
        resolution.status !== "ambiguous")
    ) {
      diagnostics.push({
        severity: "error",
        code: "invalid_player_resolution",
        rowNumber: row.rowNumber,
        column: null,
        message: "Resolver returned an invalid result",
      });
      continue;
    }

    if (resolution.status === "unresolved") {
      diagnostics.push({
        severity: "error",
        code: "player_unresolved",
        rowNumber: row.rowNumber,
        column: null,
        message: "Player could not be resolved",
      });
      continue;
    }
    if (resolution.status === "ambiguous") {
      const candidates = sortCandidates(
        "candidates" in resolution ? resolution.candidates : undefined,
      );
      diagnostics.push({
        severity: "error",
        code: "player_ambiguous",
        rowNumber: row.rowNumber,
        column: null,
        message: "Player reference matches more than one player",
        ...(candidates && candidates.length > 0 ? { candidates } : {}),
      });
      continue;
    }

    const resolvedPlayerId = normalizeReferenceValue(
      "playerId" in resolution ? resolution.playerId : undefined,
    );
    const resolvedPlayerName = normalizeReferenceValue(
      "playerName" in resolution ? resolution.playerName : undefined,
    );
    if (
      !resolvedPlayerId ||
      !isValidReferenceValue(resolvedPlayerId) ||
      (resolvedPlayerName !== undefined && !isValidReferenceValue(resolvedPlayerName))
    ) {
      diagnostics.push({
        severity: "error",
        code: "invalid_player_resolution",
        rowNumber: row.rowNumber,
        column: null,
        message: "Resolver returned an invalid canonical player ID",
      });
      continue;
    }

    const resolvedKey = resolvedPlayerId.toLowerCase();
    const priorResolvedRow = resolvedPlayers.get(resolvedKey);
    if (priorResolvedRow !== undefined) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_resolved_player",
        rowNumber: row.rowNumber,
        column: null,
        message: `Resolved player duplicates row ${priorResolvedRow}`,
      });
      continue;
    }
    resolvedPlayers.set(resolvedKey, row.rowNumber);

    // All values are present here because a missing mean produces a diagnostic.
    normalizedRows.push(
      Object.freeze({
        rowNumber: row.rowNumber,
        playerId: resolvedPlayerId,
        ...(resolvedPlayerName ? { playerName: resolvedPlayerName } : {}),
        meanPoints: meanPoints as number,
        ...(floorPoints === undefined ? {} : { floorPoints }),
        ...(ceilingPoints === undefined ? {} : { ceilingPoints }),
        ...(confidence === undefined ? {} : { confidence }),
      }),
    );
  }

  if (parsed.rows.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "missing_mean_points",
      rowNumber: parsed.headerRowNumber + 1,
      column: "mean_points",
      message: "CSV must include at least one projection row",
    });
  }

  const orderedDiagnostics = sortedDiagnostics(diagnostics);
  const hasErrors = orderedDiagnostics.some((diagnostic) => diagnostic.severity === "error");
  let normalized: NormalizedProjectionImport | null = null;
  if (!hasErrors && normalizedRows.length === parsed.rows.length) {
    const checksum = await sha256(
      JSON.stringify(commitPayload(metadata, sourceChecksum, normalizedRows)),
    );
    normalized = Object.freeze({
      metadata,
      sourceChecksum,
      checksum,
      playerProjections: Object.freeze(normalizedRows),
    });
  }

  return Object.freeze({
    metadata,
    sourceChecksum,
    rowCount: parsed.rows.length,
    resolvedRowCount: normalizedRows.length,
    diagnostics: orderedDiagnostics,
    canCommit: normalized !== null,
    normalized,
  });
}
