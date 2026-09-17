import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineupPlayerStatus } from "./lineup-player-status";

describe("lineup player availability", () => {
  it.each(["QUESTIONABLE", "OUT", "DOUBTFUL", "IR", "PUP", "SUSPENDED", "NA"] as const)(
    "renders the actual %s caution without a probability",
    (status) => {
      const html = renderToStaticMarkup(createElement(LineupPlayerStatus, { status }));
      expect(html).toContain("Player availability:");
      expect(html).not.toMatch(/confidence|%/);
      if (status === "QUESTIONABLE") expect(html).toContain("Questionable");
      if (status === "OUT") expect(html).toContain("Out");
    },
  );
  it.each([null, "ACTIVE", "UNKNOWN"] as const)(
    "does not invent a warning or clearance for %s",
    (status) => {
      expect(renderToStaticMarkup(createElement(LineupPlayerStatus, { status }))).toBe("");
    },
  );
});
