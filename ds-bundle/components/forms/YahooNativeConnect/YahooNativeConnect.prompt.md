YahooNativeConnect from @laces-out/web. Use via `window.LacesOut.YahooNativeConnect` (bundle loaded from the root `_ds_bundle.js`).

Button that starts the Yahoo league authorization handshake.

Self-contained: it owns the whole connect flow, including its own pending and
error states, so it takes no props. Place it on a connections or onboarding
surface. Pair it with `YahooAttribution` on any surface that then displays the
league data it returns.

## Props

```ts
interface YahooNativeConnectProps {
  /* Takes no props — starts the Yahoo authorization handshake on click. */
}
```
