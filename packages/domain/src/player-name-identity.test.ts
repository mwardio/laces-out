import { describe, expect, it } from "vitest";

import {
  PLAYER_NAME_IDENTITY_POLICY_VERSION,
  playerNameIdentitiesCompatible,
  playerNameIdentityParts,
} from "./player-name-identity.js";

const compatible = (left: string, right: string) =>
  playerNameIdentitiesCompatible(playerNameIdentityParts(left), playerNameIdentityParts(right));

describe("conservative player-name identity", () => {
  it("exposes a policy version for publication input checksums", () => {
    expect(PLAYER_NAME_IDENTITY_POLICY_VERSION).toBe("player-name-identity-v1");
  });

  it.each([
    ["James Cook III", "James Cook", "iii"],
    ["KC Concepcion Jr.", "KC Concepcion", "jr"],
    ["Travis Etienne Jr.", "Travis Etienne", "jr"],
    ["Kyle Pitts Sr.", "Kyle Pitts", "sr"],
  ])(
    "describes the observed suffix variant %s without changing its exact name",
    (full, base, suffix) => {
      expect(playerNameIdentityParts(full)).toEqual({
        exact: full.toLocaleLowerCase("en-US"),
        base: base.toLocaleLowerCase("en-US"),
        suffix,
      });
      expect(compatible(full, base)).toBe(true);
      expect(compatible(base, full)).toBe(true);
    },
  );

  it("retains NFKC, outer trimming, and case normalization", () => {
    expect(playerNameIdentityParts("  ＫＣ Ｃｏｎｃｅｐｃｉｏｎ\u00a0Ｊｒ．  ")).toEqual({
      exact: "kc concepcion jr.",
      base: "kc concepcion",
      suffix: "jr",
    });
    expect(compatible("ＫＣ Ｃｏｎｃｅｐｃｉｏｎ Ｊｒ．", "KC Concepcion")).toBe(true);
    expect(compatible(" Jose\u0301 Player ", "JOSÉ PLAYER")).toBe(true);
  });

  it.each(["Jr", "Sr", "II", "III", "IV", "V"])(
    "allows the optional terminal suffix period for %s",
    (suffix) => {
      expect(compatible(`Example Player ${suffix}`, `Example Player ${suffix}.`)).toBe(true);
      expect(compatible(`Example Player ${suffix}.`, "Example Player")).toBe(true);
    },
  );

  it.each([
    ["Jr.", "Sr."],
    ["II", "III"],
    ["III", "IV"],
    ["IV", "V"],
  ])("does not erase the conflict between %s and %s", (left, right) => {
    expect(compatible(`Example Player ${left}`, `Example Player ${right}`)).toBe(false);
    expect(compatible(`Example Player ${right}`, `Example Player ${left}`)).toBe(false);
  });

  it.each(["Jr. Smith", "John Sr. Smith", "James III Cook", "Iver Player", "Example Player Jr.."])(
    "does not remove middle words or partial suffixes from %s",
    (name) => {
      const exact = name.toLocaleLowerCase("en-US");
      expect(playerNameIdentityParts(name)).toEqual({ exact, base: exact, suffix: null });
    },
  );

  it.each([
    ["José Player Jr.", "Jose Player"],
    ["A.J. Receiver Jr.", "AJ Receiver"],
    ["D'Andre Player Jr.", "DAndre Player"],
    ["Jean-Paul Player Jr.", "Jean Paul Player"],
    ["Example  Player Jr.", "Example Player"],
    ["Example Player, Jr.", "Example Player"],
    ["Example Player\tJr.", "Example Player"],
    ["Different Player Jr.", "Example Player"],
  ])("does not broaden %s into %s", (left, right) => {
    expect(compatible(left, right)).toBe(false);
  });

  it.each(["", " ", "\t\n"])("does not match empty input %j", (name) => {
    expect(compatible(name, name)).toBe(false);
    expect(compatible(name, "Example Player")).toBe(false);
  });

  it("leaves base-name collision rejection to the caller instead of choosing a suffix", () => {
    const roster = playerNameIdentityParts("Example Player");
    const candidates = ["Example Player Jr.", "Example Player Sr."].map(playerNameIdentityParts);
    // Both spellings fit an omitted suffix. A caller must reject this two-candidate cohort;
    // the pure compatibility predicate cannot turn spelling compatibility into identity proof.
    expect(
      candidates.map((candidate) => playerNameIdentitiesCompatible(roster, candidate)),
    ).toEqual([true, true]);
    expect(new Set(candidates.map((candidate) => candidate.base)).size).toBe(1);
  });
});
