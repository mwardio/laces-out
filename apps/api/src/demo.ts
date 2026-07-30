import { dashboardSnapshotSchema, type DashboardSnapshot } from "@fantasy/contracts";

const generatedAt = new Date().toISOString();

const demoDashboard: DashboardSnapshot = {
  generatedAt,
  season: 2026,
  week: null,
  mode: "demo",
  connections: [
    {
      id: "yahoo-demo",
      provider: "yahoo",
      label: "Yahoo Fantasy",
      health: "healthy",
      official: true,
      mode: "OAuth 2 + read-only API",
      readOnly: true,
      lastSuccessfulAt: generatedAt,
      message: "Official read-only league sync through Yahoo authorization.",
    },
    {
      id: "espn-demo",
      provider: "espn",
      label: "ESPN Fantasy",
      health: "disabled",
      official: false,
      mode: "One-click / automatic sync",
      readOnly: true,
      lastSuccessfulAt: null,
      message: "Private leagues sync from the ESPN session already open in the user's browser.",
    },
  ],
  notices: [
    "Demo data is clearly isolated from synced league state.",
    "Provider writes remain disabled until authorization and shadow validation are complete.",
  ],
  leagues: [
    {
      id: "demo-auction",
      name: "Lakeview Auction",
      provider: "yahoo",
      season: 2026,
      draftType: "auction",
      scoringLabel: "12 team · Half PPR · $200",
      record: null,
      standing: null,
      userTeamName: "Fourth & Long",
      opponentName: null,
      projectedFor: null,
      projectedAgainst: null,
      sync: { state: "missing", observedAt: null, label: "Demo snapshot" },
      demo: true,
      actions: [
        {
          id: "auction-plan",
          kind: "draft",
          priority: "high",
          title: "Finish auction budget plan",
          summary: "Allocate $167 of flexible spend across 7 starting skill slots.",
          valueLabel: "$33 reserve",
          href: "/draft",
        },
      ],
    },
    {
      id: "demo-snake",
      name: "Sunday Society",
      provider: "espn",
      season: 2026,
      draftType: "snake",
      scoringLabel: "10 team · Full PPR · Pick 7",
      record: null,
      standing: null,
      userTeamName: "Red Zone Theory",
      opponentName: null,
      projectedFor: null,
      projectedAgainst: null,
      sync: { state: "missing", observedAt: null, label: "Connection not configured" },
      demo: true,
      actions: [
        {
          id: "espn-connect",
          kind: "connection",
          priority: "medium",
          title: "Connect ESPN",
          summary:
            "Use one-click sync or the automatic Chrome companion without sharing credentials.",
          valueLabel: null,
          href: "/connections",
        },
      ],
    },
  ],
};

export function getDemoDashboard(): DashboardSnapshot {
  return dashboardSnapshotSchema.parse({ ...demoDashboard, generatedAt: new Date().toISOString() });
}
