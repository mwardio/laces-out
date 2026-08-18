/**
 * Optional, minimal, non-interactive status badge for the ESPN draft room.
 *
 * It exists so the person supplying the feed can see at a glance that Laces Out is following the
 * draft. It has no buttons, no inputs, and no pointer events: it cannot be mistaken for — or used
 * as — a control over ESPN. Nothing is ever read back out of the page through it.
 *
 * Text is set with `textContent` only. No provider text and no markup is interpolated.
 */

export interface OverlayNode {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/**
 * The document seam.
 *
 * `attach` both creates the badge and puts it in the page, returning null when there is nowhere to
 * put it. Keeping creation and insertion together on the caller's side means this module never has
 * to name a real DOM type, so tests hand it a plain object.
 */
export interface OverlayHost {
  attach(): OverlayNode | null;
}

export type OverlayTone = "observing" | "synced" | "attention";

export interface LiveDraftStatusOverlay {
  show(tone: OverlayTone, message: string): void;
  remove(): void;
}

const OVERLAY_STYLE = [
  "position:fixed",
  "right:12px",
  "bottom:12px",
  "z-index:2147483000",
  "pointer-events:none",
  "max-width:260px",
  "padding:8px 10px",
  "border-radius:9px",
  "font:600 12px/1.35 system-ui,sans-serif",
  "color:#0d1410",
  "background:#c9f464",
  "box-shadow:0 2px 10px rgba(0,0,0,0.18)",
].join(";");

const TONE_BACKGROUND: Readonly<Record<OverlayTone, string>> = {
  observing: "#e8eee3",
  synced: "#c9f464",
  attention: "#fbe5d7",
};

/** Creates the badge lazily; a host with nowhere to attach (a detached document) is a no-op. */
export function createLiveDraftStatusOverlay(host: OverlayHost): LiveDraftStatusOverlay {
  let node: OverlayNode | null = null;
  let lastTone: OverlayTone | null = null;
  let lastMessage: string | null = null;

  return {
    show(tone, message): void {
      const boundedMessage = message.slice(0, 120);
      // The badge lives inside the subtree watched by the draft MutationObserver. Rewriting an
      // unchanged badge would manufacture another mutation and can otherwise turn a failed scan
      // into a self-sustaining rescan loop.
      if (node !== null && tone === lastTone && boundedMessage === lastMessage) return;
      if (node === null) {
        node = host.attach();
        if (node === null) return;
        node.setAttribute("role", "status");
        node.setAttribute("aria-live", "polite");
        node.setAttribute("data-laces-out-live-draft", "status");
      }
      node.setAttribute("style", `${OVERLAY_STYLE};background:${TONE_BACKGROUND[tone]}`);
      node.textContent = boundedMessage;
      lastTone = tone;
      lastMessage = boundedMessage;
    },
    remove(): void {
      node?.remove();
      node = null;
      lastTone = null;
      lastMessage = null;
    },
  };
}
