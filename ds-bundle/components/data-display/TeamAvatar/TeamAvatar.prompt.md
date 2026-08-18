TeamAvatar from @laces-out/web. Use via `window.LacesOut.TeamAvatar` (bundle loaded from the root `_ds_bundle.js`).

Provider-hosted team logo with a deterministic initials fallback.

A missing, unreachable, or non-https logo reads as initials — never a broken
image — so it is always safe to pass whatever the connector returned. Initials
come from `abbreviation` when present, otherwise from the first letters of
`teamName`, and are stable so a team looks the same on every surface.

```jsx
<TeamAvatar teamName="Gridiron Ghosts" abbreviation="GG" size="medium" />
<TeamAvatar teamName="Route Runners" logoUrl={team.logoUrl} highlight />
```

Set `highlight` on exactly one avatar per view — it draws the ring that marks
the viewer's own team.

## Props

```ts
interface TeamAvatarProps {
  teamName: string;
  /** Provider-hosted logo. A missing or unreachable logo falls back to initials, never a broken image. */
  logoUrl?: string | null;
  /** Overrides the initials derived from teamName. First 3 characters are used. */
  abbreviation?: string | null;
  size?: "small" | "medium" | "large";
  /** Draws the ring that marks the viewer's own team. */
  highlight?: boolean;
}
```
