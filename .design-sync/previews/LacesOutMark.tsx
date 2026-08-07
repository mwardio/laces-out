import { LacesOutMark } from "@laces-out/web";

export function Default() {
  return <LacesOutMark />;
}

export function Compact() {
  return <LacesOutMark compact />;
}

export function InNavigation() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "12px 16px",
        background: "var(--paper-100)",
        borderBottom: "1px solid var(--ink-150)",
      }}
    >
      <LacesOutMark />
      <span
        style={{
          fontFamily: "var(--font-brand), var(--font-sans)",
          fontSize: "18px",
          fontWeight: 600,
          color: "var(--ink-900)",
          letterSpacing: "-0.01em",
        }}
      >
        Laces Out
      </span>
    </div>
  );
}
