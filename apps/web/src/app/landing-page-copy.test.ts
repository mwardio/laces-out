import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const styleSource = readFileSync(
  fileURLToPath(new URL("./landing-page.module.css", import.meta.url)),
  "utf8",
);

describe("landing-page first-time-user copy", () => {
  it("defines the product and league-specific benefit before asking for a connection", () => {
    expect(pageSource).toContain("Your fantasy football companion");
    expect(pageSource).toContain("Connect your leagues.");
    expect(pageSource).toContain("Get the next move.");
    expect(pageSource).toContain("Laces Out pairs with your");
    expect(pageSource).toContain("Bring in the leagues you already play.");
    expect(pageSource).toContain("You maintain full control.");
    expect(pageSource).toContain("your league&rsquo;s scoring");
    expect(pageSource).toMatch(/the players\s+available to you/u);
  });

  it("offers one free-account CTA and a clearly scoped no-account demo", () => {
    expect(pageSource.match(/Create a free account/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(pageSource).toContain("Explore the demo");
    expect(pageSource).toContain("No account or league connection required.");
    expect(pageSource).not.toContain("ESPN now");
    expect(pageSource).not.toContain("Yahoo available");
  });

  it("states the read-only action boundary and avoids unsupported sync promises", () => {
    expect(pageSource).toContain("Laces Out recommends the move. You make");
    expect(pageSource).toContain("Recommendations only—no ESPN roster edits");
    expect(pageSource).not.toContain("You approve every provider-side move");
    expect(pageSource).not.toContain("Automatic sync");
    expect(pageSource).not.toContain("Refreshes within five minutes");
  });

  it("labels illustrative outputs, draft modes, optional AI, and scoped evidence", () => {
    expect(pageSource).toContain("Illustrative league · Week 8");
    expect(pageSource).toContain("Projected Week 8 gain");
    expect(pageSource).toMatch(/Shared rooms with manual pick and bid\s+tracking/u);
    expect(pageSource).toContain("The core app works without AI");
    expect(pageSource).toContain("Tested against completed NFL seasons.");
    expect(pageSource).not.toContain("3K+");
    expect(pageSource).not.toContain("12K+");
  });

  it("answers adoption questions and retains usable compact navigation", () => {
    expect(pageSource).toContain("Do my commissioner or league mates need to join?");
    expect(pageSource).toContain("Do I need to install or host a server?");
    expect(pageSource).toContain("Which scoring rules and league formats work?");
    expect(pageSource).toContain("Is AI required, and what does it receive?");
    expect(pageSource).toContain('<a href="#in-season">Decisions</a>');
    expect(pageSource).toContain('<a href="#league-fun">Recaps</a>');
    expect(styleSource).toContain(".mobileNav");
    expect(styleSource).toContain("@media (max-width: 420px)");
    expect(styleSource).not.toMatch(/\.signInButton\s*\{\s*display:\s*none;/u);
  });
});
