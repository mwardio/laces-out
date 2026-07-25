import { describe, expect, it } from "vitest";

import {
  ESPN_DRAFT_LABELS,
  ESPN_DRAFT_ROUTES,
  ESPN_DRAFT_SELECTORS,
  extractDraftRoom,
  recognizeEspnDraftRoute,
  resolveAll,
  resolveSingle,
  type DraftRoomElement,
} from "./dom-adapter.js";

/**
 * Invented fixtures only. There is no jsdom in this repository and none is wanted, so a fake node
 * is a selector-to-matches oracle: `querySelectorAll("x")` returns whatever the fixture registered
 * for "x". Fixtures key off `ESPN_DRAFT_SELECTORS.<family>.candidates[n]` rather than hard-coded
 * strings, so when Work Package 0 replaces the provisional selectors with verified ones, these
 * tests keep passing without being rewritten.
 */
interface FakeSpec {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly matches?: Readonly<Record<string, readonly FakeSpec[]>>;
  /** Selectors that throw, standing in for a hostile page or a malformed selector. */
  readonly throwsOn?: readonly string[];
}

function fake(spec: FakeSpec): DraftRoomElement {
  const node: DraftRoomElement = {
    getAttribute: (name) => spec.attributes?.[name] ?? null,
    textContent: spec.text ?? null,
    querySelector: (selector) => {
      const matches = node.querySelectorAll(selector);
      return matches.length === 1 ? (matches[0] ?? null) : null;
    },
    querySelectorAll: (selector) => {
      if (spec.throwsOn?.includes(selector)) throw new Error("hostile selector");
      return (spec.matches?.[selector] ?? []).map((child) => fake(child));
    },
  };
  return node;
}

const rootSelector = ESPN_DRAFT_SELECTORS.draftRoot.candidates[0];
const stateSelector = ESPN_DRAFT_SELECTORS.draftState.candidates[0];
const stateAttribute = ESPN_DRAFT_SELECTORS.draftState.attribute;
const typeSelector = ESPN_DRAFT_SELECTORS.draftType.candidates[0];
const typeAttribute = ESPN_DRAFT_SELECTORS.draftType.attribute;
const teamCountSelector = ESPN_DRAFT_SELECTORS.expectedTeamCount.candidates[0];
const teamCountAttribute = ESPN_DRAFT_SELECTORS.expectedTeamCount.attribute;
const rosterSizeSelector = ESPN_DRAFT_SELECTORS.expectedRosterSize.candidates[0];
const rosterSizeAttribute = ESPN_DRAFT_SELECTORS.expectedRosterSize.attribute;
const pickRowSelector = ESPN_DRAFT_SELECTORS.pickRow.candidates[0];
const ownershipRowSelector = ESPN_DRAFT_SELECTORS.ownershipRow.candidates[0];
const auctionPanelSelector = ESPN_DRAFT_SELECTORS.auctionPanel.candidates[0];

function attributeCell(family: keyof typeof ESPN_DRAFT_SELECTORS, value: string): FakeSpec {
  return { attributes: { [ESPN_DRAFT_SELECTORS[family].attribute!]: value } };
}

function textCell(value: string): FakeSpec {
  return { text: value };
}

function snakePickRow(fields: {
  sequence: string;
  round?: string;
  roundPick?: string;
  keeper?: string;
  teamId?: string;
  teamName: string;
  playerId?: string;
  playerName: string;
  proTeam?: string;
  position?: string;
}): FakeSpec {
  const matches: Record<string, readonly FakeSpec[]> = {
    [ESPN_DRAFT_SELECTORS.pickSequence.candidates[0]]: [
      attributeCell("pickSequence", fields.sequence),
    ],
    [ESPN_DRAFT_SELECTORS.pickTeamName.candidates[0]]: [textCell(fields.teamName)],
    [ESPN_DRAFT_SELECTORS.pickPlayerName.candidates[0]]: [textCell(fields.playerName)],
  };
  if (fields.round !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickRound.candidates[0]] = [
      attributeCell("pickRound", fields.round),
    ];
  }
  if (fields.roundPick !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickRoundPick.candidates[0]] = [
      attributeCell("pickRoundPick", fields.roundPick),
    ];
  }
  if (fields.keeper !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickKeeper.candidates[0]] = [
      attributeCell("pickKeeper", fields.keeper),
    ];
  }
  if (fields.teamId !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickTeamId.candidates[0]] = [
      attributeCell("pickTeamId", fields.teamId),
    ];
  }
  if (fields.playerId !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickPlayerId.candidates[0]] = [
      attributeCell("pickPlayerId", fields.playerId),
    ];
  }
  if (fields.proTeam !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickProTeam.candidates[0]] = [textCell(fields.proTeam)];
  }
  if (fields.position !== undefined) {
    matches[ESPN_DRAFT_SELECTORS.pickPosition.candidates[0]] = [textCell(fields.position)];
  }
  return { matches };
}

