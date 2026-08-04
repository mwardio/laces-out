"use client";

import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { requestYahooNativeAuthorization } from "../lib/yahoo-native-connect";

import styles from "./yahoo-native-connect.module.css";

export function YahooNativeConnect() {
  const started = useRef(false);
  const mounted = useRef(false);
  const [status, setStatus] = useState("Opening Yahoo’s secure sign-in…");

  useEffect(() => {
    mounted.current = true;
    // React's development strict-effects pass must not create a second one-time OAuth state.
    if (!started.current) {
      started.current = true;
      void requestYahooNativeAuthorization(apiBaseUrl).then((navigation) => {
        if (!mounted.current) return;
        setStatus(
          navigation.kind === "authorization"
            ? "Continuing to Yahoo…"
            : "Returning to the Laces Out app…",
        );
        window.location.replace(navigation.url);
      });
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-live="polite" aria-busy="true">
        <span className={styles.mark} aria-hidden="true">
          LO
        </span>
        <p className={styles.eyebrow}>Read-only Yahoo connection</p>
        <h1>Connecting your league</h1>
        <p className={styles.status} role="status">
          <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
          {status}
        </p>
        <p className={styles.security}>
          <ShieldCheck size={16} aria-hidden="true" />
          Yahoo credentials stay with Yahoo and the Laces Out server.
        </p>
      </section>
    </main>
  );
}
