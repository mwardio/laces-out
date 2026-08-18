LacesOutMark from @laces-out/web. Use via `window.LacesOut.LacesOutMark` (bundle loaded from the root `_ds_bundle.js`).

The Laces Out play-diagram mark, used in public and authenticated navigation.

Renders a single empty `<span class="brand-mark">`; the whole visual is a CSS
background image, so it has no children and no text. It is `aria-hidden`, so
always pair it with a visible or screen-reader-only product name when it acts
as a home link.

```jsx
<a href="/" aria-label="Laces Out home">
  <LacesOutMark />
</a>
```

Use `compact` in dense headers — it swaps to the smaller `brand-mark--small`
variant.

## Props

```ts
interface LacesOutMarkProps {
  /** Renders the smaller header variant. */
  compact?: boolean;
}
```
