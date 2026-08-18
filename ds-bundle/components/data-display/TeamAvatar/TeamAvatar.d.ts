import * as React from 'react';

/**
 * TeamAvatar — from @laces-out/web@0.1.0.
 */
export interface TeamAvatarProps {
  teamName: string;
  /** Provider-hosted logo. A missing or unreachable logo falls back to initials, never a broken image. */
  logoUrl?: string | null;
  /** Overrides the initials derived from teamName. First 3 characters are used. */
  abbreviation?: string | null;
  size?: "small" | "medium" | "large";
  /** Draws the ring that marks the viewer's own team. */
  highlight?: boolean;
}

export declare const TeamAvatar: React.ComponentType<TeamAvatarProps>;
