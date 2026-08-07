import { RouteLoading } from "@laces-out/web";

/* RouteLoading paints nothing but a 22px spinner centred in a `min-height:40vh`
   grid, so on its own it photographs as an almost-empty card. Both cells give
   it the bounded frame it actually streams into — a shell with its chrome
   already painted and only the route body still in flight — which is what the
   member sees on a slow connection. */

export function RouteTransition() {
  return (
    <div
      style={{
        width: "560px",
        overflow: "hidden",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "13px 18px",
          borderBottom: "1px solid var(--ink-150)",
        }}
      >
        <span className="brand-mark" style={{ width: "22px", height: "22px", flex: "0 0 22px" }} />
        <span
          style={{
            fontFamily: "var(--font-brand), var(--font-sans)",
            fontSize: "14px",
            fontWeight: 650,
            letterSpacing: "-0.01em",
            color: "var(--ink-900)",
          }}
        >
          Bell Cow Bandits
        </span>
        <span style={{ fontSize: "13px", color: "var(--ink-500)" }}>/ Week 11 matchups</span>
      </div>
      <RouteLoading />
    </div>
  );
}

export function InsidePanel() {
  return (
    <div
      style={{
        width: "360px",
        overflow: "hidden",
        background: "var(--paper-100)",
        border: "1px solid var(--ink-150)",
        borderRadius: "12px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid var(--ink-150)" }}>
        <div style={{ fontSize: "14px", fontWeight: 650, color: "var(--ink-900)" }}>Trade analyzer</div>
        <div style={{ marginTop: "3px", fontSize: "12px", color: "var(--ink-500)" }}>
          Valuing Puka Nacua for Bijan Robinson…
        </div>
      </div>
      <RouteLoading />
    </div>
  );
}
