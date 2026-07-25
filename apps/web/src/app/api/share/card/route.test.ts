import { describe, expect, it } from "vitest";

import { POST } from "./route";

const payload = {
  leagueName: "North Loop Auction",
  week: 5,
  sample: true,
  awards: [
    {
      label: "Bad Beat of the Week",
      teamName: "Budget Ballers",
      initials: "BB",
      value: "78%",
      caption: "Outscored 7 of 9 teams and still lost, 128.4–131.2.",
    },
    {
      label: "Beatdown of the Week",
      teamName: "Sunday Scaries",
      initials: "SUN",
      value: "36.3 pts",
      caption: "Beat Waiver Theory 107.9–71.6.",
    },
  ],
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/share/card", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

describe("share card route", () => {
  it("renders a PNG for a same-origin request", async () => {
    const response = await POST(request(payload));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    // PNG magic number, proving the renderer produced a real image rather than an error body.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 30_000);

  it("refuses a cross-origin caller so the renderer is not a general-purpose image service", async () => {
    const response = await POST(
      request(payload, { "sec-fetch-site": "cross-site", origin: "https://example.com" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses same-site and headerless callers while allowing an exact origin fallback", async () => {
    expect(
      (
        await POST(
          request(payload, {
            "sec-fetch-site": "same-site",
            origin: "http://dashboard.localhost:3000",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/share/card", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/share/card", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:3000" },
            body: JSON.stringify(payload),
          }),
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  it("rejects a payload the card contract does not allow", async () => {
    const response = await POST(request({ ...payload, awards: [] }));
    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/share/card", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});
