export const YAHOO_DRAFT_PREREGISTRATION_CHECKSUM =
  "4a1a6f26f1d96c9f03519a607f31deadb4dfe6dd51a5666d58e8effd7b225ef8";

export type YahooDraftFormat = "snake" | "auction";
export type YahooDraftReleaseState = "shadow-only" | "append-beta";

/**
 * Snake and auction are admitted independently. A completed snake artifact says nothing about
 * auction prices, and neither format borrows admission from normal Yahoo league-sync coverage.
 */
export const YAHOO_DRAFT_RELEASE: Readonly<
  Record<
    YahooDraftFormat,
    { readonly state: YahooDraftReleaseState; readonly blocker: string | null }
  >
> = {
  snake: {
    state: "shadow-only",
    blocker:
      "The current authorized 2026 Yahoo snake league is predraft; no frozen post-selection completed holdout has an independent final-board manifest and passing every-prefix replay.",
  },
  auction: {
    state: "shadow-only",
    blocker:
      "No authorized Yahoo auction artifact is available; exact winning prices, an independent final-board manifest, and a frozen post-selection every-prefix replay remain unconfirmed.",
  },
};

export function yahooDraftApplicationMode(format: YahooDraftFormat): "shadow" | "append" {
  return YAHOO_DRAFT_RELEASE[format].state === "append-beta" ? "append" : "shadow";
}
