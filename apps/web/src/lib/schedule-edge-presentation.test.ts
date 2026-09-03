import { describe, expect, it } from "vitest";

import { scheduleEdgeEvidenceUseLabel } from "./schedule-edge-presentation.js";

describe("Schedule Edge presentation", () => {
  it("presents descriptive evidence neutrally in the overview", () => {
    expect(scheduleEdgeEvidenceUseLabel("descriptive-only")).toBe("Historical context");
  });

  it("keeps the other evidence states explicit", () => {
    expect(scheduleEdgeEvidenceUseLabel("validated")).toBe("Validated");
    expect(scheduleEdgeEvidenceUseLabel("withheld")).toBe("Withheld");
  });
});
