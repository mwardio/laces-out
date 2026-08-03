export const ESPN_STALE_ON_VIEW_REPEAT_MS = 10 * 60 * 1_000;

export function shouldRequestEspnRefreshOnView(storedAt: string | null, now: number): boolean {
  const lastRequestedAt = Number(storedAt);
  return (
    !Number.isFinite(lastRequestedAt) ||
    lastRequestedAt <= 0 ||
    lastRequestedAt > now ||
    now - lastRequestedAt >= ESPN_STALE_ON_VIEW_REPEAT_MS
  );
}