function draftRoom(options: {
  state?: string;
  draftType?: string;
  teamCount?: string;
  rosterSize?: string;
  pickRows?: readonly FakeSpec[];
  ownershipRows?: readonly FakeSpec[];
  auction?: readonly FakeSpec[];
}): DraftRoomElement {
  const inner: Record<string, readonly FakeSpec[]> = {
    [stateSelector]: [{ attributes: { [stateAttribute]: options.state ?? "live" } }],
    [typeSelector]: [{ attributes: { [typeAttribute]: options.draftType ?? "snake" } }],
    [teamCountSelector]: [{ attributes: { [teamCountAttribute]: options.teamCount ?? "12" } }],
  };
  if (options.rosterSize !== undefined) {
    inner[rosterSizeSelector] = [{ attributes: { [rosterSizeAttribute]: options.rosterSize } }];
  }
  if (options.pickRows) inner[pickRowSelector] = options.pickRows;
  if (options.ownershipRows) inner[ownershipRowSelector] = options.ownershipRows;
  if (options.auction) inner[auctionPanelSelector] = options.auction;
  return fake({ matches: { [rootSelector]: [{ matches: inner }] } });
}

describe("ESPN draft route recognition", () => {
  const bounds = { minimum: 2019, maximum: 2100 };

  it("recognizes a live football draft room with a league and season", () => {
    expect(
      recognizeEspnDraftRoute(
        "https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=2026&teamId=4",
        bounds,
      ),
    ).toEqual({ leagueId: "1234567", season: 2026 });
  });

  it("refuses recaps, lobbies, other sports, other hosts, and plain HTTP", () => {
    for (const href of [
      "https://fantasy.espn.com/football/draftrecap?leagueId=1234567&seasonId=2026",
      "https://fantasy.espn.com/football/mockdraftlobby?seasonId=2026",
      "https://fantasy.espn.com/baseball/draft?leagueId=1234567&seasonId=2026",
      "https://fantasy.espn.com.evil.example/football/draft?leagueId=1234567&seasonId=2026",
      "http://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=2026",
      "not a url",
    ]) {
      expect(recognizeEspnDraftRoute(href, bounds)).toBeNull();
    }
  });

  it("refuses a draft room with no league, a non-numeric league, or an out-of-range season", () => {
    // A public mock draft has no league ID, so it can never map to a paired Laces Out league.
    expect(
      recognizeEspnDraftRoute("https://fantasy.espn.com/football/draft?mockDraftId=99", bounds),
    ).toBeNull();
    expect(
      recognizeEspnDraftRoute(
        "https://fantasy.espn.com/football/draft?leagueId=abc&seasonId=2026",
        bounds,
      ),
    ).toBeNull();
    expect(
      recognizeEspnDraftRoute(
        "https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=1998",
        bounds,
      ),
    ).toBeNull();
  });

  it("keeps the manifest match patterns scoped to the declared ESPN host", () => {
    for (const match of ESPN_DRAFT_ROUTES.manifestMatches) {
      expect(match.startsWith(`https://${ESPN_DRAFT_ROUTES.host}/`)).toBe(true);
    }
  });
});

