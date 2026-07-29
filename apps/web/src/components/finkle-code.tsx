"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { FINKLE_KICK_EVENT } from "../lib/finkle-kick";

const TAP_WINDOW_MS = 700;

type Phase = "idle" | "playing";

/* The broadcast is ~900 lines of scene math and a 639-line stylesheet that
   only ever run after a triple-tap or the contact-dialog easter egg; loading
   it on demand keeps the animation engine out of the first client chunk of
   every route. The animation itself is unchanged — this file only decides
   when its code downloads. */
const FinkleBroadcast = dynamic(() => import("./finkle-broadcast"), { ssr: false });

/**
 * Pick Finkle out of the contact dialog, or triple-tap the brand mark on a phone, and the
 * broadcast cuts to the 26-yarder from Super Bowl XVII. It goes wide right. The laces were in.
 */
export function FinkleCode({ children }: Readonly<{ children: ReactNode }>) {
  const [phase, setPhase] = useState<Phase>("idle");
  const logoTaps = useRef({ count: 0, lastTap: 0 });

  const start = useCallback(() => {
    setPhase((current) => (current === "idle" ? "playing" : current));
  }, []);
  const end = useCallback(() => setPhase("idle"), []);

  useEffect(() => {
    window.addEventListener(FINKLE_KICK_EVENT, start);
    return () => window.removeEventListener(FINKLE_KICK_EVENT, start);
  }, [start]);

  useEffect(() => {
    function onLogoTap(event: PointerEvent) {
      if (
        event.pointerType !== "touch" ||
        !(event.target instanceof Element) ||
        event.target.closest(".brand-mark") === null
      ) {
        return;
      }

      const now = performance.now();
      const count =
        now - logoTaps.current.lastTap <= TAP_WINDOW_MS ? logoTaps.current.count + 1 : 1;
      logoTaps.current = { count, lastTap: now };

      if (count < 3) {
        return;
      }

      logoTaps.current = { count: 0, lastTap: 0 };
      start();
    }

    document.addEventListener("pointerup", onLogoTap, { passive: true });
    return () => document.removeEventListener("pointerup", onLogoTap);
  }, [start]);

  return (
    <>
      <div data-easter-egg="finkle-code">{children}</div>
      {phase === "playing" ? <FinkleBroadcast onEnd={end} /> : null}
      <p className="sr-only" role="status">
        {phase === "idle" ? null : "Wide right. The laces were in."}
      </p>
    </>
  );
}
