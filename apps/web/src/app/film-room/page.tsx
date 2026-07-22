import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { FilmRoomWorkbench } from "../../components/film-room-workbench";

export const metadata: Metadata = {
  title: "Film Room",
  description:
    "Private, league-grounded AI analysis with included Gemini and optional personal provider keys.",
};

export default function FilmRoomPage() {
  return (
    <AppShell
      active="ai"
      context={{ label: "Film Room", detail: "Included Gemini · Optional BYOK", tone: "setup" }}
    >
      <FilmRoomWorkbench />
    </AppShell>
  );
}
