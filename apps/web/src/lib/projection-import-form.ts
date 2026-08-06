import type { ProjectionSourceObservedAtStatus } from "@laces-out/contracts";

export const LEAGUE_PROJECTION_IMPORT_HORIZON = "week" as const;

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

export function localDateTimeMinuteValue(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function sourceObservedAtIso(value: string): string | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute ||
    parsed.getSeconds() !== second
  ) {
    return null;
  }
  return parsed.toISOString();
}

export function projectionSourceAsOfText(
  provenance: {
    readonly sourceObservedAt: string | null;
    readonly sourceObservedAtStatus: ProjectionSourceObservedAtStatus;
  },
  format: (value: string) => string = (value) => value,
): string {
  return provenance.sourceObservedAtStatus === "verified" && provenance.sourceObservedAt
    ? format(provenance.sourceObservedAt)
    : "Missing / unverified";
}
