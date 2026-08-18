RouteLoading from @laces-out/web. Use via `window.LacesOut.RouteLoading` (bundle loaded from the root `_ds_bundle.js`).

Centered spinner for route transitions and suspense boundaries.

Deliberately minimal: an animated `LoaderCircle` with no text, sized to sit in
the middle of the content area. Use it as a route-level `loading.tsx` or as a
suspense fallback — not as an inline button spinner.

```jsx
<Suspense fallback={<RouteLoading />}>
  <SlowPanel />
</Suspense>
```

## Props

```ts
interface RouteLoadingProps {
  /* Takes no props — a centered route-transition spinner. */
}
```
