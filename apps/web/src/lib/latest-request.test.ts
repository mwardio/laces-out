import { describe, expect, it } from "vitest";

import { LatestRequest } from "./latest-request";

describe("LatestRequest", () => {
  it("accepts only the newest request for the active key", () => {
    const gate = new LatestRequest();
    const first = gate.begin("league-a");
    const second = gate.begin("league-a");

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("rejects a response after its content or context is replaced", () => {
    const gate = new LatestRequest();
    const oldContent = gate.begin('{"league":"a"}');
    const newContent = gate.begin('{"league":"b"}');

    expect(gate.isCurrent(oldContent)).toBe(false);
    expect(gate.isCurrent(newContent)).toBe(true);
  });

  it("rejects an in-flight response after explicit invalidation", () => {
    const gate = new LatestRequest();
    const request = gate.begin("board-a:version-1");

    gate.invalidate();

    expect(gate.isCurrent(request)).toBe(false);
  });
});
