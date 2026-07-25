"use client";

import { useEffect } from "react";

/**
 * Wide tables scroll horizontally inside their card, but nothing told a sighted
 * user the row continued — a value sliced at the container edge reads as a
 * render fault, not as "scroll me". The scroll containers already carry
 * role="region" and an aria-label, so screen readers were told and nobody else
 * was.
 *
 * A pure-CSS cue does not work here: the classic background-attachment trick
 * paints behind the table, and these tables have opaque cells and sticky first
 * columns that cover it. So mark the container instead and let CSS draw an
 * overlay, updating on scroll and on resize.
 */
const SELECTOR = ".has-scroll-cue, .ranking-table-wrap, .player-table-wrap";

/**
 * The overlay lives on the card, not on the scroller: an absolutely positioned
 * child of a scroll container scrolls away with the content, and a sticky one
 * sits below the table in block flow instead of over it. The card is the
 * scroller's offsetParent once `.scroll-cue-host` makes it relative, so the
 * scroller's band within the card is just offsetTop/clientHeight.
 */
function update(element: HTMLElement): void {
  const host = element.parentElement;
  if (!host) return;
  const max = element.scrollWidth - element.clientWidth;
  const hasMore = max > 1 && element.scrollLeft < max - 1;
  host.dataset.cueEnd = hasMore ? "true" : "false";
  if (!hasMore) return;
  host.style.setProperty("--cue-top", `${element.offsetTop}px`);
  host.style.setProperty("--cue-height", `${element.clientHeight}px`);
}

export function ScrollCues(): null {
  useEffect(() => {
    const tracked = new Map<HTMLElement, () => void>();

    const track = (element: HTMLElement) => {
      if (tracked.has(element)) return;
      element.parentElement?.classList.add("scroll-cue-host");
      const onScroll = () => update(element);
      element.addEventListener("scroll", onScroll, { passive: true });
      tracked.set(element, () => element.removeEventListener("scroll", onScroll));
      update(element);
    };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) update(entry.target as HTMLElement);
    });

    const scan = () => {
      for (const element of document.querySelectorAll<HTMLElement>(SELECTOR)) {
        track(element);
        resizeObserver.observe(element);
      }
      for (const [element, detach] of tracked) {
        if (element.isConnected) continue;
        detach();
        tracked.delete(element);
      }
    };

    scan();
    const mutationObserver = new MutationObserver(scan);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      for (const detach of tracked.values()) detach();
      tracked.clear();
    };
  }, []);

  return null;
}
