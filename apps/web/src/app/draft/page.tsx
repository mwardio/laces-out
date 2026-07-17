import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { DraftSessionWorkspace } from "../../components/draft-session-workspace";

export const metadata: Metadata = {
  title: "Draft Studio | Laces Out",
  description: "Persistent manual auction and snake draft rooms for synchronized leagues.",
};

export default function DraftPage() {
  return (
    <AppShell active="draft" compact>
      <DraftSessionWorkspace />
    </AppShell>
  );
}
