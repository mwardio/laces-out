PortfolioDashboard from @laces-out/web. Use via `window.LacesOut.PortfolioDashboard` (bundle loaded from the root `_ds_bundle.js`).

Cross-league overview: standings, roster health, and the week's decisions.

The landing surface for a manager with more than one league. Use `afterOverview`
to slot additional content directly beneath the overview row without forking the
component.

```jsx
<PortfolioDashboard afterOverview={<ChangeFeedPanel />} />
```

## Props

```ts
interface PortfolioDashboardProps {
  /** Slot rendered directly beneath the overview row. */
  afterOverview?: React.ReactNode;
}
```
