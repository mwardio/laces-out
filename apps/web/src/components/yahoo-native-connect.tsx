"use client";

import { YAHOO_IOS_COMPLETION_URLS } from "@laces-out/contracts";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { requestYahooNativeAuthorization } from "../lib/yahoo-native-connect";

import styles from "./yahoo-native-connect.module.css";

export interface YahooNativeConnectProps {
  readonly enabled: boolean;
}

export function YahooNativeConnect({ enabled }: YahooNativeConnectProps) {
  const started = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // React's development strict-effects pass must not create a second one-time OAuth state.
    if (!started.current) {
      started.current = true;
      void requestYahooNativeAuthorization(apiBaseUrl, { enabled }).then((navigation) => {
        if (!mounted.current) return;
        window.location.replace(navigation.url);
      });
    }
    return () => {
      mounted.current = false;
    };
  }, [enabled]);

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-live="polite" aria-busy={enabled}>
        <span className={styles.mark} aria-hidden="true">
          LO
        </span>
        <p className={styles.eyebrow}>Read-only Yahoo connection</p>
        <h1>{enabled ? "Connecting your league" : "Yahoo sync is coming soon"}</h1>
        <p className={styles.status} role="status">
          <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
          {enabled ? "Loading…" : "Returning to Laces Out…"}
        </p>
        {!enabled ? <a href={YAHOO_IOS_COMPLETION_URLS.unavailable}>Return to Laces Out</a> : null}
        <p className={styles.security}>
          <ShieldCheck size={16} aria-hidden="true" />
          Yahoo credentials stay with Yahoo and the Laces Out server.
        </p>
      </section>
    </main>
  );
}
