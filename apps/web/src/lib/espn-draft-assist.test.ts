import type { DraftSessionSnapshot } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  espnAssistAvailable,
  espnAssistSelection,
  shouldRequestEspnDraftRefresh,
} from "./espn-draft-assist";

describe("ESPN draft assist", () => {
  it("is offered only for a supported ESPN league and requires opt-in", () => {
    expect(espnAssistAvailable("espn", true)).toBe(true);
    expect(espnAssistAvailable("yahoo", true)).toBe(false);
    expect(espnAssistAvailable("espn", false)).toBe(false);
    expect(espnAssistSelection("espn", true, true)).toBe("espn");
    expect(espnAssistSelection("espn", false, true)).toBeUndefined();
  });

  it("requests shared result checks only for an unfinished ESPN-assisted room", () => {
    const feed = {
      provider: "espn",
      state: "live",
    } as DraftSessionSnapshot["providerFeed"];
    expect(shouldRequestEspnDraftRefresh({ transport: "espn-live", providerFeed: feed })).toBe(
      true,
    );
    expect(
      shouldRequestEspnDraftRefresh({
        transport: "espn-live",
        providerFeed: { ...feed!, state: "complete" },
      }),
    ).toBe(false);
    expect(shouldRequestEspnDraftRefresh({ transport: "manual", providerFeed: null })).toBe(false);
  });
});
