"use client";

import type { Provider } from "@laces-out/contracts";
import { createContext, createElement, type ReactNode, useContext, useEffect } from "react";

type ActiveFantasyProvider = Provider | null;
type ProviderReporter = (provider: ActiveFantasyProvider) => void;

interface LeagueProviderCandidate {
  readonly id: string;
  readonly season: { readonly provider: Provider } | null;
}

const FantasyProviderAttributionContext = createContext<ProviderReporter | null>(null);

export function providerForSelectedLeague(
  leagues: readonly LeagueProviderCandidate[],
  selectedLeagueId: string,
): ActiveFantasyProvider {
  if (!selectedLeagueId) return null;
  return leagues.find((league) => league.id === selectedLeagueId)?.season?.provider ?? null;
}

export function shouldShowYahooAttribution(provider: ActiveFantasyProvider): boolean {
  return provider === "yahoo";
}

export function FantasyProviderAttributionBoundary({
  children,
  onProviderChange,
}: {
  readonly children: ReactNode;
  readonly onProviderChange: ProviderReporter;
}) {
  return createElement(
    FantasyProviderAttributionContext.Provider,
    { value: onProviderChange },
    children,
  );
}

/**
 * Reports which fantasy provider owns the league whose data the current workspace is showing.
 * Pages without an active league do not report one, so provider attribution never leaks across
 * route changes or appears merely because the member has a connection on file.
 */
export function useFantasyProviderAttribution(provider: ActiveFantasyProvider): void {
  const reportProvider = useContext(FantasyProviderAttributionContext);

  useEffect(() => {
    if (reportProvider === null) return undefined;
    reportProvider(provider);
    return () => reportProvider(null);
  }, [provider, reportProvider]);
}
