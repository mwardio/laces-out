import { YahooAttribution } from "@laces-out/web";

/* The required data-source line for any surface built from Yahoo Fantasy
   data. It is a single inline-flex link, so on its own it reads as a stray
   pill; both cells place it where the app places it — under the data it is
   attributing. */

export function UnderLeagueTable() {
  const rows = [
    { team: "Bijan Mustard", starter: "Bijan Robinson", proj: "18.4" },
    { team: "Kupp of Joe", starter: "Cooper Kupp", proj: "13.9" },
    { team: "Nabers Watch", starter: "Malik Nabers", proj: "16.1" },
  ];
  return (
    <div
      style={{
        width: "440px",
        padding: "18px 20px 16px",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-brand), var(--font-sans)",
          fontSize: "16px",
          fontWeight: 650,
          letterSpacing: "-0.01em",
          color: "var(--ink-900)",
        }}
      >
        Week 11 projections
      </div>
      <div style={{ margin: "12px 0 14px" }}>
        {rows.map((row) => (
          <div
            key={row.team}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "10px",
              padding: "8px 0",
              borderTop: "1px solid var(--ink-150)",
              fontSize: "13px",
            }}
          >
            <span style={{ flex: 1, fontWeight: 600, color: "var(--ink-900)" }}>{row.team}</span>
            <span style={{ color: "var(--ink-500)" }}>{row.starter}</span>
            <span style={{ fontWeight: 650, color: "var(--ink-900)", fontVariantNumeric: "tabular-nums" }}>
              {row.proj}
            </span>
          </div>
        ))}
      </div>
      <YahooAttribution />
    </div>
  );
}

export function InFooterRow() {
  return (
    <div
      style={{
        display: "flex",
        width: "620px",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "20px",
        padding: "16px 20px",
        background: "var(--paper-100)",
        borderTop: "1px solid var(--ink-150)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span style={{ flex: "1 1 auto", fontSize: "12px", color: "var(--ink-500)", whiteSpace: "nowrap" }}>
        Last synced 4 minutes ago · Bell Cow Bandits
      </span>
      {/* The attribution must never shrink — it wraps to two lines otherwise. */}
      <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
        <YahooAttribution />
      </span>
    </div>
  );
}
