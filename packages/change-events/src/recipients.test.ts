import { describe, expect, it } from "vitest";

import { resolveRecipients } from "./recipients.js";

const OWNER = "10000000-0000-4000-8000-000000000001";
const MANAGER = "10000000-0000-4000-8000-000000000002";
const VIEWER = "10000000-0000-4000-8000-000000000003";
const TEAM = "30000000-0000-4000-8000-000000000001";

const members = [
  { userId: OWNER, claimedFantasyTeamId: TEAM },
  { userId: MANAGER, claimedFantasyTeamId: "30000000-0000-4000-8000-000000000002" },
  { userId: VIEWER, claimedFantasyTeamId: null },
];

describe("resolveRecipients", () => {
  it("sends a league event to every current member", () => {
    expect(
      resolveRecipients({
        visibility: "league",
        members,
        affectedTeamId: null,
        actorUserId: OWNER,
      }),
    ).toEqual([OWNER, MANAGER, VIEWER]);
  });

  it("sends a private event only to the member who claimed the affected team", () => {
    expect(
      resolveRecipients({
        visibility: "private",
        members,
        affectedTeamId: TEAM,
        actorUserId: null,
      }),
    ).toEqual([OWNER]);
  });

  it("falls back to the actor when a private event names no team", () => {
    expect(
      resolveRecipients({
        visibility: "private",
        members,
        affectedTeamId: null,
        actorUserId: MANAGER,
      }),
    ).toEqual([MANAGER]);
  });

  it("never invents a recipient for an unclaimed team or an unknown actor", () => {
    expect(
      resolveRecipients({
        visibility: "private",
        members,
        affectedTeamId: "30000000-0000-4000-8000-0000000000ff",
        actorUserId: null,
      }),
    ).toEqual([]);
  });

  it("writes no receipts for a global event", () => {
    expect(
      resolveRecipients({
        visibility: "global",
        members,
        affectedTeamId: TEAM,
        actorUserId: OWNER,
      }),
    ).toEqual([]);
  });

  it("de-duplicates a member listed twice", () => {
    expect(
      resolveRecipients({
        visibility: "league",
        members: [...members, { userId: OWNER, claimedFantasyTeamId: TEAM }],
        affectedTeamId: null,
        actorUserId: null,
      }),
    ).toEqual([OWNER, MANAGER, VIEWER]);
  });
});
