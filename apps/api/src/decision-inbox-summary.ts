import { createHash } from "node:crypto";

import type {
  DecisionInboxItem,
  DecisionInboxKind,
  DecisionInboxResponse,
  DecisionInboxSection,
  DecisionPlayer,
  InSeasonDecisionSnapshot,
  TradeDecisionSection,
} from "@laces-out/contracts";

type TradePackage = Extract<TradeDecisionSection, { state: "available" }>["bestForMe"][number];

const INBOX_SUMMARY_VERSION = "decision-inbox-v1";

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function playerIdentity(player: DecisionPlayer | null) {
  return player
    ? { id: player.id, projectedPoints: player.projectedPoints, status: player.status }
    : null;
}

function playersIdentity(players: readonly DecisionPlayer[]) {
  return [...players].sort((left, right) => left.id.localeCompare(right.id)).map(playerIdentity);
}

/**
 * Review state belongs to advice, not a cache refresh. The snapshot checksum and observation times
 * can change because an unrelated opponent synced. Keep the actual decision context and actionable
 * values here so a revised projection, slot plan, bid or forced drop produces a new review item.
 */
function itemIdentity(
  snapshot: InSeasonDecisionSnapshot,
  kind: DecisionInboxKind,
  advice: unknown,
): string {
  const projection = snapshot.provenance.projectionSet;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: INBOX_SUMMARY_VERSION,
        algorithmVersion: snapshot.provenance.algorithmVersion,
        leagueId: snapshot.league.id,
        provider: snapshot.league.provider,
        season: snapshot.league.season,
        week: snapshot.league.week,
        teamId: snapshot.team?.id ?? null,
        projection: projection
          ? { id: projection.id, version: projection.version, horizon: projection.horizon }
          : null,
        kind,
        advice,
      }),
    )
    .digest("hex");
}

function sectionSummary(
  kind: DecisionInboxKind,
  section: InSeasonDecisionSnapshot["lineup" | "waivers" | "trades"],
): DecisionInboxSection {
  return section.state === "unavailable"
    ? { kind, state: "unavailable", reasons: section.reasons.map((reason) => ({ ...reason })) }
    : { kind, state: "available", reasons: [] };
}

function tradeKey(trade: TradePackage): string {
  return JSON.stringify([
    trade.partner.id,
    trade.send.map((player) => player.id).sort(),
    trade.receive.map((player) => player.id).sort(),
  ]);
}

