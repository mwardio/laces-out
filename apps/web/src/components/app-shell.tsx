"use client";

import {
  Activity,
  ArrowUpRight,
  BarChart3,
  BrainCircuit,
  ChartNoAxesCombined,
  ChartSpline,
  ClipboardCheck,
  Cable,
  LayoutDashboard,
  ListOrdered,
  Radio,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

import { apiBaseUrl, parseAuthenticatedSession } from "../lib/api-client";
import { LacesOutMark } from "./laces-out-mark";
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
  | "stats";

interface AppShellProps {
  active: AppSection;
  children: ReactNode;
  compact?: boolean;
  context?: {
    readonly label: string;
    readonly detail: string;
    readonly tone?: "demo" | "setup";
  };
}

const primaryNavigation = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, section: "dashboard" as const },
  { href: "/analytics", label: "League Analytics", icon: BarChart3, section: "analytics" as const },
  { href: "/stats", label: "Stats Center", icon: ChartSpline, section: "stats" as const },
  {
    href: "/decisions",
    label: "Decision Desk",
    icon: ClipboardCheck,
    section: "decisions" as const,
  },
  { href: "/film-room", label: "Film Room", icon: BrainCircuit, section: "ai" as const },
  { href: "/connections", label: "Connections", icon: Cable, section: "connections" as const },
  { href: "/rankings", label: "Rankings", icon: ListOrdered, section: "rankings" as const },
  {
    href: "/projections",
    label: "Projections",
    icon: ChartNoAxesCombined,
    section: "projections" as const,
  },
  { href: "/draft", label: "Draft Studio", icon: Radio, section: "draft" as const },
] as const;

export function AppShell({ active, children, compact = false, context }: AppShellProps) {
  const [isAdmin, setIsAdmin] = useState(false);
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
          <Link className="nav-item" href="/connections#data-health">
            <Activity size={18} />
            <span>Data Health</span>
          </Link>
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

        <div className="sidebar-footnote">
          <span className="sidebar-footnote__stitch" aria-hidden="true" />
          <span>
            <strong>Built for league day</strong>
            <small>Private, transparent, yours.</small>
          </span>
        </div>
      </aside>

      <div className="app-frame">
        <header className="topbar">
          <Link className="mobile-brand" href="/app" aria-label="Laces Out locker room overview">
            <LacesOutMark compact />
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
            <SessionControl />
            <Link className="button button--dark button--small" href="/draft">
              <Radio size={15} />
              Draft Room
              <ArrowUpRight size={14} />
            </Link>
          </div>
        </header>

        <main id="main-content" className="main-content">
          {children}
          <footer className="provider-footer" aria-label="Data provider attribution">
            <YahooAttribution />
          </footer>
        </main>
      </div>

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
          className={active === "connections" ? "is-active" : ""}
          href="/connections"
          aria-current={active === "connections" ? "page" : undefined}
        >
          <Cable size={20} />
          <span>Connect</span>
        </Link>
        <Link
          className={active === "ai" ? "is-active" : ""}
          href="/film-room"
          aria-current={active === "ai" ? "page" : undefined}
        >
          <BrainCircuit size={20} />
          <span>Film</span>
        </Link>
      </nav>
    </div>
  );
}
