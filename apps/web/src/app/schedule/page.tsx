import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ScheduleEdgeWorkbench } from "../../components/schedule-edge-workbench";

export const metadata: Metadata = {
  title: "Schedule Edge",
  description:
    "Roster-aware matchup windows, bye pressure, playoff paths, and the official NFL schedule.",
  robots: { index: false, follow: false },
};

export default function SchedulePage() {
  return (
    <AppShell
      active="schedule"
      context={{ label: "Schedule Edge", detail: "Roster + bye outlook", tone: "setup" }}
    >
      <ScheduleEdgeWorkbench />
    </AppShell>
  );
}
