import { z } from "zod";

import {
  RANKING_FIELD_NAMES,
  fieldAttributionSchema,
  positionSchema,
  rankingEntrySchema,
  sourcedValue,
  type FieldAttribution,
  type RankingEntry,
  type RankingEntryField,
  type RankingFieldName,
} from "./model.js";
import { canonicalJson, checksumSha256, checksumUtf8Sha256 } from "./integrity.js";

export const MAX_RANKING_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_RANKING_CSV_ROWS = 20_000;
export const MAX_RANKING_CSV_COLUMNS = 256;

export const CSV_IMPORT_FIELDS = [
  "playerId",
  "playerName",
  "position",
  ...RANKING_FIELD_NAMES,
] as const;
export type CsvImportField = (typeof CSV_IMPORT_FIELDS)[number];

const columnReferenceSchema = z.union([
  z.string().trim().min(1).max(160),
  z
    .number()
    .int()
    .min(0)
    .max(MAX_RANKING_CSV_COLUMNS - 1),
]);

const mappingShape = {
  playerId: columnReferenceSchema.optional(),
  playerName: columnReferenceSchema.optional(),
  position: columnReferenceSchema.optional(),
  overallRank: columnReferenceSchema.optional(),
  positionRank: columnReferenceSchema.optional(),
  tier: columnReferenceSchema.optional(),
  adp: columnReferenceSchema.optional(),
  aav: columnReferenceSchema.optional(),
  floorPrice: columnReferenceSchema.optional(),
  targetPrice: columnReferenceSchema.optional(),
  ceilingPrice: columnReferenceSchema.optional(),
  confidence: columnReferenceSchema.optional(),
  tags: columnReferenceSchema.optional(),
  notes: columnReferenceSchema.optional(),
  target: columnReferenceSchema.optional(),
  avoid: columnReferenceSchema.optional(),
} as const;

export const csvColumnMappingSchema = z
  .object(mappingShape)
  .strict()
  .superRefine((mapping, context) => {
    if (mapping.playerId === undefined && mapping.playerName === undefined) {
      context.addIssue({
        code: "custom",
        message: "playerId or playerName must be mapped",
      });
    }
    const references = Object.values(mapping).filter(
      (reference): reference is string | number => reference !== undefined,
    );
    const canonicalReferences = references.map((reference) =>
      typeof reference === "string"
        ? `name:${reference.toLocaleLowerCase()}`
        : `index:${reference}`,
    );
    if (new Set(canonicalReferences).size !== canonicalReferences.length) {
      context.addIssue({ code: "custom", message: "a CSV column cannot map to multiple fields" });
    }
  });
export type CsvColumnMapping = z.infer<typeof csvColumnMappingSchema>;

export const resolvedPlayerSchema = z
  .object({
    status: z.literal("resolved"),
    playerId: z.string().trim().min(1).max(160),
    position: positionSchema.nullable(),
  })
  .strict();
export const unresolvedPlayerSchema = z
  .object({
    status: z.literal("unresolved"),
    reason: z.string().trim().min(1).max(500),
    candidatePlayerIds: z.array(z.string().trim().min(1).max(160)).max(20).readonly(),
  })
  .strict();
export const playerResolutionSchema = z.discriminatedUnion("status", [
  resolvedPlayerSchema,
  unresolvedPlayerSchema,
]);
export type PlayerResolution = z.infer<typeof playerResolutionSchema>;

export interface CsvPlayerIdentity {
  readonly playerId: string | null;
  readonly playerName: string | null;
  readonly position: z.infer<typeof positionSchema> | null;
  readonly rowNumber: number;
}

export type CsvPlayerResolver = (identity: CsvPlayerIdentity) => PlayerResolution;

export interface CsvDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly rowNumber: number | null;
  readonly field: CsvImportField | null;
}

export type CsvPreviewRowStatus = "ready" | "invalid" | "unresolved" | "duplicate";

export interface CsvPreviewRow {
  readonly rowNumber: number;
  readonly cells: readonly string[];
  readonly status: CsvPreviewRowStatus;
  readonly playerId: string | null;
  readonly entry: RankingEntry | null;
  readonly diagnostics: readonly CsvDiagnostic[];
}

export interface CsvPreviewSummary {
  readonly total: number;
  readonly ready: number;
  readonly invalid: number;
  readonly unresolved: number;
  readonly duplicate: number;
}

