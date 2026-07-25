import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ScheduleBoard } from "../../components/schedule-board";

export const metadata: Metadata = {
  title: "Schedule",
  description: "NFL matchups, kickoffs, and bye weeks from the admitted schedule artifact.",
  robots: { index: false, follow: false },
};

export default function SchedulePage() {
  return (
    <AppShell
      active="schedule"
      showDemoChip={false}
      context={{ label: "Schedule", detail: "Matchups + byes", tone: "setup" }}
    >
      <ScheduleBoard />
    </AppShell>
  );
}
