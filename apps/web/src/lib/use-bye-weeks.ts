"use client";

import { useEffect, useState } from "react";

import { apiBaseUrl, parseScheduleByes } from "./api-client";

/**
 * Team-to-bye-week lookup for a season. Teams whose bye the admitted schedule cannot affirm are
 * absent from the map rather than defaulted, so a caller renders nothing instead of a guess.
 */
export function useByeWeeks(season: number | null | undefined): ReadonlyMap<string, number> {
  const [byeWeeks, setByeWeeks] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    if (!season) {
      setByeWeeks(new Map());
      return;
    }
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/schedule/byes?season=${String(season)}`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? parseScheduleByes(await response.json()) : null))
      .then((parsed) => {
        if (controller.signal.aborted) return;
        setByeWeeks(new Map(Object.entries(parsed?.byeWeeks ?? {})));
      })
      // A missing bye is a blank cell, never a reason to break the surface that asked.
      .catch(() => {
        if (!controller.signal.aborted) setByeWeeks(new Map());
      });
    return () => controller.abort();
  }, [season]);

  return byeWeeks;
}
