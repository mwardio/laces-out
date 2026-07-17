import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { RankingsStudio } from "../../components/rankings-studio";

export const metadata: Metadata = {
  title: "Rankings Studio",
  description: "Create, import, version, publish, export, and share custom fantasy rankings.",
};

export default function RankingsPage() {
  return (
    <AppShell
      active="rankings"
      context={{ label: "Rankings Studio", detail: "Revisions · source details", tone: "setup" }}
    >
      <RankingsStudio />
    </AppShell>
  );
}