export interface RankingCsvPreview {
  readonly sourceChecksumSha256: string;
  readonly previewChecksumSha256: string;
  readonly headers: readonly string[];
  readonly mapping: CsvColumnMapping;
  readonly rows: readonly CsvPreviewRow[];
  readonly diagnostics: readonly CsvDiagnostic[];
  readonly summary: CsvPreviewSummary;
  readonly canCommitAll: boolean;
}

export interface PreviewRankingCsvOptions {
  readonly mapping: CsvColumnMapping;
  readonly attribution: FieldAttribution;
  readonly hasHeader?: boolean;
  readonly delimiter?: string;
  readonly tagSeparator?: string;
  readonly caseSensitiveHeaders?: boolean;
  readonly resolvePlayer?: CsvPlayerResolver;
}

interface ParsedCsvRow {
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

interface ParsedCsv {
  readonly rows: readonly ParsedCsvRow[];
  readonly diagnostics: readonly CsvDiagnostic[];
}

function diagnostic(
  severity: CsvDiagnostic["severity"],
  code: string,
  message: string,
  rowNumber: number | null,
  field: CsvImportField | null = null,
): CsvDiagnostic {
  return Object.freeze({ severity, code, message, rowNumber, field });
}

function parseCsv(source: string, delimiter: string): ParsedCsv {
  const rows: ParsedCsvRow[] = [];
  const diagnostics: CsvDiagnostic[] = [];
  let cells: string[] = [];
  let cell = "";
  let rowNumber = 1;
  let line = 1;
  let inQuotes = false;
  let quoteClosed = false;
  let rowHasInput = false;

  const pushCell = () => {
    cells.push(cell);
    cell = "";
    quoteClosed = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(Object.freeze({ rowNumber, cells: Object.freeze(cells) }));
    cells = [];
    rowNumber = line + 1;
    rowHasInput = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) continue;
    const isCarriageReturn = character === "\r";
    const isLineFeed = character === "\n";
    const isNewline = isCarriageReturn || isLineFeed;
    const hasCrLf = isCarriageReturn && source[index + 1] === "\n";

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else if (isNewline) {
        cell += "\n";
        if (hasCrLf) index += 1;
        line += 1;
      } else {
        cell += character;
      }
      rowHasInput = true;
      continue;
    }

    if (quoteClosed) {
      if (character === delimiter) {
        pushCell();
        rowHasInput = true;
        continue;
      }
      if (isNewline) {
        if (hasCrLf) index += 1;
        pushRow();
        line += 1;
        continue;
      }
      if (character === " " || character === "\t") continue;
      diagnostics.push(
        diagnostic(
          "error",
          "characters-after-quote",
          "Only whitespace or a delimiter may follow a closing quote",
          rowNumber,
        ),
      );
      quoteClosed = false;
      cell += character;
      rowHasInput = true;
      continue;
    }

    if (character === '"') {
      if (cell.length === 0) {
        inQuotes = true;
      } else {
        diagnostics.push(
          diagnostic(
            "error",
            "unexpected-quote",
            "A quote may only begin an empty CSV cell",
            rowNumber,
          ),
        );
        cell += character;
      }
      rowHasInput = true;
    } else if (character === delimiter) {
      pushCell();
      rowHasInput = true;
    } else if (isNewline) {
      if (hasCrLf) index += 1;
      pushRow();
      line += 1;
    } else {
      cell += character;
      rowHasInput = true;
    }
  }

  if (inQuotes) {
    diagnostics.push(
      diagnostic("error", "unterminated-quote", "Quoted CSV cell is not terminated", rowNumber),
    );
  }
  if (rowHasInput || cells.length > 0 || cell.length > 0 || quoteClosed) pushRow();
  return Object.freeze({ rows: Object.freeze(rows), diagnostics: Object.freeze(diagnostics) });
}

function mappedReference(
  mapping: CsvColumnMapping,
  field: CsvImportField,
): string | number | undefined {
  return mapping[field];
}

