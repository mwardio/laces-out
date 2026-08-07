import { YahooNativeConnect } from "@laces-out/web";

/* A whole route, not a widget: it owns the page background and starts the
   Yahoo authorization handshake on mount, so the only state it can ever be
   photographed in is the one below — the dark hand-off card with its spinner
   running while the redirect is prepared. It takes no props and there is no
   second visual state to sweep, so one canonical cell is the whole surface. */

export function ConnectingHandoff() {
  return <YahooNativeConnect />;
}
