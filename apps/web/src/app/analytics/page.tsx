import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { LeagueAnalyticsWorkbench } from "../../components/league-analytics-workbench";

export const metadata: Metadata = {
  title: "League Analytics",
  description:
    "Official-score season analytics, transparent power rankings, positional strengths, and opponent scouting.",
};

export default function AnalyticsPage() {
  return (
    <AppShell
      active="analytics"
      context={{
        label: "League Analytics",
        detail: "Official scores + private context",
        tone: "setup",
      }}
    >
      <LeagueAnalyticsWorkbench />
    </AppShell>
  );
}