describe("ESPN draft selector resolution", () => {
  it("resolves a family through the first candidate that matches exactly one node", () => {
    const root = fake({ matches: { [rootSelector]: [{ text: "room" }] } });
    const resolution = resolveSingle(root, ESPN_DRAFT_SELECTORS.draftRoot);
    expect(resolution.kind).toBe("resolved");
  });

  it("falls through to a later candidate when an earlier one matches nothing", () => {
    const second = ESPN_DRAFT_SELECTORS.draftRoot.candidates[1];
    const root = fake({ matches: { [second]: [{ text: "room" }] } });
    expect(resolveSingle(root, ESPN_DRAFT_SELECTORS.draftRoot).kind).toBe("resolved");
  });

  it("fails closed on an ambiguous match instead of guessing the first node", () => {
    const root = fake({
      matches: {
        [rootSelector]: [{ text: "room one" }, { text: "room two" }],
        [ESPN_DRAFT_SELECTORS.draftRoot.candidates[1]]: [{ text: "would have matched" }],
      },
    });
    const resolution = resolveSingle(root, ESPN_DRAFT_SELECTORS.draftRoot);
    // Ambiguity is terminal: falling through would silently swap a broken strong selector for a
    // weaker one and publish a guessed board.
    expect(resolution).toEqual({ kind: "ambiguous", matches: 2 });
  });

  it("reports missing when no candidate matches, and survives a selector that throws", () => {
    expect(resolveSingle(fake({}), ESPN_DRAFT_SELECTORS.draftRoot)).toEqual({ kind: "missing" });
    expect(
      resolveSingle(
        fake({ throwsOn: [...ESPN_DRAFT_SELECTORS.draftRoot.candidates] }),
        ESPN_DRAFT_SELECTORS.draftRoot,
      ),
    ).toEqual({ kind: "missing" });
  });

  it("bounds a repeated family to the requested limit", () => {
    const root = fake({
      matches: { [pickRowSelector]: Array.from({ length: 9 }, () => ({ text: "row" })) },
    });
    expect(resolveAll(root, ESPN_DRAFT_SELECTORS.pickRow, 4)).toHaveLength(4);
  });

  it("leaves every selector family marked unverified until Work Package 0 confirms it", () => {
    // The gate that stops a provisional selector table from being mistaken for a validated one.
    for (const family of Object.values(ESPN_DRAFT_SELECTORS)) {
      expect(family.verified).toBe(false);
    }
  });

  it("prefers stable attributes over text in every candidate list", () => {
    // Plan 8.2: data-testid, ids, and explicit data attributes first; text only as a fallback.
    for (const family of Object.values(ESPN_DRAFT_SELECTORS)) {
      const first = family.candidates[0];
      expect(first.startsWith("[data-") || first.startsWith("#")).toBe(true);
    }
  });
});

