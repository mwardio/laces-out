import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ProjectionImportWorkbench } from "../../components/projection-import-workbench";

export const metadata: Metadata = {
  title: "Projection Lab",
  description: "Import private or league-shared weekly projections with strict player matching.",
};

export default function ProjectionsPage() {
  return (
    <AppShell
      active="projections"
      context={{ label: "Projection Lab", detail: "Private by default", tone: "setup" }}
    >
      <ProjectionImportWorkbench />
    </AppShell>
  );
}
