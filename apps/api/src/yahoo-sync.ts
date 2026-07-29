/**
 * Yahoo synchronization is provider-neutral service logic shared by the API and the worker, so it
 * lives in `@fantasy/league-sync` (ADR 0001 — neither app may import the other). This shim keeps
 * every existing `./yahoo-sync.js` import in `apps/api` unchanged.
 */
export * from "@fantasy/league-sync";
