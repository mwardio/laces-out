import { describe, expect, it } from "vitest";

import { rosHistoryCatalogRolesChecksum } from "./ros-history-catalog-checksum.js";

describe("live ROS historical catalog roles", () => {
  it("changes identity for historical roles even when the current fantasy role is unchanged", () => {
    const history = [{ playerId: "retired-player", position: "WR" }];
    expect(rosHistoryCatalogRolesChecksum(history)).not.toBe(
      rosHistoryCatalogRolesChecksum([{ playerId: "retired-player", position: "RB" }]),
    );
    expect(rosHistoryCatalogRolesChecksum(history)).not.toBe(
      rosHistoryCatalogRolesChecksum([{ playerId: "another-player", position: "WR" }]),
    );
  });

  it("ignores database row order, repeated weeks, and unused catalog touch metadata", () => {
    const first = { playerId: "a", position: "WR", updatedAt: "2030-01-01" };
    const second = { playerId: "b", position: "TE", updatedAt: "2030-01-01" };
    expect(rosHistoryCatalogRolesChecksum([first, second])).toBe(
      rosHistoryCatalogRolesChecksum([second, { ...first, updatedAt: "2031-02-02" }, first]),
    );
  });
});
