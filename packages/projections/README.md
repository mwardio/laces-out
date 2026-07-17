# Projection CSV import

`previewProjectionImport` is the lower-level trust boundary for user- or
operator-supplied weekly and future rest-of-season projections. It accepts
bounded CSV text, validated metadata, and an application-owned player resolver.
The current league CSV routes deliberately expose weekly imports only because
the Decision Desk consumes exact league-season/week sets. The package retains
the broader horizon type for future consumers and has no database dependency.

Required CSV columns are `mean_points` plus either `player_id` or `player_name`.
Optional columns are `floor_points`, `ceiling_points`, and `confidence`. Common
aliases such as `Player`, `Projected Points`, `Floor`, `Ceiling`, and `FPTS` are
normalized; unknown columns generate warnings instead of being silently hidden.

```ts
const preview = await previewProjectionImport({
  csv,
  metadata: {
    season: 2026,
    week: 7,
    horizon: "week",
    sourceLabel: "Mack weekly model",
    sourceObservedAt: "2026-10-15T14:30:00.000Z",
  },
  resolvePlayer: async ({ playerId, playerName }) => {
    // Query the application's canonical player catalog. Never guess when a
    // name maps to multiple players.
    return resolveFromCatalog({ playerId, playerName });
  },
});

if (!preview.canCommit || !preview.normalized) {
  return showDiagnostics(preview.diagnostics);
}

await database.transaction(async (transaction) => {
  await insertProjectionSet(transaction, preview.normalized);
  await insertPlayerProjections(transaction, preview.normalized.playerProjections);
});
```

The resolver must return `resolved`, `unresolved`, or `ambiguous`. Unresolved,
ambiguous, duplicate, malformed, and out-of-range rows make the entire preview
non-committable. `sourceObservedAt` is required in strict UTC ISO form and is
canonicalized before hashing. It means when the source observed or published
the data; it is not the later import time. `sourceChecksum` fingerprints
canonical input and metadata, including that timestamp; `normalized.checksum`
fingerprints the exact resolved commit payload. Treat the normalized object as
atomic and never persist only its valid subset.
