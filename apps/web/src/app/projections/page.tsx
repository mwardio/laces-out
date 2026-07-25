import type { Metadata } from "next";

import { AppShell } from "../../components/app-shell";
import { ProjectionImportWorkbench } from "../../components/projection-import-workbench";
import { RosProjectionLabPanel } from "../../components/ros-projection-lab-panel";

export const metadata: Metadata = {
  title: "Projection Lab",
  description:
    "Browse league-scored weekly and rest-of-season player forecasts, or import private and league-shared projections.",
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
