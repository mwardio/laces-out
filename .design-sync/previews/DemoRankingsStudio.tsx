import { DemoRankingsStudio } from "@laces-out/web";

/* The signed-out Rankings Studio tour. It takes no props and ships its own
   board fixture (the first twelve players of the demo draft set), and every
   control inside it is deliberately inert, so there is exactly one honest
   thing to photograph: the whole surface, on the page background it lives on
   in the product. A second cell would be the same pixels twice. */

export function RankingsStudioTour() {
  return (
    <div style={{ background: "var(--paper-100)", padding: "16px 24px 40px" }}>
      <DemoRankingsStudio />
    </div>
  );
}
