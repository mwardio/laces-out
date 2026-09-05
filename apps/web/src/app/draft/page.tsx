import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { DraftSessionWorkspace } from "../../components/draft-session-workspace";

export const metadata: Metadata = {
  title: "Draft Studio",
  description:
    "Shared manual auction and snake draft rooms, with optional read-only Yahoo-assisted checks.",
};

export default function DraftPage() {
  return (
    <AppShell active="draft" compact>
      <DraftSessionWorkspace />
    </AppShell>
  );
}
