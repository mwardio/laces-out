import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { DashboardExperience } from "../../components/dashboard-experience";

export const metadata: Metadata = {
  title: "Overview",
  description: "Your league-aware Laces Out fantasy football locker room.",
  robots: { index: false, follow: false },
};

export default function PortfolioPage() {
  return (
    <AppShell active="dashboard">
      <DashboardExperience />
    </AppShell>
  );
}
