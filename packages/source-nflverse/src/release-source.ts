import { createHash } from "node:crypto";

export const NFLVERSE_DATA_ORIGIN = "https://github.com" as const;
export const NFLVERSE_DATA_REPOSITORY_URL = "https://github.com/nflverse/nflverse-data" as const;
export const NFLVERSE_DATA_LICENSE = "CC BY 4.0" as const;

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/csv",
  "text/csv",
  "text/plain",
]);

export type NflverseFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NflverseDatasetState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export interface NflverseReleaseMetadata {
  readonly checkedAt: string;
  readonly sourceUrl: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export class NflverseDatasetSourceError extends Error {
  readonly code:
    | "INVALID_CONTEXT"
    | "NETWORK"
    | "REDIRECT"
    | "NOT_AVAILABLE"
    | "UPSTREAM"
    | "CONTENT_TYPE"
    | "TOO_LARGE"
    | "INVALID_CSV"
    | "QUALITY_THRESHOLD";
  readonly retryable: boolean;

  constructor(code: NflverseDatasetSourceError["code"], message: string, retryable = false) {
    super(message);
    this.name = "NflverseDatasetSourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeHeader(value: string | null): string | null {
  if (!value) return null;
  return /^[\x20-\x7E]{1,512}$/u.test(value) ? value : null;
}

function redirectTarget(current: URL, location: string | null): URL {
  if (!location) {
    throw new NflverseDatasetSourceError("REDIRECT", "nflverse redirect omitted Location");
  }
  const target = new URL(location, current);
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new NflverseDatasetSourceError("REDIRECT", "nflverse redirected to an unapproved host");
  }
  return target;
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  datasetLabel: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new NflverseDatasetSourceError(
      "TOO_LARGE",
      `${datasetLabel} exceeds its ${maximumBytes}-byte response limit`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NflverseDatasetSourceError(
        "TOO_LARGE",
        `${datasetLabel} exceeds its ${maximumBytes}-byte response limit`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function assertContentType(response: Response, datasetLabel: string): void {
  const contentType = response.headers.get("content-type");
  // GitHub test doubles and some cached release responses omit Content-Type. The CSV parser and
  // required-column checks remain the final admission boundary in that case.
  if (!contentType) return;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || !ALLOWED_CONTENT_TYPES.has(mediaType)) {
    throw new NflverseDatasetSourceError(
      "CONTENT_TYPE",
      `${datasetLabel} returned unsupported content type ${mediaType || "unknown"}`,
    );
  }
}

export type NflverseCsvCheckResult =
  | ({ readonly state: "changed"; readonly body: string } & NflverseReleaseMetadata & {
        readonly checksumSha256: string;
      })
  | ({ readonly state: "unchanged" } & NflverseReleaseMetadata);

export async function checkNflverseCsvRelease(input: {
  readonly fetch: NflverseFetchLike;
  readonly now: () => Date;
  readonly sourceUrl: string;
  readonly previous: NflverseDatasetState;
  readonly maximumBytes: number;
  readonly datasetLabel: string;
}): Promise<NflverseCsvCheckResult> {
  const source = new URL(input.sourceUrl);
  if (
    source.protocol !== "https:" ||
    source.origin !== NFLVERSE_DATA_ORIGIN ||
    source.pathname.includes("..")
  ) {
    throw new NflverseDatasetSourceError("INVALID_CONTEXT", "Invalid nflverse release URL");
  }

  const headers: Record<string, string> = {
    Accept: "text/csv, application/octet-stream;q=0.9, text/plain;q=0.8",
  };
  if (input.previous.etag) headers["If-None-Match"] = input.previous.etag;
  if (input.previous.lastModified) {
    headers["If-Modified-Since"] = input.previous.lastModified;
  }

  let endpoint = source;
  let response: Response | undefined;
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    try {
      response = await input.fetch(endpoint, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new NflverseDatasetSourceError("NETWORK", `${input.datasetLabel} check failed`, true);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (attempt === MAX_REDIRECTS) {
      throw new NflverseDatasetSourceError("REDIRECT", "nflverse exceeded redirect limit");
    }
    endpoint = redirectTarget(endpoint, response.headers.get("location"));
  }

  if (!response) {
    throw new NflverseDatasetSourceError(
      "NETWORK",
      `${input.datasetLabel} returned no response`,
      true,
    );
  }
  const checkedAt = input.now().toISOString();
  const etag = safeHeader(response.headers.get("etag")) ?? input.previous.etag;
  const lastModified =
    safeHeader(response.headers.get("last-modified")) ?? input.previous.lastModified;
  if (response.status === 304) {
    return {
      state: "unchanged",
      checkedAt,
      sourceUrl: input.sourceUrl,
      etag,
      lastModified,
      checksumSha256: input.previous.checksumSha256,
    };
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new NflverseDatasetSourceError(
        "NOT_AVAILABLE",
        `${input.datasetLabel} release is not available for this context`,
      );
    }
    throw new NflverseDatasetSourceError(
      "UPSTREAM",
      `${input.datasetLabel} check returned status ${response.status}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  assertContentType(response, input.datasetLabel);
  const body = await readBounded(response, input.maximumBytes, input.datasetLabel);
  const checksumSha256 = createHash("sha256").update(body, "utf8").digest("hex");
  if (checksumSha256 === input.previous.checksumSha256) {
    return {
      state: "unchanged",
      checkedAt,
      sourceUrl: input.sourceUrl,
      etag,
      lastModified,
      checksumSha256,
    };
  }
  return {
    state: "changed",
    body,
    checkedAt,
    sourceUrl: input.sourceUrl,
    etag,
    lastModified,
    checksumSha256,
  };
}

export function assertNflverseSeason(season: number, earliestSeason: number): void {
  if (!Number.isInteger(season) || season < earliestSeason || season > 2200) {
    throw new NflverseDatasetSourceError(
      "INVALID_CONTEXT",
      `Season must be an integer between ${earliestSeason} and 2200`,
    );
  }
}

export function assertAdmissionQuality(input: {
  readonly datasetLabel: string;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly absoluteRejectionAllowance: number;
  readonly maximumRejectionRatio: number;
}): void {
  if (input.rowsRead === 0 || input.rowsAccepted === 0) {
    throw new NflverseDatasetSourceError(
      "INVALID_CSV",
      `${input.datasetLabel} contained no valid observations`,
    );
  }
  const ratioAllowance = Math.floor(input.rowsRead * input.maximumRejectionRatio);
  const rejectionAllowance = Math.max(input.absoluteRejectionAllowance, ratioAllowance);
  if (input.rowsRejected > rejectionAllowance) {
    throw new NflverseDatasetSourceError(
      "QUALITY_THRESHOLD",
      `${input.datasetLabel} rejected ${input.rowsRejected} of ${input.rowsRead} rows`,
    );
  }
}
