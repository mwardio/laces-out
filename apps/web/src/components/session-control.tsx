"use client";

import { ChevronDown, CloudOff, LoaderCircle, LogIn, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseAuthenticatedSession, type SessionUser } from "../lib/api-client";
import { commitGuardedNavigation, requestGuardedNavigation } from "../lib/navigation-guard";

type SessionState =
  | { readonly status: "checking" }
  | { readonly status: "authenticated"; readonly user: SessionUser }
  | { readonly status: "guest" }
  | { readonly status: "offline" };

function userInitials(user: SessionUser): string {
  const fromName = user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
  return (fromName || user.email[0] || "O").toUpperCase();
}

/**
 * `showDemoChip` exists for surfaces that render real data to a signed-out
 * viewer — a shared ranking board is not a demo, and labeling it one
 * contradicts the sidebar's own "synced league facts stay separate from
 * sample previews."
 */
export function SessionControl({ showDemoChip = true }: { readonly showDemoChip?: boolean } = {}) {
  const [session, setSession] = useState<SessionState>({ status: "checking" });
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);

    async function checkSession() {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/auth/session`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });

        if (response.status === 401) {
          setSession({ status: "guest" });
          return;
        }
        if (!response.ok) {
          setSession({ status: "offline" });
          return;
        }

        const parsed = parseAuthenticatedSession(await response.json());
        setSession(parsed ? { status: "authenticated", user: parsed.user } : { status: "offline" });
      } catch {
        if (!controller.signal.aborted) setSession({ status: "offline" });
        else setSession({ status: "offline" });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkSession();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  async function logout() {
    if (!requestGuardedNavigation()) return;
    setIsLoggingOut(true);
    setLogoutFailed(false);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok && response.status !== 204) throw new Error("Logout failed");
      commitGuardedNavigation();
      detailsRef.current?.removeAttribute("open");
      window.location.replace("/login");
    } catch {
      setLogoutFailed(true);
    } finally {
      setIsLoggingOut(false);
    }
  }

  if (session.status === "checking") {
    return (
      <div className="session-control session-control--checking" role="status">
        <LoaderCircle className="spin" size={15} />
        <span>Checking session</span>
      </div>
    );
  }

  if (session.status === "offline") {
    return (
      <div className="session-control session-control--offline">
        <span
          className="session-offline-label"
          title="The API could not be reached; demo data remains available"
        >
          <CloudOff size={14} />
          <span>API offline · demo</span>
        </span>
        <Link className="session-signin" href="/login">
          Sign in
        </Link>
      </div>
    );
  }

  if (session.status === "guest") {
    return (
      <div className="session-control session-control--guest">
        {showDemoChip ? (
          <span className="session-demo-chip">
            <ShieldCheck size={13} /> Demo
          </span>
        ) : null}
        <Link className="button button--outline button--small" href="/login">
          <LogIn size={14} /> Sign in
        </Link>
      </div>
    );
  }

  return (
    <details className="session-menu" ref={detailsRef}>
      <summary>
        <span className="session-avatar" aria-hidden="true">
          {userInitials(session.user)}
        </span>
        <span className="session-user-copy">
          <strong>{session.user.displayName}</strong>
          <small>Signed in</small>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="session-popover">
        <div className="session-popover__identity">
          <span className="session-avatar" aria-hidden="true">
            {userInitials(session.user)}
          </span>
          <div>
            <strong>{session.user.displayName}</strong>
            <span>{session.user.email}</span>
          </div>
        </div>
        <p>
          <ShieldCheck size={13} /> Signed in to your private fantasy locker room.
        </p>
        {logoutFailed ? (
          <div className="session-error" role="alert">
            Could not sign out. Try again.
          </div>
        ) : null}
        <button type="button" onClick={() => void logout()} disabled={isLoggingOut}>
          {isLoggingOut ? <LoaderCircle className="spin" size={14} /> : <LogOut size={14} />}
          {isLoggingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </details>
  );
}
