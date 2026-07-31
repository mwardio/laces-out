import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { SettingsPanel } from "../../components/settings-panel";

export const metadata: Metadata = {
  title: "Settings",
  description:
    "Manage your password, leagues, notifications, portable data export, and account deletion.",
  robots: { index: false, follow: false },
};

export default function SettingsPage() {
  return (
    <AppShell
      active="settings"
      showDemoChip={false}
      context={{ label: "Settings", detail: "Account + preferences", tone: "setup" }}
    >
      <SettingsPanel />
    </AppShell>
  );
}
