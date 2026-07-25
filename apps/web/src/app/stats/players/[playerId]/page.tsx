import type { Metadata } from "next";

import { AppShell } from "../../../../components/app-shell";
import { PlayerProfile } from "../../../../components/player-profile";

export const metadata: Metadata = {
  title: "Player profile",
  description:
    "One player's week-by-week game log, window metrics, and recent trend from admitted source files.",
  robots: { index: false, follow: false },
};

export default async function PlayerProfilePage({
  params,
}: {
  readonly params: Promise<{ readonly playerId: string }>;
}) {
  const { playerId } = await params;
  return (
    <AppShell
      active="stats"
      showDemoChip={false}
      context={{ label: "Player profile", detail: "Game log + window metrics", tone: "setup" }}
    >
      <PlayerProfile playerId={playerId} />
    </AppShell>
  );
}
