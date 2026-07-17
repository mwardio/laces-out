import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { DecisionWorkbench } from "../../components/decision-workbench";

export const metadata: Metadata = {
  title: "Decision Desk",
  description: "Projection-backed lineup, waiver, and trade analysis for synchronized leagues.",
};

export default function DecisionsPage() {
  return (
    <AppShell
      active="decisions"
      context={{ label: "Decision Desk", detail: "Read-only provider handoff", tone: "setup" }}
    >
      <DecisionWorkbench />
    </AppShell>
  );
}
