import { describe, expect, it } from "vitest";

import { leagueAccessRoleSchema, leagueMembershipRoleSchema } from "./index.js";

describe("public league access roles", () => {
  it.each(["member", "commissioner"] as const)("accepts %s", (role) => {
    expect(leagueAccessRoleSchema.parse(role)).toBe(role);
    expect(leagueMembershipRoleSchema.parse(role)).toBe(role);
  });

  it.each(["owner", "manager", "viewer"] as const)("rejects internal or legacy role %s", (role) => {
    expect(leagueAccessRoleSchema.safeParse(role).success).toBe(false);
    expect(leagueMembershipRoleSchema.safeParse(role).success).toBe(false);
  });
});
