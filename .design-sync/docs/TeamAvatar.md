---
category: Data Display
---
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
