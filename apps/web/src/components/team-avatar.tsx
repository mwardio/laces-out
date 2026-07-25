"use client";

import { useState } from "react";

import styles from "./team-avatar.module.css";

interface TeamAvatarProps {
  readonly teamName: string;
  readonly logoUrl?: string | null;
  readonly abbreviation?: string | null;
  readonly size?: "small" | "medium" | "large";
  /** Draws the ring that marks the viewer's own team. */
  readonly highlight?: boolean;
}

/** Initials for a team with no usable logo. Deterministic so a team looks the same everywhere. */
function initials(teamName: string, abbreviation: string | null | undefined): string {
  if (abbreviation && abbreviation.trim().length > 0) return abbreviation.trim().slice(0, 3);
  const words = teamName
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2);
  return `${words[0]![0]!}${words[1]![0]!}`;
}

/**
 * Provider-hosted team logo with an initials fallback. Logos are fetched by the member's browser
 * with no referrer; the https-only rule is enforced in the connector normalizers, which stay the
 * single validation point. A missing or unreachable logo reads as initials, never a broken image.
 */
export function TeamAvatar({
  teamName,
  logoUrl,
  abbreviation,
  size = "medium",
  highlight = false,
}: TeamAvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(logoUrl) && !failed;
  const className = `${styles.avatar} ${styles[size]}${highlight ? ` ${styles.current}` : ""}`;

  return (
    <span className={className} title={teamName}>
      {showImage ? (
        <img
          className={styles.image}
          src={logoUrl ?? undefined}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(teamName, abbreviation)}</span>
      )}
    </span>
  );
}
