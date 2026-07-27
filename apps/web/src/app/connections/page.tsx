import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ConnectionWorkbench } from "../../components/connection-workbench";
import { yahooComingSoon } from "../../lib/public-site";

export const metadata: Metadata = {
  title: "League Sync",
  description: yahooComingSoon
    ? "Configure ESPN fantasy sync now, with Yahoo league sync coming soon."
    : "Configure read-only Yahoo and ESPN fantasy league connection paths.",
};

export default function ConnectionsPage() {
  return (
    <AppShell
      active="connections"
      context={{
        label: "League Sync",
        detail: yahooComingSoon ? "ESPN ready · Yahoo coming soon" : "Yahoo + ESPN setup",
        tone: "setup",
      }}
    >
      <ConnectionWorkbench />
    </AppShell>
  );
}
