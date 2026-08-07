import { DraftWorkspace } from "@laces-out/web";
import { useEffect, useRef, type ReactNode } from "react";

/* The draft studio takes no props — it owns the whole board (format, search,
   position filter, selection, queue, budgets, event ledger) internally. So the
   cells here are framings, not prop sweeps.

   Auction vs Snake is the component's real variant axis: it swaps the room
   strip, two columns of the player table, and the entire recommendation rail
   (price ladder + value meter + bid entry becomes an availability ring +
   ADP comparison). The only way in is the component's own format switch, so
   SnakeBoard drives that control instead of faking the markup — the cell
   exercises selectMode, the same path a manager clicking "Snake" would take.

   Both cells sit on the app's page background. Every surface in the studio is
   white or ink over --paper-100; on the card's bare white body the page
   structure between the panels disappears. */

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: "var(--paper-100)", padding: "16px 24px 40px" }}>{children}</div>
  );
}

function SnakeFormat() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const group = host.current?.querySelector('[aria-label="Draft format"]');
    const snake = Array.from(group?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Snake",
    );
    if (snake && snake.getAttribute("aria-pressed") !== "true") snake.click();
  }, []);

  return (
    // display:contents so the query host adds no box of its own — the draft
    // page keeps the exact grid parent it has in the product.
    <div ref={host} style={{ display: "contents" }}>
      <DraftWorkspace />
    </div>
  );
}

export function AuctionBoard() {
  return (
    <PageFrame>
      <DraftWorkspace />
    </PageFrame>
  );
}

export function SnakeBoard() {
  return (
    <PageFrame>
      <SnakeFormat />
    </PageFrame>
  );
}
