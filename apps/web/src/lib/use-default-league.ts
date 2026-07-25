"use client";

import { useEffect, useState } from "react";

import { apiBaseUrl } from "./api-client";

export interface DefaultLeaguePreference {
  readonly defaultLeagueId: string | null;
  /** False until the stored preference has been read, so callers apply it exactly once. */
  readonly loaded: boolean;
}

/**
 * The member's stored default league. Every league surface otherwise opens on `leagues[0]`, which
 * means anyone in more than one league re-picks on every visit.
 */
export function useDefaultLeague(): DefaultLeaguePreference {
  const [preference, setPreference] = useState<DefaultLeaguePreference>({
    defaultLeagueId: null,
    loaded: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/preferences`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((body) => {
        if (controller.signal.aborted) return;
        const value =
          body && typeof body === "object" && "defaultLeagueId" in body
            ? (body as { defaultLeagueId?: unknown }).defaultLeagueId
            : null;
        setPreference({
          defaultLeagueId: typeof value === "string" ? value : null,
          loaded: true,
        });
      })
      // No stored preference is the common case, not an error worth surfacing.
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreference({ defaultLeagueId: null, loaded: true });
        }
      });
    return () => controller.abort();
  }, []);

  return preference;
}
