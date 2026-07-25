import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { SettingsPanel } from "../../components/settings-panel";

export const metadata: Metadata = {
  title: "Settings",
  description: "Change your own password and choose the league the locker room opens first.",
  robots: { index: false, follow: false },
};

export default function SettingsPage() {
  return (
    <AppShell
      active="settings"
      showDemoChip={false}
      context={{ label: "Settings", detail: "Password + default league", tone: "setup" }}
    >
      <SettingsPanel />
    </AppShell>
  );
}
