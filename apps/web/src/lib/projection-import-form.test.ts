import { describe, expect, it } from "vitest";

import {
  LEAGUE_PROJECTION_IMPORT_HORIZON,
  localDateTimeMinuteValue,
  projectionSourceAsOfText,
  sourceObservedAtIso,
} from "./projection-import-form.js";

describe("projection import form provenance", () => {
  it("keeps the public league import scope weekly", () => {
    expect(LEAGUE_PROJECTION_IMPORT_HORIZON).toBe("week");
  });

  it("converts a valid browser-local datetime to an exact UTC instant", () => {
    const input = "2026-09-10T12:34";
    const result = sourceObservedAtIso(input);
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBe(new Date(2026, 8, 10, 12, 34).getTime());
    expect(localDateTimeMinuteValue(new Date(result!))).toBe(input);
  });

  it.each(["", "not-a-date", "2026-02-29T12:00", "2026-09-10 12:00"])(
    "rejects invalid local source time %s",
    (value) => {
      expect(sourceObservedAtIso(value)).toBeNull();
    },
  );

  it("labels legacy timing as unverified without formatting the stored fallback", () => {
    expect(
      projectionSourceAsOfText(
        { sourceObservedAt: null, sourceObservedAtStatus: "unverified" },
        () => "must not be called",
      ),
    ).toBe("Missing / unverified");
    expect(
      projectionSourceAsOfText(
        {
          sourceObservedAt: "2026-09-10T12:00:00.000Z",
          sourceObservedAtStatus: "verified",
        },
        (value) => `formatted:${value}`,
      ),
    ).toBe("formatted:2026-09-10T12:00:00.000Z");
  });
});
