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

interface CueMeasurement {
  host: HTMLElement;
  hasMore: boolean;
  top: number;
  height: number;
}

/* All layout reads happen before any style writes: interleaving them per
   element forces a synchronous reflow for every tracked table on screen. */
function measure(element: HTMLElement): CueMeasurement | null {
  const host = element.parentElement;
  if (!host) return null;
  const max = element.scrollWidth - element.clientWidth;
  return {
    host,
    hasMore: max > 1 && element.scrollLeft < max - 1,
    top: element.offsetTop,
    height: element.clientHeight,
  };
}

function apply({ host, hasMore, top, height }: CueMeasurement): void {
  host.dataset.cueEnd = hasMore ? "true" : "false";
  if (!hasMore) return;
  host.style.setProperty("--cue-top", `${top}px`);
  host.style.setProperty("--cue-height", `${height}px`);
}

function updateAll(elements: Iterable<HTMLElement>): void {
  const measurements: CueMeasurement[] = [];
  for (const element of elements) {
    const m = measure(element);
    if (m) measurements.push(m);
  }
  for (const m of measurements) apply(m);
}

export function ScrollCues(): null {
  useEffect(() => {
    const tracked = new Map<HTMLElement, () => void>();
    let scanFrame = 0;
    const pendingScroll = new Set<HTMLElement>();
    let scrollFrame = 0;

    const flushScroll = () => {
      scrollFrame = 0;
      const batch = [...pendingScroll];
      pendingScroll.clear();
      updateAll(batch);
    };

    const resizeObserver = new ResizeObserver((entries) => {
      updateAll(entries.map((entry) => entry.target as HTMLElement));
    });

    const track = (element: HTMLElement) => {
      if (tracked.has(element)) return false;
      element.parentElement?.classList.add("scroll-cue-host");
      /* One measurement per frame per element: flick-scrolling fires at
         touch-input rate and each unthrottled pass forced a sync layout. */
      const onScroll = () => {
        pendingScroll.add(element);
        if (!scrollFrame) scrollFrame = requestAnimationFrame(flushScroll);
      };
      element.addEventListener("scroll", onScroll, { passive: true });
      tracked.set(element, () => element.removeEventListener("scroll", onScroll));
      /* Observing here rather than on every scan: re-observing an already
         observed target re-delivers its entry, so each scan re-ran every
         cue for no reason. */
      resizeObserver.observe(element);
      return true;
    };

    const scan = () => {
      scanFrame = 0;
      const fresh: HTMLElement[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(SELECTOR)) {
        if (track(element)) fresh.push(element);
      }
      updateAll(fresh);
      for (const [element, detach] of tracked) {
        if (element.isConnected) continue;
        detach();
        resizeObserver.unobserve(element);
        tracked.delete(element);
      }
    };

    /* React commits mutate the tree many times per second in the draft room;
       one coalesced scan per frame is plenty for discovering new tables. */
    const scheduleScan = () => {
      if (!scanFrame) scanFrame = requestAnimationFrame(scan);
    };

    scan();
    const mutationObserver = new MutationObserver(scheduleScan);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (scanFrame) cancelAnimationFrame(scanFrame);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      for (const detach of tracked.values()) detach();
      tracked.clear();
    };
  }, []);

  return null;
}
