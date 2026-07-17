interface LacesOutMarkProps {
  readonly compact?: boolean;
}

/** A compact crystal-ball football mark designed to remain legible at favicon size. */
export function LacesOutMark({ compact = false }: LacesOutMarkProps) {
  return (
    <span
      className={`brand-mark${compact ? " brand-mark--small" : ""}`}
      aria-hidden="true"
      title="Finkle is Einhorn!"
      data-ventura-rule="laces-out"
      data-ventura-identity="finkle-is-einhorn"
    >
      <svg viewBox="0 0 64 64" focusable="false">
        <path className="brand-mark__base" d="M18.1 48.8h27.8l3.4 7H14.7Z" />
        <path className="brand-mark__base-rim" d="M17.5 51.3h29" />
        <circle className="brand-mark__orb" cx="32" cy="29.5" r="21.5" />
        <circle className="brand-mark__orb-rim" cx="32" cy="29.5" r="20.2" />
        <path className="brand-mark__glint" d="M18.4 29.2c.2-7.1 4.2-13.2 10.2-16.1" />
        <path
          className="brand-mark__football"
          d="M32 12.7c-6.2 3.2-9.6 9.7-9.6 17.8S25.8 45.2 32 48.4c6.2-3.2 9.6-9.8 9.6-17.9S38.2 15.9 32 12.7Z"
        />
        <path className="brand-mark__seam" d="M32 19.2v22.6" />
        <path
          className="brand-mark__lace"
          d="M27.8 24.1h8.4m-9.1 3.9h9.8m-9.8 3.9h9.8m-9.1 3.9h8.4"
        />
      </svg>
    </span>
  );
}
