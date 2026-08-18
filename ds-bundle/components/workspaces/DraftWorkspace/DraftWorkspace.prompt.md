DraftWorkspace from @laces-out/web. Use via `window.LacesOut.DraftWorkspace` (bundle loaded from the root `_ds_bundle.js`).

The full draft-room board: queue, roster needs, and pick-by-pick guidance.

A complete page-level surface that holds its own board state, so it takes no
props and is dropped in as the main content of a draft route. It is wide by
design — give it the full content column rather than nesting it in a card.

## Props

```ts
interface DraftWorkspaceProps {
  /* Takes no props — holds its own draft board state internally. */
}
```