function resolveColumnIndexes(
  mapping: CsvColumnMapping,
  headers: readonly string[],
  hasHeader: boolean,
  caseSensitive: boolean,
): {
  readonly indexes: ReadonlyMap<CsvImportField, number>;
  readonly diagnostics: readonly CsvDiagnostic[];
} {
  const diagnostics: CsvDiagnostic[] = [];
  const indexes = new Map<CsvImportField, number>();
  const comparableHeaders = headers.map((header) =>
    caseSensitive ? header.trim() : header.trim().toLocaleLowerCase(),
  );
  for (const field of CSV_IMPORT_FIELDS) {
    const reference = mappedReference(mapping, field);
    if (reference === undefined) continue;
    let index: number;
    if (typeof reference === "number") {
      index = reference;
    } else if (!hasHeader) {
      diagnostics.push(
        diagnostic(
          "error",
          "named-column-without-header",
          "Named column references require a header row",
          null,
          field,
        ),
      );
      continue;
    } else {
      const comparable = caseSensitive ? reference : reference.toLocaleLowerCase();
      index = comparableHeaders.indexOf(comparable);
      if (index === -1) {
        diagnostics.push(
          diagnostic(
            "error",
            "missing-column",
            `Mapped column '${reference}' was not found`,
            null,
            field,
          ),
        );
        continue;
      }
    }
    if (index >= headers.length) {
      diagnostics.push(
        diagnostic(
          "error",
          "column-out-of-range",
          "Mapped column is outside the CSV width",
          null,
          field,
        ),
      );
      continue;
    }
    indexes.set(field, index);
  }
  return Object.freeze({ indexes, diagnostics: Object.freeze(diagnostics) });
}

function cellFor(
  row: ParsedCsvRow,
  indexes: ReadonlyMap<CsvImportField, number>,
  field: CsvImportField,
): string | null {
  const index = indexes.get(field);
  return index === undefined ? null : (row.cells[index] ?? "");
}

function nullableText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parsePosition(value: string | null): z.infer<typeof positionSchema> | null | undefined {
  const text = nullableText(value);
  if (text === null) return null;
  const result = positionSchema.safeParse(text.toLocaleUpperCase());
  return result.success ? result.data : undefined;
}

function parseNumber(value: string, field: RankingFieldName): number | undefined {
  let normalized = value.trim();
  if (["aav", "floorPrice", "targetPrice", "ceilingPrice"].includes(field)) {
    normalized = normalized.replaceAll("$", "").replaceAll(",", "");
  }
  if (field === "confidence" && normalized.endsWith("%")) {
    const percentage = Number(normalized.slice(0, -1));
    return Number.isFinite(percentage) ? percentage / 100 : undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLocaleLowerCase()) {
    case "true":
    case "yes":
    case "y":
    case "1":
      return true;
    case "false":
    case "no":
    case "n":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function parseTags(value: string, separator: string): readonly string[] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const result = z.array(z.string()).safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed
    .split(separator)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseEditableValue(
  field: RankingFieldName,
  rawValue: string,
  tagSeparator: string,
): number | boolean | string | readonly string[] | undefined {
  switch (field) {
    case "tags":
      return parseTags(rawValue, tagSeparator);
    case "notes":
      return rawValue;
    case "target":
    case "avoid":
      return parseBoolean(rawValue);
    default:
      return parseNumber(rawValue, field);
  }
}

interface MutablePreviewRow {
  rowNumber: number;
  cells: readonly string[];
  status: CsvPreviewRowStatus;
  playerId: string | null;
  entry: RankingEntry | null;
  diagnostics: CsvDiagnostic[];
}

function resolveIdentity(
  identity: CsvPlayerIdentity,
  resolver: CsvPlayerResolver | undefined,
): { readonly resolution: PlayerResolution | null; readonly diagnostic: CsvDiagnostic | null } {
  if (!resolver) {
    if (identity.playerId !== null) {
      return {
        resolution: {
          status: "resolved",
          playerId: identity.playerId,
          position: identity.position,
        },
        diagnostic: null,
      };
    }
    return {
      resolution: {
        status: "unresolved",
        reason: "No player ID was supplied and no resolver was configured",
        candidatePlayerIds: [],
      },
      diagnostic: null,
    };
  }
  try {
    const result = playerResolutionSchema.safeParse(resolver(identity));
    if (!result.success) {
      return {
        resolution: null,
        diagnostic: diagnostic(
          "error",
          "invalid-resolver-result",
          "Player resolver returned an invalid result",
          identity.rowNumber,
          "playerId",
        ),
      };
    }
    return { resolution: result.data, diagnostic: null };
  } catch {
    return {
      resolution: null,
      diagnostic: diagnostic(
        "error",
        "resolver-failed",
        "Player resolver failed for this row",
        identity.rowNumber,
        "playerId",
      ),
    };
  }
}

function previewChecksumPayload(
  preview: Omit<RankingCsvPreview, "previewChecksumSha256">,
): unknown {
  return {
    sourceChecksumSha256: preview.sourceChecksumSha256,
    headers: preview.headers,
    mapping: preview.mapping,
    rows: preview.rows.map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      playerId: row.playerId,
      entry: row.entry,
      diagnostics: row.diagnostics,
    })),
    diagnostics: preview.diagnostics,
    summary: preview.summary,
    canCommitAll: preview.canCommitAll,
  };
}

