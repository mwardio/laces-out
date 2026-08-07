import { PortfolioDashboard } from "@laces-out/web";
import { type ReactNode } from "react";

/* The dashboard owns its own filter/expand/reviewed state and reads the demo
   portfolio fixture directly, so `afterOverview` is its only prop — a slot
   rendered under the decision inbox, above the provider connections. The two
   cells are the surface without the slot and the surface with it filled the
   way the product fills it (the signed-out dashboard drops the AI coaching
   tour in there).

   Both sit on --paper-100: the dashboard is a stack of white panels, and on
   the card's bare white body the gaps between them read as one flat sheet. */

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: "var(--paper-100)", padding: "16px 24px 40px" }}>{children}</div>
  );
}

/* Slot content built from the same global classes the dashboard's own panels
   use, so it inherits the surface rather than inventing a second look. */
function CoachingTour() {
  return (
    <section className="panel" aria-labelledby="coach-tour-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">AI coaching tour</p>
          <h2 id="coach-tour-title">See how the second read works</h2>
          <p>
            Every sample starts with the league engine&rsquo;s board, then explains what is worth
            doing this week and what is not.
          </p>
        </div>
        <span className="status-chip status-chip--demo">Demo</span>
      </div>
      <div className="mini-metrics">
        <div>
          <span>Weekly brief</span>
          <strong>Lake Effect Legends</strong>
        </div>
        <div>
          <span>Start / sit</span>
          <strong>Johnston or Evans, FLEX</strong>
        </div>
        <div>
          <span>Waiver scan</span>
          <strong>$83 median FAAB</strong>
        </div>
        <div>
          <span>Trade builder</span>
          <strong>Two-for-one, RB floor held</strong>
        </div>
      </div>
      <div className="panel-footnote">
        Sample answers only. Nothing here is sent to a provider until you connect a league.
      </div>
    </section>
  );
}

export function LeagueOverview() {
  return (
    <PageFrame>
      <PortfolioDashboard />
    </PageFrame>
  );
}

export function WithCoachingTour() {
  return (
    <PageFrame>
      <PortfolioDashboard afterOverview={<CoachingTour />} />
    </PageFrame>
  );
}
