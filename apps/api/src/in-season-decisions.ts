/**
 * The in-season decision core is provider-neutral engine orchestration shared by the API's
 * on-demand `GET /v1/leagues/:leagueId/decisions` and the worker's `recommendation-recompute` job,
 * so it lives in `@laces-out/decisions` (ADR 0001 — neither app may import the other). This shim
 * keeps every existing `./in-season-decisions.js` import in `apps/api` unchanged.
 */
export * from "@laces-out/decisions";
