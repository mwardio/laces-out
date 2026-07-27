"use client";

import {
  ArrowUpRight,
  BarChart3,
  BrainCircuit,
  CalendarDays,
  ChartNoAxesCombined,
  ChartSpline,
  ClipboardCheck,
  Cable,
  LayoutDashboard,
  ListOrdered,
  Menu,
  Radio,
  Settings,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { apiBaseUrl, parseAuthenticatedSession } from "../lib/api-client";
import { yahooComingSoon } from "../lib/public-site";
import { LacesOutMark } from "./laces-out-mark";
import { ScrollCues } from "./scroll-cues";
import { SessionControl } from "./session-control";
import { YahooAttribution } from "./yahoo-attribution";

type AppSection =
  | "analytics"
  | "ai"
  | "connections"
  | "dashboard"
  | "decisions"
  | "draft"
  | "members"
  | "projections"
  | "rankings"
  | "schedule"
  | "settings"
  | "stats";

interface AppShellProps {
  active: AppSection;
  children: ReactNode;
  compact?: boolean;
  /** Set false where a signed-out viewer is shown real data, not a sample. */
  showDemoChip?: boolean;
  context?: {
    readonly label: string;
    readonly detail: string;
    readonly tone?: "demo" | "setup";
  };
}

const primaryNavigation = [
  {
    href: "/app",
    label: "Overview",
    description: "Your leagues and next moves",
    icon: LayoutDashboard,
    section: "dashboard" as const,
  },
  {
    href: "/analytics",
    label: "League Analytics",
    description: "Power ranks and opponent edges",
    icon: BarChart3,
    section: "analytics" as const,
  },
  {
    href: "/stats",
    label: "Stats Center",
    description: "Usage, production, efficiency, and trends",
    icon: ChartSpline,
    section: "stats" as const,
  },
  {
    href: "/decisions",
    label: "Decision Desk",
    description: "Lineups, waivers, and trades",
    icon: ClipboardCheck,
    section: "decisions" as const,
  },
  {
    href: "/film-room",
    label: "Film Room",
    description: "Gemini briefs and second reads",
    icon: BrainCircuit,
    section: "ai" as const,
  },
  {
    href: "/rankings",
    label: "Rankings",
    description: "Boards, values, and cheat sheets",
    icon: ListOrdered,
    section: "rankings" as const,
  },
  {
    href: "/projections",
    label: "Projections",
    description: "Weekly and rest-of-season forecasts",
    icon: ChartNoAxesCombined,
    section: "projections" as const,
  },
  {
    href: "/schedule",
    label: "Schedule Edge",
    description: "Roster matchups, bye pressure, and playoff paths",
    icon: CalendarDays,
    section: "schedule" as const,
  },
  {
    href: "/draft",
    label: "Draft Studio",
    description: "Auction and snake draft rooms",
    icon: Radio,
    section: "draft" as const,
  },
  {
    href: "/connections",
    label: "League Sync",
    description: "Sync ESPN · Yahoo coming soon",
    icon: Cable,
    section: "connections" as const,
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Password and default league",
    icon: Settings,
    section: "settings" as const,
  },
] as const;

export function AppShell({
  active,
  children,
  compact = false,
  context,
  showDemoChip = true,
}: AppShellProps) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);
  const mobileMenuSheetRef = useRef<HTMLElement>(null);
  const shellContext = context ?? {
    label: "2026 season",
    detail: "Live after sign-in",
    tone: "setup" as const,
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/v1/auth/session`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? parseAuthenticatedSession(await response.json()) : null,
      )
      .then((session) => setIsAdmin(session?.user.role === "admin"))
      .catch(() => {
        if (!controller.signal.aborted) setIsAdmin(false);
      });
    return () => controller.abort();
  }, []);

  // Registration only. It installs the handler that shows a notification the member has already
  // opted into; permission is requested from the Settings toggle and nowhere else.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A browser that refuses the registration simply has no game day alerts.
    });
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => mobileMenuCloseRef.current?.focus(), 0);
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        mobileMenuTriggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;

      const sheet = mobileMenuSheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (
        event.shiftKey &&
        (document.activeElement === first || !sheet.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleResize() {
      if (window.innerWidth > 820) setMobileMenuOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [mobileMenuOpen]);

  function closeMobileMenuAndRestoreFocus() {
    setMobileMenuOpen(false);
    window.setTimeout(() => mobileMenuTriggerRef.current?.focus(), 0);
  }

  const mobileMenuSections: readonly AppSection[] = [
    "analytics",
    "stats",
    "schedule",
    "connections",
    "rankings",
    "projections",
    "settings",
    "members",
  ];
  const mobileMenuIsActive = mobileMenuSections.includes(active);

  return (
    <div className={`app-shell${compact ? " app-shell--compact" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand" href="/app" aria-label="Laces Out locker room overview">
          <LacesOutMark />
          <span className="brand-copy">
            <strong>Laces Out</strong>
          </span>
        </Link>

        <nav className="side-nav">
          <p className="nav-label">Locker Room</p>
          {primaryNavigation.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.section;
            return (
              <Link
                className={`nav-item${isActive ? " nav-item--active" : ""}`}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                key={item.href}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.section === "draft" ? <span className="nav-live">LAB</span> : null}
              </Link>
            );
          })}
          {isAdmin ? (
            <Link
              className={`nav-item${active === "members" ? " nav-item--active" : ""}`}
              href="/admin/members"
              aria-current={active === "members" ? "page" : undefined}
            >
              <UserPlus size={18} />
              <span>Members</span>
            </Link>
          ) : null}
        </nav>

        <div className="sidebar-spacer" />

        <section className="sidebar-status" aria-labelledby="demo-mode-label">
          <div className="sidebar-status__icon">
            <ShieldCheck size={17} />
          </div>
          <div>
            <strong id="demo-mode-label">Clearly labeled data</strong>
            <p>Synced league facts stay separate from sample previews.</p>
          </div>
        </section>
      </aside>

      <div className="app-frame">
        <header className="topbar">
          <Link className="mobile-brand" href="/app" aria-label="Laces Out locker room overview">
            <LacesOutMark />
            <strong>Laces Out</strong>
          </Link>
          <div className="topbar-context">
            <span
              className={`context-pulse context-pulse--${shellContext.tone ?? "demo"}`}
              aria-hidden="true"
            />
            <span>{shellContext.label}</span>
            <span className="topbar-separator" aria-hidden="true" />
            <span className="muted">{shellContext.detail}</span>
          </div>
          <div className="topbar-actions">
            <ScrollCues />
            <SessionControl showDemoChip={showDemoChip} />
            <Link className="button button--dark button--small topbar-draft-link" href="/draft">
              <Radio size={15} />
              Draft Room
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </header>

        <main id="main-content" className="main-content">
          {children}
          {/* Attribution belongs on pages that actually show Yahoo data. While
              Yahoo sync is disabled, every page was asserting a data source the
              deployment has none of. */}
          {yahooComingSoon ? null : (
            <footer className="provider-footer" aria-label="Data provider attribution">
              <YahooAttribution />
            </footer>
          )}
        </main>
      </div>

      {mobileMenuOpen ? (
        <div className="mobile-menu-layer">
          <button
            className="mobile-menu-backdrop"
            type="button"
            aria-label="Close locker room menu"
            onClick={closeMobileMenuAndRestoreFocus}
          />
          <section
            ref={mobileMenuSheetRef}
            className="mobile-menu-sheet"
            id="mobile-locker-room-menu"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-menu-title"
          >
            <header className="mobile-menu-sheet__header">
              <div>
                <p>Locker Room</p>
                <h2 id="mobile-menu-title">Pick your next move.</h2>
                <span>Every tool is here. No desktop detour required.</span>
              </div>
              <button
                ref={mobileMenuCloseRef}
                className="mobile-menu-sheet__close"
                type="button"
                aria-label="Close locker room menu"
                onClick={closeMobileMenuAndRestoreFocus}
              >
                <X size={19} />
              </button>
            </header>

            <nav className="mobile-menu-grid" aria-label="More locker room tools">
              {primaryNavigation
                .filter((item) =>
                  (
                    [
                      "analytics",
                      "stats",
                      "schedule",
                      "rankings",
                      "projections",
                      "connections",
                      "settings",
                    ] as readonly AppSection[]
                  ).includes(item.section),
                )
                .map((item) => {
                  const Icon = item.icon;
                  const isActive = active === item.section;
                  return (
                    <Link
                      className={isActive ? "is-active" : undefined}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      key={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <span className="mobile-menu-grid__icon">
                        <Icon size={18} />
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <ArrowUpRight size={14} />
                    </Link>
                  );
                })}
            </nav>

            {isAdmin ? (
              <Link
                className="mobile-menu-sheet__admin"
                href="/admin/members"
                onClick={() => setMobileMenuOpen(false)}
              >
                <UserPlus size={16} />
                Manage Members
                <ArrowUpRight size={14} />
              </Link>
            ) : null}
          </section>
        </div>
      ) : null}

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <Link
          className={active === "dashboard" ? "is-active" : ""}
          href="/app"
          aria-current={active === "dashboard" ? "page" : undefined}
        >
          <LayoutDashboard size={20} />
          <span>Overview</span>
        </Link>
        <Link
          className={active === "decisions" ? "is-active" : ""}
          href="/decisions"
          aria-current={active === "decisions" ? "page" : undefined}
        >
          <ClipboardCheck size={20} />
          <span>Decide</span>
        </Link>
        <Link
          className={`bottom-nav__draft${active === "draft" ? " is-active" : ""}`}
          href="/draft"
          aria-current={active === "draft" ? "page" : undefined}
        >
          <span className="bottom-nav__draft-icon">
            <Radio size={20} />
          </span>
          <span>Draft</span>
        </Link>
        <Link
          className={active === "ai" ? "is-active" : ""}
          href="/film-room"
          aria-current={active === "ai" ? "page" : undefined}
        >
          <BrainCircuit size={20} />
          <span>Coach</span>
        </Link>
        <button
          ref={mobileMenuTriggerRef}
          className={mobileMenuOpen || mobileMenuIsActive ? "is-active" : undefined}
          type="button"
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-locker-room-menu"
          onClick={() => setMobileMenuOpen((current) => !current)}
        >
          <Menu size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