/** Pure, bounded projection of the existing authorized Decision Desk snapshot. */
export function buildDecisionInboxSummary(
  snapshot: InSeasonDecisionSnapshot,
): DecisionInboxResponse {
  const items: DecisionInboxItem[] = [];
  const sections: DecisionInboxSection[] = [
    sectionSummary("lineup", snapshot.lineup),
    sectionSummary("waiver", snapshot.waivers),
    sectionSummary("trade", snapshot.trades),
  ];
  const href = (section: "lineup" | "waivers" | "trades") =>
    `/decisions?league=${snapshot.league.id}#decision-${section}`;
  const actionWarning = snapshot.providerVerification.actionWarning;
  const { lineup, waivers, trades } = snapshot;

  if (lineup.state === "available" && !lineup.feasible) {
    sections[0] = {
      kind: "lineup",
      state: "unavailable",
      reasons: [
        { code: "ENGINE_INFEASIBLE", message: "No complete legal starting lineup was found." },
      ],
    };
  }

  if (
    lineup.state === "available" &&
    lineup.feasible &&
    lineup.projectedGain > 0 &&
    lineup.changes.length > 0
  ) {
    const changes = [...lineup.changes].sort((left, right) =>
      left.slotId.localeCompare(right.slotId),
    );
    const onlyChange = changes.length === 1 ? changes[0] : undefined;
    const title = onlyChange?.add
      ? onlyChange.remove
        ? `Start ${onlyChange.add.name} over ${onlyChange.remove.name}`
        : `Start ${onlyChange.add.name} in ${onlyChange.slotLabel}`
      : "Improve your starting lineup";
    items.push({
      id: itemIdentity(snapshot, "lineup", {
        projectedGain: lineup.projectedGain,
        currentProjectedPoints: lineup.currentProjectedPoints,
        optimalProjectedPoints: lineup.optimalProjectedPoints,
        assignments: [...lineup.assignments]
          .sort((left, right) => left.slotId.localeCompare(right.slotId))
          .map((assignment) => ({
            slotId: assignment.slotId,
            player: playerIdentity(assignment.player),
            locked: assignment.locked,
          })),
        changes: changes.map((change) => ({
          slotId: change.slotId,
          remove: playerIdentity(change.remove),
          add: playerIdentity(change.add),
          projectedPointDelta: change.projectedPointDelta,
        })),
      }),
      kind: "lineup",
      title,
      summary: `${changes.length} slot ${changes.length === 1 ? "change improves" : "changes together improve"} the projected starting lineup from ${lineup.currentProjectedPoints.toFixed(2)} to ${lineup.optimalProjectedPoints.toFixed(2)} points.`,
      detail: [
        "Review the complete lineup plan together; individual slot changes can depend on each other.",
        ...changes.map(
          (change) =>
            `${change.slotLabel}: ${change.add ? `start ${change.add.name}` : "leave empty"}${change.remove ? ` in place of ${change.remove.name}` : ""} (${signed(change.projectedPointDelta)} projected points).`,
        ),
        ...lineup.notes.filter(Boolean),
        actionWarning,
      ],
      impact: {
        label: `${signed(lineup.projectedGain)} projected points`,
        value: lineup.projectedGain,
      },
      href: href("lineup"),
      state: "open",
    });
  }

  if (waivers.state === "available") {
    const seenTargets = new Set<string>();
    const recommendations = [...waivers.recommendations]
      .filter((move) => move.weightedGain > 0 && move.add.id !== move.drop.id)
      .sort(
        (left, right) =>
          right.weightedGain - left.weightedGain ||
          right.lineupGain - left.lineupGain ||
          left.add.id.localeCompare(right.add.id) ||
          left.drop.id.localeCompare(right.drop.id),
      )
      .filter((move) => {
        if (seenTargets.has(move.add.id)) return false;
        seenTargets.add(move.add.id);
        return true;
      })
      .slice(0, 3);
    for (const move of recommendations) {
      items.push({
        id: itemIdentity(snapshot, "waiver", {
          add: playerIdentity(move.add),
          drop: playerIdentity(move.drop),
          weightedGain: move.weightedGain,
          lineupGain: move.lineupGain,
          faab: move.faab,
        }),
        kind: "waiver",
        title: `Add ${move.add.name}, drop ${move.drop.name}`,
        summary: "An alternative add/drop for your current roster; evaluate one move at a time.",
        detail: [
          move.rationale,
          `Projected starting lineup change: ${signed(move.lineupGain)} points. Modeled roster value also accounts for bench depth.`,
          ...(move.faab
            ? [
                `Suggested FAAB: $${move.faab.low}–$${move.faab.high} ($${move.faab.recommended} recommended). This is budget guidance, not a bid guarantee.`,
              ]
            : []),
          "Waiver suggestions are alternatives, not a combined plan. Recalculate after making a move; two suggestions may need the same outgoing player or budget.",
          ...waivers.notes.filter(Boolean),
          actionWarning,
        ],
        impact: {
          label: `${signed(move.weightedGain)} modeled roster value`,
          value: move.weightedGain,
        },
        href: href("waivers"),
        state: "open",
      });
    }
  }

  if (trades.state === "available") {
    const seenPackages = new Set<string>();
    const candidates = [...trades.bestForMe, ...trades.fairest]
      .filter((trade) => trade.mutuallyBeneficial && trade.userGain > 0 && trade.partnerGain > 0)
      .sort(
        (left, right) =>
          right.userGain - left.userGain ||
          right.partnerGain - left.partnerGain ||
          tradeKey(left).localeCompare(tradeKey(right)),
      )
      .filter((trade) => {
        const key = tradeKey(trade);
        if (seenPackages.has(key)) return false;
        seenPackages.add(key);
        return true;
      })
      .slice(0, 2);
    for (const trade of candidates) {
      items.push({
        id: itemIdentity(snapshot, "trade", {
          partnerId: trade.partner.id,
          send: playersIdentity(trade.send),
          receive: playersIdentity(trade.receive),
          forcedDropsForUser: playersIdentity(trade.forcedDropsForUser),
          forcedDropsForPartner: playersIdentity(trade.forcedDropsForPartner),
          userGain: trade.userGain,
          partnerGain: trade.partnerGain,
        }),
        kind: "trade",
        title: `Explore a trade with ${trade.partner.name}`,
        summary: `Send ${trade.send.map((player) => player.name).join(" and ")}; receive ${trade.receive.map((player) => player.name).join(" and ")}.`,
        detail: [
          `Modeled roster value: ${signed(trade.userGain)} for you and ${signed(trade.partnerGain)} for ${trade.partner.name}, using the current weekly projections and accounting for any required drops.`,
          ...(trade.forcedDropsForUser.length
            ? [
                `Your required drops: ${trade.forcedDropsForUser.map((player) => player.name).join(", ")}.`,
              ]
            : []),
          ...(trade.forcedDropsForPartner.length
            ? [
                `Their required drops: ${trade.forcedDropsForPartner.map((player) => player.name).join(", ")}.`,
              ]
            : []),
          "A positive model result does not predict trade acceptance. Compare these alternatives before making an offer.",
          ...trades.notes.filter(Boolean),
          actionWarning,
        ],
        impact: { label: `${signed(trade.userGain)} modeled roster value`, value: trade.userGain },
        href: href("trades"),
        state: "open",
      });
    }
  }

  return {
    generatedAt: snapshot.generatedAt,
    league: snapshot.league,
    team: snapshot.team,
    provenance: snapshot.provenance,
    sections,
    items,
  };
}
