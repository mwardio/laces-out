export interface WeeklyStatsCutoff {
  readonly season: number;
  readonly week: number;
}

export interface WeeklyCoverageGame {
  readonly season: number;
  readonly week: number;
  readonly kickoffAt?: Date | null;
  readonly status?: string;
}

export function weeklyStatsCutoff(value: unknown): WeeklyStatsCutoff | null {
  if (!value || typeof value !== "object") return null;
  const { season, week } = value as Partial<WeeklyStatsCutoff>;
  return Number.isSafeInteger(season) &&
    season! >= 2000 &&
    season! <= 2200 &&
    Number.isSafeInteger(week) &&
    week! >= 1 &&
    week! <= 18
    ? { season: season!, week: week! }
    : null;
}

/** Elapsed time requires a coverage check; it never establishes that a game finished. */
export function weeklyInputCoverage(input: {
  readonly season: number;
  readonly targetWeek: number;
  readonly statsThrough: WeeklyStatsCutoff | null;
  readonly schedule: readonly WeeklyCoverageGame[];
  readonly now: Date;
}): { readonly expectedThroughWeek: number | null; readonly warnings: readonly string[] } {
  const weeks = new Map<number, WeeklyCoverageGame[]>();
  for (const game of input.schedule) {
    if (
      game.season !== input.season ||
      game.week >= input.targetWeek ||
      game.week < 1 ||
      game.week > 18
    )
      continue;
    if (game.status === "cancelled") continue;
    const games = weeks.get(game.week) ?? [];
    games.push(game);
    weeks.set(game.week, games);
  }
  const overdue = [...weeks].filter(([, games]) =>
    games.every(
      (game) =>
        game.status === "final" ||
        (game.kickoffAt &&
          Number.isFinite(game.kickoffAt.getTime()) &&
          input.now.getTime() - game.kickoffAt.getTime() >= 8 * 3_600_000),
    ),
  );
  const expectedThroughWeek = overdue.length ? Math.max(...overdue.map(([week]) => week)) : null;
  const warnings: string[] = [];
  if (input.targetWeek > 1 && weeks.size === 0) {
    warnings.push(
      "Prior-week schedule coverage is unavailable. Lineup advice is paused until input coverage can be verified.",
    );
  }
  if (
    input.statsThrough &&
    (input.statsThrough.season > input.season ||
      (input.statsThrough.season === input.season && input.statsThrough.week >= input.targetWeek))
  ) {
    warnings.push(
      "The forecast's statistics cutoff is inconsistent with its target week. Lineup advice is paused until the inputs are verified.",
    );
  }
  if (overdue.some(([, games]) => games.some((game) => game.status !== "final"))) {
    warnings.push(
      "A prior week's game status is unresolved beyond its expected completion window. Recent results may be missing from the forecast.",
    );
  }
  if (
    expectedThroughWeek !== null &&
    (!input.statsThrough ||
      input.statsThrough.season < input.season ||
      (input.statsThrough.season === input.season && input.statsThrough.week < expectedThroughWeek))
  ) {
    warnings.push(
      `Forecast history has not advanced through ${input.season} Week ${expectedThroughWeek}. Lineup advice is paused until the completed-week inputs are verified.`,
    );
  }
  return { expectedThroughWeek, warnings };
}
