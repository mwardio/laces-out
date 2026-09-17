import type { DecisionPlayer } from "@laces-out/contracts";
import { createElement } from "react";

const labels = {
  QUESTIONABLE: "Questionable",
  DOUBTFUL: "Doubtful",
  OUT: "Out",
  IR: "Injured reserve",
  PUP: "Physically unable to perform",
  SUSPENDED: "Suspended",
  NA: "Inactive",
} as const;

export function LineupPlayerStatus({ status }: { readonly status: DecisionPlayer["status"] }) {
  if (status === null || status === "ACTIVE" || status === "UNKNOWN") return null;
  return createElement(
    "small",
    { "aria-label": `Player availability: ${labels[status]}` },
    ` · ${labels[status]}`,
  );
}
