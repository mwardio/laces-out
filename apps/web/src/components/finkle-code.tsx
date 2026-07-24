"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./finkle-code.module.css";

const SEQUENCE = "finkle";
const KICK_MS = 2100;
const RETURN_MS = 3200;
const TAP_WINDOW_MS = 700;

type Phase = "idle" | "kick" | "return";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

/**
 * Type F-I-N-K-L-E anywhere (any case) and the page lines up the 26-yarder from
 * Super Bowl XVII. It goes wide right. The laces were in.
 */
export function FinkleCode({ children }: Readonly<{ children: ReactNode }>) {
  const [phase, setPhase] = useState<Phase>("idle");
  const progress = useRef(0);
  const logoTaps = useRef({ count: 0, lastTap: 0 });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (isTypingTarget(event.target)) {
        progress.current = 0;
        return;
      }
      const key = event.key.toLowerCase();
      progress.current =
        key === SEQUENCE[progress.current] ? progress.current + 1 : key === SEQUENCE[0] ? 1 : 0;
      if (progress.current < SEQUENCE.length) {
        return;
      }
      progress.current = 0;
      setPhase((current) => (current === "idle" ? "kick" : current));
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      setPhase((current) => (current === "idle" ? "kick" : current));
    }

    document.addEventListener("pointerup", onLogoTap, { passive: true });
    return () => document.removeEventListener("pointerup", onLogoTap);
  }, []);

  useEffect(() => {
    if (phase === "idle") {
      return;
    }
    // The scrollbar has to sit out the play, or the flight off-screen widens the document.
    const clipped = styles.clipped;
    if (clipped) {
      document.documentElement.classList.add(clipped);
    }
    const timer = window.setTimeout(
      () => setPhase((current) => (current === "kick" ? "return" : "idle")),
      phase === "kick" ? KICK_MS : RETURN_MS,
    );
    return () => {
      window.clearTimeout(timer);
      if (clipped) {
        document.documentElement.classList.remove(clipped);
      }
    };
  }, [phase]);

  const fieldClass =
    phase === "kick" ? styles.fieldKick : phase === "return" ? styles.fieldReturn : undefined;

  return (
    <>
      <div className={fieldClass} data-easter-egg="finkle-code">
        {children}
      </div>
      {phase !== "idle" ? (
        <div className={styles.overlay} aria-hidden="true">
          {phase === "kick" ? (
            <div className={styles.attempt}>
              <svg className={styles.goal} viewBox="0 0 120 132" fill="none">
                <path
                  d="M22 64V14M98 64V14M22 64h76M60 64v54"
                  stroke="currentColor"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M46 122h28" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
              </svg>
              <p className={styles.call}>Wide right. No good.</p>
            </div>
          ) : (
            <p className={styles.stamp}>The laces were in</p>
          )}
        </div>
      ) : null}
      <p className="sr-only" role="status">
        {phase === "idle" ? null : "Wide right. The laces were in."}
      </p>
    </>
  );
}
