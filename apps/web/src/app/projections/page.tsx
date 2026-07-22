import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ProjectionImportWorkbench } from "../../components/projection-import-workbench";
import { RosProjectionLabPanel } from "../../components/ros-projection-lab-panel";

export const metadata: Metadata = {
  title: "Projection Lab",
  description:
    "Review Laces Out weekly forecasts and import private or league-shared projections with strict player matching.",
};

export default function ProjectionsPage() {
  return (
    <AppShell
      active="projections"
      context={{ label: "Projection Lab", detail: "Managed + custom", tone: "setup" }}
    >
      <ProjectionImportWorkbench />
      <RosProjectionLabPanel />
    </AppShell>
  );
}