function computePreviewChecksum(preview: Omit<RankingCsvPreview, "previewChecksumSha256">): string {
  return checksumSha256(previewChecksumPayload(preview));
}

/** Parse and validate only. No import is committed until an explicit checksum-bound decision follows. */
export function previewRankingCsv(
  source: string,
  options: PreviewRankingCsvOptions,
): RankingCsvPreview {
  if (typeof source !== "string") throw new TypeError("CSV source must be a string");
  const mapping = csvColumnMappingSchema.parse(options.mapping);
  const attribution = fieldAttributionSchema.parse(options.attribution);
  const delimiter = options.delimiter ?? ",";
  const tagSeparator = options.tagSeparator ?? "|";
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new TypeError("delimiter must be one non-quote, non-newline character");
  }
  if (tagSeparator.length === 0) throw new TypeError("tagSeparator cannot be empty");
  const sourceChecksumSha256 = checksumUtf8Sha256(source);
  const fileDiagnostics: CsvDiagnostic[] = [];
  if (new TextEncoder().encode(source).byteLength > MAX_RANKING_CSV_BYTES) {
    fileDiagnostics.push(
      diagnostic("error", "file-too-large", "CSV exceeds the import size limit", null),
    );
  }
  const parsed = parseCsv(source, delimiter);
  fileDiagnostics.push(...parsed.diagnostics);
  if (parsed.rows.length > MAX_RANKING_CSV_ROWS + 1) {
    fileDiagnostics.push(diagnostic("error", "too-many-rows", "CSV exceeds the row limit", null));
  }

  const hasHeader = options.hasHeader !== false;
  const headerRow = hasHeader ? parsed.rows[0] : undefined;
  const dataRows = hasHeader ? parsed.rows.slice(1) : parsed.rows;
  const width = hasHeader
    ? (headerRow?.cells.length ?? 0)
    : Math.max(0, ...dataRows.map((row) => row.cells.length));
  const headers = hasHeader
    ? [...(headerRow?.cells ?? [])]
    : Array.from({ length: width }, (_unused, index) => `column_${index + 1}`);
  if (headers[0]?.startsWith("\uFEFF")) headers[0] = headers[0].slice(1);
  if (headers.length === 0) {
    fileDiagnostics.push(diagnostic("error", "empty-csv", "CSV has no columns", null));
  }
  if (headers.length > MAX_RANKING_CSV_COLUMNS) {
    fileDiagnostics.push(
      diagnostic("error", "too-many-columns", "CSV exceeds the column limit", null),
    );
  }
  if (hasHeader) {
    const normalizedHeaders = headers.map((header) => header.trim().toLocaleLowerCase());
    const duplicated = normalizedHeaders.filter(
      (header, index) => header.length > 0 && normalizedHeaders.indexOf(header) !== index,
    );
    if (duplicated.length > 0) {
      fileDiagnostics.push(
        diagnostic(
          "error",
          "duplicate-header",
          "CSV header names must be unique",
          headerRow?.rowNumber ?? 1,
        ),
      );
    }
  }

  const resolvedColumns = resolveColumnIndexes(
    mapping,
    headers,
    hasHeader,
    options.caseSensitiveHeaders === true,
  );
  fileDiagnostics.push(...resolvedColumns.diagnostics);
  const syntaxErrorsByRow = new Map<number, CsvDiagnostic[]>();
  for (const issue of parsed.diagnostics) {
    if (issue.rowNumber === null) continue;
    const rowIssues = syntaxErrorsByRow.get(issue.rowNumber) ?? [];
    rowIssues.push(issue);
    syntaxErrorsByRow.set(issue.rowNumber, rowIssues);
  }

  const previewRows: MutablePreviewRow[] = dataRows.slice(0, MAX_RANKING_CSV_ROWS).map((row) => {
    const diagnostics = [...(syntaxErrorsByRow.get(row.rowNumber) ?? [])];
    if (row.cells.length !== headers.length) {
      diagnostics.push(
        diagnostic(
          "error",
          "inconsistent-column-count",
          `Expected ${headers.length} columns but found ${row.cells.length}`,
          row.rowNumber,
        ),
      );
    }
    if (row.cells.every((cell) => cell.trim().length === 0)) {
      diagnostics.push(diagnostic("error", "empty-row", "CSV row is empty", row.rowNumber));
    }

    const mappedPosition = parsePosition(cellFor(row, resolvedColumns.indexes, "position"));
    if (mappedPosition === undefined) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid-position",
          "Position is not recognized",
          row.rowNumber,
          "position",
        ),
      );
    }
    const identity: CsvPlayerIdentity = Object.freeze({
      playerId: nullableText(cellFor(row, resolvedColumns.indexes, "playerId")),
      playerName: nullableText(cellFor(row, resolvedColumns.indexes, "playerName")),
      position: mappedPosition ?? null,
      rowNumber: row.rowNumber,
    });
    const identityResult = resolveIdentity(identity, options.resolvePlayer);
    if (identityResult.diagnostic) diagnostics.push(identityResult.diagnostic);
    const resolution = identityResult.resolution;
    if (resolution?.status === "unresolved") {
      diagnostics.push(
        diagnostic("error", "unresolved-player", resolution.reason, row.rowNumber, "playerId"),
      );
    }

    const entryInput: Record<string, unknown> = {
      playerId: resolution?.status === "resolved" ? resolution.playerId : "unresolved",
      position:
        resolution?.status === "resolved" ? (resolution.position ?? mappedPosition ?? null) : null,
    };
    for (const field of RANKING_FIELD_NAMES) {
      const rawValue = cellFor(row, resolvedColumns.indexes, field);
      if (rawValue === null || rawValue.trim().length === 0) {
        entryInput[field] = null;
        continue;
      }
      const parsedValue = parseEditableValue(field, rawValue, tagSeparator);
      if (parsedValue === undefined) {
        diagnostics.push(
          diagnostic(
            "error",
            "malformed-value",
            `Value for ${field} is malformed`,
            row.rowNumber,
            field,
          ),
        );
        entryInput[field] = null;
      } else {
        entryInput[field] = sourcedValue(parsedValue, attribution);
      }
    }

    let entry: RankingEntry | null = null;
    if (resolution?.status === "resolved") {
      const result = rankingEntrySchema.safeParse(entryInput);
      if (result.success) {
        entry = result.data;
      } else {
        for (const issue of result.error.issues) {
          const firstPath = issue.path[0];
          const field =
            typeof firstPath === "string" && CSV_IMPORT_FIELDS.includes(firstPath as CsvImportField)
              ? (firstPath as CsvImportField)
              : null;
          diagnostics.push(
            diagnostic("error", "invalid-entry", issue.message, row.rowNumber, field),
          );
        }
      }
    }
    const hasNonResolutionError = diagnostics.some(
      (issue) => issue.severity === "error" && issue.code !== "unresolved-player",
    );
    const status: CsvPreviewRowStatus = hasNonResolutionError
      ? "invalid"
      : resolution?.status === "unresolved"
        ? "unresolved"
        : entry === null
          ? "invalid"
          : "ready";
    return {
      rowNumber: row.rowNumber,
      cells: Object.freeze([...row.cells]),
      status,
      playerId: entry?.playerId ?? null,
      entry,
      diagnostics,
    };
  });

  const rowsByPlayer = new Map<string, MutablePreviewRow[]>();
  for (const row of previewRows) {
    if (row.entry === null || row.status !== "ready") continue;
    const grouped = rowsByPlayer.get(row.entry.playerId) ?? [];
    grouped.push(row);
    rowsByPlayer.set(row.entry.playerId, grouped);
  }
  for (const duplicateRows of rowsByPlayer.values()) {
    if (duplicateRows.length < 2) continue;
    for (const row of duplicateRows) {
      row.status = "duplicate";
      row.diagnostics.push(
        diagnostic(
          "error",
          "duplicate-player",
          "Player occurs more than once; select exactly one row before committing",
          row.rowNumber,
          "playerId",
        ),
      );
    }
  }

  const ranks = new Map<number, MutablePreviewRow[]>();
  for (const row of previewRows) {
    const rank = row.entry?.overallRank?.value;
    if (rank === undefined) continue;
    const grouped = ranks.get(rank) ?? [];
    grouped.push(row);
    ranks.set(rank, grouped);
  }
  for (const duplicateRanks of ranks.values()) {
    if (duplicateRanks.length < 2) continue;
    for (const row of duplicateRanks) {
      row.diagnostics.push(
        diagnostic(
          "warning",
          "duplicate-overall-rank",
          "Overall rank is duplicated; normalization can make ranks gap-free",
          row.rowNumber,
          "overallRank",
        ),
      );
    }
  }

  const frozenRows = Object.freeze(
    previewRows.map((row) =>
      Object.freeze({ ...row, diagnostics: Object.freeze([...row.diagnostics]) }),
    ),
  );
  const summary: CsvPreviewSummary = Object.freeze({
    total: frozenRows.length,
    ready: frozenRows.filter((row) => row.status === "ready").length,
    invalid: frozenRows.filter((row) => row.status === "invalid").length,
    unresolved: frozenRows.filter((row) => row.status === "unresolved").length,
    duplicate: frozenRows.filter((row) => row.status === "duplicate").length,
  });
  const previewWithoutChecksum: Omit<RankingCsvPreview, "previewChecksumSha256"> = Object.freeze({
    sourceChecksumSha256,
    headers: Object.freeze(headers),
    mapping,
    rows: frozenRows,
    diagnostics: Object.freeze(fileDiagnostics),
    summary,
    canCommitAll:
      frozenRows.length > 0 &&
      frozenRows.every((row) => row.status === "ready") &&
      fileDiagnostics.every((issue) => issue.severity !== "error"),
  });
  return Object.freeze({
    ...previewWithoutChecksum,
    previewChecksumSha256: computePreviewChecksum(previewWithoutChecksum),
  });
}