describe("ESPN draft room extraction", () => {
  it("reports an unrecognized page without reading anything else", () => {
    const extraction = extractDraftRoom(fake({}));
    expect(extraction.recognized).toBe(false);
    expect(extraction.pickRows).toEqual([]);
    expect(extraction.unresolvedFamilies).toContain(ESPN_DRAFT_SELECTORS.draftRoot.purpose);
  });

  it("extracts snake picks as raw strings without normalizing them", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        pickRows: [
          snakePickRow({
            sequence: "1",
            round: "1",
            roundPick: "1",
            teamId: "1",
            teamName: "  Ditka's Revenge\n",
            playerId: "3139477",
            playerName: "Patrick Mahomes",
            proTeam: "KC",
            position: "QB",
          }),
        ],
      }),
    );
    expect(extraction.recognized).toBe(true);
    expect(extraction.pickRows[0]).toMatchObject({
      sequence: "1",
      teamId: "1",
      // Raw text, untrimmed: normalization is the sanitizer's job, not the adapter's.
      teamName: "  Ditka's Revenge\n",
      playerName: "Patrick Mahomes",
      proTeam: "KC",
      position: "QB",
      ambiguousFields: [],
    });
  });

  it("extracts keeper, traded pick ownership, and auction sale fields", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        draftType: "auction",
        rosterSize: "16",
        pickRows: [
          {
            matches: {
              ...snakePickRow({
                sequence: "1",
                keeper: "true",
                teamId: "3",
                teamName: "Finkle Is Einhorn",
                playerName: "Bijan Robinson",
              }).matches,
              [ESPN_DRAFT_SELECTORS.pickPrice.candidates[0]]: [attributeCell("pickPrice", "$47")],
              [ESPN_DRAFT_SELECTORS.pickNominatingTeamId.candidates[0]]: [
                attributeCell("pickNominatingTeamId", "5"),
              ],
            },
          },
        ],
        ownershipRows: [
          {
            matches: {
              [ESPN_DRAFT_SELECTORS.ownershipOverallPick.candidates[0]]: [
                attributeCell("ownershipOverallPick", "13"),
              ],
              [ESPN_DRAFT_SELECTORS.ownershipTeamId.candidates[0]]: [
                attributeCell("ownershipTeamId", "7"),
              ],
              [ESPN_DRAFT_SELECTORS.ownershipTeamName.candidates[0]]: [
                textCell("Traded To Team Seven"),
              ],
            },
          },
        ],
      }),
    );
    expect(extraction.draftTypeAttribute).toBe("auction");
    expect(extraction.expectedRosterSizeText).toBe("16");
    expect(extraction.pickRows[0]).toMatchObject({
      keeperLabel: "true",
      price: "$47",
      nominatingTeamId: "5",
    });
    expect(extraction.ownershipRows[0]).toMatchObject({
      overallPick: "13",
      teamId: "7",
      teamName: "Traded To Team Seven",
    });
  });

  it("extracts the transient auction nomination and high bid", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        draftType: "auction",
        auction: [
          {
            matches: {
              [ESPN_DRAFT_SELECTORS.auctionNominationNumber.candidates[0]]: [
                attributeCell("auctionNominationNumber", "14"),
              ],
              [ESPN_DRAFT_SELECTORS.auctionNominatingTeamId.candidates[0]]: [
                attributeCell("auctionNominatingTeamId", "2"),
              ],
              [ESPN_DRAFT_SELECTORS.auctionPlayerName.candidates[0]]: [textCell("CeeDee Lamb")],
              [ESPN_DRAFT_SELECTORS.auctionHighBidTeamId.candidates[0]]: [
                attributeCell("auctionHighBidTeamId", "9"),
              ],
              [ESPN_DRAFT_SELECTORS.auctionHighBid.candidates[0]]: [
                attributeCell("auctionHighBid", "38"),
              ],
            },
          },
        ],
      }),
    );
    expect(extraction.auction).toMatchObject({
      nominationNumber: "14",
      nominatingTeamId: "2",
      playerName: "CeeDee Lamb",
      highBidTeamId: "9",
      highBid: "38",
    });
  });

  it("marks a row field ambiguous rather than choosing between two matching cells", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        pickRows: [
          {
            matches: {
              ...snakePickRow({ sequence: "1", teamName: "Team", playerName: "Player" }).matches,
              [ESPN_DRAFT_SELECTORS.pickPlayerName.candidates[0]]: [
                textCell("Patrick Mahomes"),
                textCell("Josh Allen"),
              ],
            },
          },
        ],
      }),
    );
    expect(extraction.pickRows[0]?.playerName).toBeNull();
    expect(extraction.pickRows[0]?.ambiguousFields).toContain(
      ESPN_DRAFT_SELECTORS.pickPlayerName.purpose,
    );
  });

  it("flags an oversized rendered table instead of truncating the board", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        pickRows: Array.from({ length: 1_001 }, (_, index) =>
          snakePickRow({
            sequence: String(index + 1),
            teamName: "Team",
            playerName: "Player",
          }),
        ),
      }),
    );
    expect(extraction.pickRowOverflow).toBe(true);
    expect(extraction.pickRows).toHaveLength(1_000);
  });

  it("keeps hostile markup as inert raw text for the sanitizer to reject", () => {
    const extraction = extractDraftRoom(
      draftRoom({
        pickRows: [
          snakePickRow({
            sequence: "1",
            teamName: "Team",
            playerName: "<script>alert(1)</script> ‮",
          }),
        ],
      }),
    );
    // The adapter never interprets markup; it hands the string on and the sanitizer drops the row.
    expect(extraction.pickRows[0]?.playerName).toBe("<script>alert(1)</script> ‮");
  });

  it("uses a label vocabulary that covers every draft state and both draft types", () => {
    expect(new Set(Object.values(ESPN_DRAFT_LABELS.state))).toEqual(
      new Set(["waiting", "live", "paused", "complete"]),
    );
    expect(new Set(Object.values(ESPN_DRAFT_LABELS.draftType))).toEqual(
      new Set(["snake", "auction"]),
    );
  });
});
