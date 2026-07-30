const yahooConnectionStateEvent = "lacesout:yahoo-connection-state";

interface YahooConnectionStateDetail {
  readonly connected: boolean;
}

export function publishYahooConnectionState(connected: boolean): void {
  window.dispatchEvent(
    new CustomEvent<YahooConnectionStateDetail>(yahooConnectionStateEvent, {
      detail: { connected },
    }),
  );
}

export function subscribeToYahooConnectionState(
  listener: (connected: boolean) => void,
): () => void {
  function handleConnectionState(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as Partial<YahooConnectionStateDetail> | undefined;
    if (typeof detail?.connected === "boolean") listener(detail.connected);
  }

  window.addEventListener(yahooConnectionStateEvent, handleConnectionState);
  return () => window.removeEventListener(yahooConnectionStateEvent, handleConnectionState);
}