export type RankingCsvCommitDecision =
  | Readonly<{ mode: "all-valid"; previewChecksumSha256: string }>
  | Readonly<{
      mode: "selected-rows";
      previewChecksumSha256: string;
      rowNumbers: readonly number[];
    }>;

export interface CommittedRankingCsvImport {
  readonly sourceChecksumSha256: string;
  readonly previewChecksumSha256: string;
  readonly acceptedRowNumbers: readonly number[];
  readonly skippedRowNumbers: readonly number[];
  readonly entries: readonly RankingEntry[];
}

export class RankingCsvCommitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RankingCsvCommitError";
  }
}

/**
 * Materialize previewed rows only after an explicit decision tied to the exact preview.
 * This returns an artifact; callers must still explicitly merge or persist it.
 */
export function commitRankingCsvPreview(
  preview: RankingCsvPreview,
  decision: RankingCsvCommitDecision,
): CommittedRankingCsvImport {
  const { previewChecksumSha256: _previewChecksumSha256, ...previewPayload } = preview;
  void _previewChecksumSha256;
  const recomputedChecksum = computePreviewChecksum(previewPayload);
  if (
    preview.previewChecksumSha256 !== recomputedChecksum ||
    decision.previewChecksumSha256 !== preview.previewChecksumSha256
  ) {
    throw new RankingCsvCommitError("Preview is stale, changed, or does not match the decision");
  }

  let selectedRows: readonly CsvPreviewRow[];
  if (decision.mode === "all-valid") {
    if (!preview.canCommitAll) {
      throw new RankingCsvCommitError("All-valid commit requires every row to be ready");
    }
    selectedRows = preview.rows;
  } else {
    if (decision.rowNumbers.length === 0) {
      throw new RankingCsvCommitError("At least one row must be explicitly selected");
    }
    if (new Set(decision.rowNumbers).size !== decision.rowNumbers.length) {
      throw new RankingCsvCommitError("Selected row numbers must be unique");
    }
    const selected = new Set(decision.rowNumbers);
    selectedRows = preview.rows.filter((row) => selected.has(row.rowNumber));
    if (selectedRows.length !== selected.size) {
      throw new RankingCsvCommitError("A selected row is not part of this preview");
    }
    if (
      selectedRows.some(
        (row) => (row.status !== "ready" && row.status !== "duplicate") || row.entry === null,
      )
    ) {
      throw new RankingCsvCommitError("Invalid or unresolved rows cannot be selected");
    }
  }

  const entries = selectedRows.flatMap((row) => (row.entry === null ? [] : [row.entry]));
  if (new Set(entries.map((entry) => entry.playerId)).size !== entries.length) {
    throw new RankingCsvCommitError("Select no more than one row for each duplicate player");
  }
  const acceptedRowNumbers = selectedRows.map((row) => row.rowNumber);
  const accepted = new Set(acceptedRowNumbers);
  return Object.freeze({
    sourceChecksumSha256: preview.sourceChecksumSha256,
    previewChecksumSha256: preview.previewChecksumSha256,
    acceptedRowNumbers: Object.freeze(acceptedRowNumbers),
    skippedRowNumbers: Object.freeze(
      preview.rows.filter((row) => !accepted.has(row.rowNumber)).map((row) => row.rowNumber),
    ),
    entries: Object.freeze(entries.map((entry) => rankingEntrySchema.parse(entry))),
  });
}

