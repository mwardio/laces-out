import { TeamAvatar } from "@laces-out/web";

/* Every cell uses the initials fallback rather than a `logoUrl`. Provider
   logos are fetched from Yahoo/ESPN CDNs by the member's browser and there is
   no network in the capture, so a url would only ever photograph the fallback
   anyway — and the fallback is the interesting path: it is what a league sees
   for every team that never uploaded a logo.

   Team names are league-realistic fantasy names; the records and points are
   plausible for a 12-team half-PPR league in week 11. */

function Caption({ children }: { children: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--ink-500)",
      }}
    >
      {children}
    </span>
  );
}

/** small / medium / large, the three sizes the app actually places. */
export function SizeScale() {
  const sizes = [
    { size: "small" as const, label: "Small · 22px", where: "Draft ticker, activity feed" },
    { size: "medium" as const, label: "Medium · 30px", where: "Standings, matchup rows" },
    { size: "large" as const, label: "Large · 44px", where: "Team header, trade block" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "34px",
        padding: "20px 22px",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      {sizes.map((entry) => (
        <div
          key={entry.size}
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "9px" }}
        >
          <div style={{ display: "flex", height: "44px", alignItems: "center" }}>
            <TeamAvatar teamName="Bijan Mustard" size={entry.size} />
          </div>
          <Caption>{entry.label}</Caption>
          <span style={{ fontSize: "12px", color: "var(--ink-700)" }}>{entry.where}</span>
        </div>
      ))}
    </div>
  );
}

/** `highlight` draws the lime ring that marks the viewer's own team in a list. */
export function CurrentTeamHighlight() {
  const teams = [
    { name: "Kupp of Joe", mine: false },
    { name: "Bijan Mustard", mine: false },
    { name: "Puka Your Eyes Out", mine: true },
    { name: "Nabers Watch", mine: false },
  ];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "20px 22px",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <Caption>Week 11 · your team is ringed</Caption>
      <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
        {teams.map((team) => (
          <div
            key={team.name}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "7px", width: "88px" }}
          >
            <TeamAvatar teamName={team.name} size="large" highlight={team.mine} />
            <span
              style={{
                fontSize: "11px",
                lineHeight: 1.3,
                textAlign: "center",
                color: team.mine ? "var(--ink-900)" : "var(--ink-500)",
                fontWeight: team.mine ? 700 : 500,
              }}
            >
              {team.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Initials derived from the team name vs. a provider-supplied abbreviation. */
export function InitialsAndAbbreviations() {
  const rows = [
    { name: "Kupp of Joe", abbr: null, note: "two words → K O" },
    { name: "Ja'Marr the Merrier", abbr: null, note: "punctuation stripped → J T" },
    { name: "Jefferson", abbr: null, note: "one word → first 2 letters" },
    { name: "Kupp of Joe", abbr: "KOJ", note: "abbreviation wins → first 3 chars" },
    { name: "Ja'Marr the Merrier", abbr: "CIN", note: "provider abbreviation" },
  ];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "20px 22px",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
        minWidth: "360px",
      }}
    >
      <Caption>Derived initials vs. abbreviation</Caption>
      {rows.map((row) => (
        <div key={`${row.name}-${row.abbr ?? "derived"}`} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <TeamAvatar teamName={row.name} abbreviation={row.abbr} size="medium" />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--ink-900)", minWidth: "160px" }}>
            {row.name}
          </span>
          <span style={{ fontSize: "12px", color: "var(--ink-500)" }}>{row.note}</span>
        </div>
      ))}
    </div>
  );
}

/** The composition the avatar was built for: a standings table. */
export function StandingsList() {
  const standings = [
    { rank: 1, name: "Bijan Mustard", record: "8-2", points: "1,342.6", mine: false },
    { rank: 2, name: "Puka Your Eyes Out", record: "7-3", points: "1,318.4", mine: true },
    { rank: 3, name: "Kupp of Joe", abbr: "KOJ", record: "7-3", points: "1,290.1", mine: false },
    { rank: 4, name: "Nabers Watch", record: "6-4", points: "1,264.9", mine: false },
    { rank: 5, name: "Ja'Marr the Merrier", record: "5-5", points: "1,201.7", mine: false },
  ];
  return (
    <div
      style={{
        width: "420px",
        padding: "18px 20px 8px",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ marginBottom: "12px" }}>
        <div
          style={{
            fontFamily: "var(--font-brand), var(--font-sans)",
            fontSize: "16px",
            fontWeight: 650,
            letterSpacing: "-0.01em",
            color: "var(--ink-900)",
          }}
        >
          Bell Cow Bandits
        </div>
        <Caption>Standings · through week 10</Caption>
      </div>
      {standings.map((team) => (
        <div
          key={team.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "11px",
            padding: "9px 0",
            borderTop: "1px solid var(--ink-150)",
          }}
        >
          <span style={{ width: "16px", fontSize: "12px", color: "var(--ink-500)", fontVariantNumeric: "tabular-nums" }}>
            {team.rank}
          </span>
          <TeamAvatar teamName={team.name} abbreviation={team.abbr} size="medium" highlight={team.mine} />
          <span
            style={{
              flex: 1,
              fontSize: "13px",
              fontWeight: team.mine ? 700 : 600,
              color: "var(--ink-900)",
              whiteSpace: "nowrap",
            }}
          >
            {team.name}
          </span>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--ink-700)", fontVariantNumeric: "tabular-nums" }}>
            {team.record}
          </span>
          <span
            style={{
              width: "66px",
              textAlign: "right",
              fontSize: "13px",
              color: "var(--ink-500)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {team.points}
          </span>
        </div>
      ))}
    </div>
  );
}
