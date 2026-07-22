import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { StatsCenterWorkbench } from "../../components/stats-center-workbench";

export const metadata: Metadata = {
  title: "Stats Center",
  description:
    "Player opportunity, target share, and snap participation from admitted source files.",
  robots: { index: false, follow: false },
};

export default function StatsPage() {
  return (
    <AppShell
      active="stats"
      context={{
        label: "Stats Center",
        detail: "Opportunity + participation",
        tone: "setup",
      }}
    >
      <StatsCenterWorkbench />
    </AppShell>
  );
}