const FIELD_TO_CANONICAL_COLUMN: Readonly<Record<RankingFieldName, string>> = Object.freeze({
  overallRank: "overall_rank",
  positionRank: "position_rank",
  tier: "tier",
  adp: "adp",
  aav: "aav",
  floorPrice: "floor_price",
  targetPrice: "target_price",
  ceilingPrice: "ceiling_price",
  confidence: "confidence",
  tags: "tags_json",
  notes: "notes",
  target: "target",
  avoid: "avoid",
});

export const CANONICAL_RANKING_CSV_COLUMNS = Object.freeze([
  "player_id",
  "position",
  ...RANKING_FIELD_NAMES.map((field) => FIELD_TO_CANONICAL_COLUMN[field]),
  "provenance_json",
]);

const spreadsheetFormulaPrefix = /^[\t\r ']*[=+\-@]/u;

/**
 * Spreadsheet programs can interpret a valid CSV cell beginning with =, +, -, or @ as a
 * formula. Prefix those values with the conventional apostrophe text guard. The canonical parser
 * removes exactly the guard added here, so portable Laces Out CSV files remain lossless.
 */
function guardSpreadsheetCell(value: string): string {
  return spreadsheetFormulaPrefix.test(value) ? `'${value}` : value;
}

function removeSpreadsheetCellGuard(value: string): string {
  return value.startsWith("'") && spreadsheetFormulaPrefix.test(value.slice(1))
    ? value.slice(1)
    : value;
}

function escapeCsvCell(value: string): string {
  const guarded = guardSpreadsheetCell(value);
  return /[",\r\n]/u.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function attributionFromField(field: NonNullable<RankingEntryField>): FieldAttribution {
  const { value: _value, ...attribution } = field;
  void _value;
  return fieldAttributionSchema.parse(attribution);
}

function exportFieldValue(fieldName: RankingFieldName, field: RankingEntryField): string {
  if (field === null) return "";
  if (fieldName === "tags") return canonicalJson(field.value);
  return String(field.value);
}

/** Human-readable values plus a machine-readable provenance cell for a lossless round trip. */
export function exportRankingEntriesCsv(input: readonly RankingEntry[]): string {
  const entries = z.array(rankingEntrySchema).max(10_000).parse(input);
  const lines = [CANONICAL_RANKING_CSV_COLUMNS.map(escapeCsvCell).join(",")];
  for (const entry of entries) {
    const provenance: Record<string, FieldAttribution> = {};
    const values = RANKING_FIELD_NAMES.map((fieldName) => {
      const field = entry[fieldName];
      if (field !== null) provenance[fieldName] = attributionFromField(field);
      return exportFieldValue(fieldName, field);
    });
    lines.push(
      [entry.playerId, entry.position ?? "", ...values, canonicalJson(provenance)]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface RankingCsvIssue {
  readonly rowNumber: number | null;
  readonly message: string;
}

export class RankingCsvError extends Error {
  public readonly issues: readonly RankingCsvIssue[];

  public constructor(message: string, issues: readonly RankingCsvIssue[]) {
    super(message);
    this.name = "RankingCsvError";
    this.issues = issues;
  }
}

function parseCanonicalFieldValue(
  field: RankingFieldName,
  value: string,
): number | boolean | string | readonly string[] | undefined {
  if (field === "tags") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const result = z.array(z.string()).safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
  if (field === "notes") return value;
  if (field === "target" || field === "avoid") {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseCanonicalRankingCsv(source: string): readonly RankingEntry[] {
  if (new TextEncoder().encode(source).byteLength > MAX_RANKING_CSV_BYTES) {
    throw new RankingCsvError("Canonical ranking CSV exceeds the size limit", []);
  }
  const parsed = parseCsv(source, ",");
  const issues: RankingCsvIssue[] = parsed.diagnostics.map((issue) => ({
    rowNumber: issue.rowNumber,
    message: issue.message,
  }));
  const header = parsed.rows[0]?.cells;
  if (canonicalJson(header ?? []) !== canonicalJson(CANONICAL_RANKING_CSV_COLUMNS)) {
    issues.push({ rowNumber: 1, message: "Canonical CSV header does not match schema version 1" });
  }
  const entries: RankingEntry[] = [];
  for (const row of parsed.rows.slice(1)) {
    if (row.cells.every((cell) => cell.length === 0)) continue;
    if (row.cells.length !== CANONICAL_RANKING_CSV_COLUMNS.length) {
      issues.push({ rowNumber: row.rowNumber, message: "Canonical CSV row has the wrong width" });
      continue;
    }
    const cells = row.cells.map(removeSpreadsheetCellGuard);
    const provenanceCell = cells.at(-1) ?? "";
    let provenanceInput: unknown;
    try {
      provenanceInput = JSON.parse(provenanceCell) as unknown;
    } catch {
      issues.push({ rowNumber: row.rowNumber, message: "provenance_json is not valid JSON" });
      continue;
    }
    const provenanceRecordResult = z.record(z.string(), z.unknown()).safeParse(provenanceInput);
    if (!provenanceRecordResult.success) {
      issues.push({ rowNumber: row.rowNumber, message: "provenance_json must be an object" });
      continue;
    }
    const unknownProvenanceKeys = Object.keys(provenanceRecordResult.data).filter(
      (key) => !RANKING_FIELD_NAMES.includes(key as RankingFieldName),
    );
    if (unknownProvenanceKeys.length > 0) {
      issues.push({ rowNumber: row.rowNumber, message: "provenance_json has unknown fields" });
      continue;
    }

    const entryInput: Record<string, unknown> = {
      playerId: cells[0] ?? "",
      position: (cells[1] ?? "").length === 0 ? null : cells[1],
    };
    for (const [fieldIndex, field] of RANKING_FIELD_NAMES.entries()) {
      const rawValue = cells[fieldIndex + 2] ?? "";
      const rawAttribution = provenanceRecordResult.data[field];
      if (rawValue.length === 0 && rawAttribution === undefined) {
        entryInput[field] = null;
        continue;
      }
      if (rawAttribution === undefined) {
        issues.push({ rowNumber: row.rowNumber, message: `${field} is missing provenance` });
        entryInput[field] = null;
        continue;
      }
      const attributionResult = fieldAttributionSchema.safeParse(rawAttribution);
      const value = parseCanonicalFieldValue(field, rawValue);
      if (!attributionResult.success || value === undefined) {
        issues.push({ rowNumber: row.rowNumber, message: `${field} is malformed` });
        entryInput[field] = null;
        continue;
      }
      entryInput[field] = sourcedValue(value, attributionResult.data);
    }
    const entryResult = rankingEntrySchema.safeParse(entryInput);
    if (!entryResult.success) {
      for (const issue of entryResult.error.issues) {
        issues.push({ rowNumber: row.rowNumber, message: issue.message });
      }
    } else {
      entries.push(entryResult.data);
    }
  }
  if (new Set(entries.map((entry) => entry.playerId)).size !== entries.length) {
    issues.push({ rowNumber: null, message: "Canonical CSV contains duplicate players" });
  }
  if (issues.length > 0) throw new RankingCsvError("Canonical ranking CSV is invalid", issues);
  return Object.freeze(entries);
}
