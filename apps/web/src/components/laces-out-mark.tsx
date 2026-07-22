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
        <ellipse className="brand-mark__shadow" cx="32" cy="55.2" rx="18" ry="2.4" />
        <path className="brand-mark__base" d="M18 45.8h28l3.6 7.1H14.4Z" />
        <path className="brand-mark__base-foot" d="M13.6 52h36.8v4.1H13.6Z" />
        <path className="brand-mark__base-rim" d="M17.2 49.1h29.6M17 53.7h30" />
        <circle className="brand-mark__orb" cx="32" cy="27.3" r="22.2" />
        <circle className="brand-mark__orb-glow" cx="32" cy="27.3" r="19.2" />
        <circle className="brand-mark__orb-rim" cx="32" cy="27.3" r="21" />
        <path className="brand-mark__glint" d="M16.8 27c.3-6.9 4.2-12.8 10.1-15.8" />
        <path
          className="brand-mark__football"
          d="M32 9.2c-7.1 3.8-10.8 10.3-10.8 18.2S24.9 41.8 32 45.6c7.1-3.8 10.8-10.3 10.8-18.2S39.1 13 32 9.2Z"
        />
        <path className="brand-mark__football-shine" d="M27 15.4c-2.3 3.6-3.4 7.6-3.4 12" />
        <path className="brand-mark__seam" d="M32 15.8V40" />
        <path
          className="brand-mark__lace"
          d="M28.6 19.2h6.8m-7.5 4.1h8.2m-8.2 4.1h8.2m-8.2 4.1h8.2m-7.5 4.1h6.8"
        />
      </svg>
    </span>
  );
}
