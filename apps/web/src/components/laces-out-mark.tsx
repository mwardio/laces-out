interface LacesOutMarkProps {
  readonly compact?: boolean;
}

/** Standalone football play-diagram mark shared by public and authenticated navigation. */
export function LacesOutMark({ compact = false }: LacesOutMarkProps) {
  return (
    <span
      className={`brand-mark${compact ? " brand-mark--small" : ""}`}
      aria-hidden="true"
      title="Finkle is Einhorn!"
      data-ventura-rule="laces-out"
      data-ventura-identity="finkle-is-einhorn"
    />
  );
}
