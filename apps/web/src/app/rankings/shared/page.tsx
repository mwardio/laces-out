import type { Metadata } from "next";

import { AppShell } from "../../../components/app-shell";
import { SharedRankingViewer } from "../../../components/shared-ranking-viewer";

export const metadata: Metadata = {
  title: "Shared Rankings",
  description: "A private, access-key-protected Laces Out ranking board.",
  robots: { index: false, follow: false },
};

export default function SharedRankingsPage() {
  return (
    <AppShell
      active="rankings"
      context={{ label: "Private share", detail: "Access-key protected", tone: "setup" }}
      showDemoChip={false}
    >
      <SharedRankingViewer />
    </AppShell>
  );
}
