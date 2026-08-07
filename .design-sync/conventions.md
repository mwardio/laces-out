# Building with Laces Out

Laces Out is a fantasy-football product design system: warm paper, dark field
ink, crisp rules, compact data typography, and a single turf-green accent.

## Setup

**No provider or theme wrapper is required.** Components read nothing from
React context — render them directly. Link the one stylesheet and you have the
tokens, fonts, and component styles:

```html
<link rel="stylesheet" href="styles.css">
```

Brand headings use Sora (shipped); body copy and numerals use the system sans
and mono stacks by design, not by omission.

## Styling idiom

There is **no utility-class system** — no `flex`, no `p-4`, no `text-lg`.
Style your own layout with the CSS custom properties below, and reach for a
global component class when one already fits. Never invent a class name and
never target a component's internals: components style themselves with CSS
Modules, so their real class names are content-hashed and unstable.

### Tokens — the reusable vocabulary

| Family | Names | Use |
|---|---|---|
| Ink | `--ink-025` → `--ink-950` (13 steps) | text, borders, dark fills |
| Paper | `--paper-25`, `--paper-50`, `--paper-100` | page and card backgrounds |
| Semantic | `--surface`, `--line`, `--muted`, `--white` | fills, rules, secondary text |
| Turf accent | `--lime-100` → `--lime-700`, `--fern-500/600` | primary accent, emphasis |
| Status | `--green-*`, `--red-100/600`, `--orange-*`, `--blue-*`, `--violet-*` | good / bad / warn / info |
| Card | `--card-tint`, `--card-accent`, `--card-strong` | layered card surfaces |
| Type scale | `--text-8` → `--text-24` (px) | font sizes |
| Space | `--space-4` → `--space-32` | padding, gap, margin |
| Radius | `--radius-xs/sm/md/lg` | corners |
| Shadow | `--shadow-card/hover/raised` | elevation |
| Focus | `--focus-ring`, `--focus-ring-soft`, `--focus-glow`, `--focus-glow-strong` | focus states |
| Fonts | `--font-sans`, `--font-mono`, `--font-brand` | body, numerals, brand |
| Layout | `--topbar-height`, `--sidebar-width` | app chrome |
| Provider | `--provider-openai/anthropic/gemini/deepseek/grok/openrouter` | AI provider brand tints |

### Global component classes

Real, stable class names you should use (BEM-ish, `--` modifiers):

- `.button` with `--lime`, `--outline`, `--soft`, `--dark`, `--danger`,
  `--small`, `--full`
- `.panel`, `.panel-heading` (`--tight`), `.panel-footnote`
- `.section-block`, `.section-heading`
- `.status-chip` with `--live`, `--demo`, `--matchup-scheduled`,
  `--matchup-in-progress`, `--matchup-final`
- `.empty-state`, `.field-error`, `.muted`, `.app-shell` (`--compact`)

Everything else in the stylesheet is feature-specific (`.draft-mock-panel`,
`.ranking-table`, `.login-story`) — those belong to particular screens; do not
repurpose them as generic primitives.

### Cascade

The stylesheet declares `@layer reset, base, components, utilities, polish`.
Your own rules are unlayered, so they win over all of it without `!important`.

## Where the truth lives

Read the real files before styling — they beat any summary:

- `styles.css` and its `@import` closure (`fonts/fonts.css`, `_ds_bundle.css`)
  — every token and class above is defined there.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage and
  examples.
- `components/<group>/<Name>/<Name>.d.ts` — the exact prop contract.

## A typical composition

```jsx
<section className="panel">
  <h2 className="section-heading">Week 12 · Decision Desk</h2>

  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-12)" }}>
    <TeamAvatar teamName="Gridiron Ghosts" abbreviation="GG" size="medium" highlight />
    <span style={{ font: "600 var(--text-16)/1.3 var(--font-sans)", color: "var(--ink-900)" }}>
      Gridiron Ghosts
    </span>
    <span className="status-chip status-chip--live">Live</span>
  </div>

  <AiAnswerContent answer={response.answer} />

  <button className="button button--lime">Apply lineup</button>
</section>
```
