export const FINKLE_KICK_EVENT = "laces-out:finkle-kick";

export function requestFinkleKick(): void {
  window.dispatchEvent(new Event(FINKLE_KICK_EVENT));
}
