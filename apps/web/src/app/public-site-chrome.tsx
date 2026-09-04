import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { LacesOutMark } from "../components/laces-out-mark";
import { publicAppStoreUrl } from "../lib/public-site";

import { ContactEasterEgg } from "./contact-easter-egg";
import styles from "./public-site-chrome.module.css";

export function PublicSiteHeader({
  showNavigation = true,
  solid = false,
}: {
  readonly showNavigation?: boolean;
  readonly solid?: boolean;
}) {
  const className = [
    styles.siteHeader,
    solid ? styles.siteHeaderSolid : "",
    !showNavigation ? styles.siteHeaderCompact : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={className}>
      <div className={styles.headerInner}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span>
            <strong>Laces Out</strong>
          </span>
        </Link>

        {showNavigation ? (
          <nav className={styles.primaryNav} aria-label="Public site navigation">
            <a href="/#how-it-works">How It Works</a>
            <a href="/#sync">Sync</a>
            <a href="/#draft-day">Draft Day</a>
            <a href="/#in-season">In Season</a>
            <a href="/#privacy">Privacy</a>
          </nav>
        ) : null}

        <div className={styles.headerActions}>
          <Link className={styles.textButton} href="/login">
            Sign In
          </Link>
          <Link className={styles.headerCta} href="/register">
            Join <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function PublicSiteFooter() {
  return (
    <footer className={styles.siteFooter}>
      <div className={styles.footerTop}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark compact />
          <span>
            <strong>Laces Out</strong>
          </span>
        </Link>
        <p>Connected leagues. Automatic analysis. Better Sundays.</p>
        <nav aria-label="Footer navigation">
          <Link href="/methodology">Methodology</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <ContactEasterEgg />
          <a href={publicAppStoreUrl}>App Store</a>
          <Link href="/login">Sign In</Link>
          <a
            className={styles.footerGithub}
            href="https://github.com/mwardio/laces-out"
            target="_blank"
            rel="noreferrer"
            aria-label="Laces Out on GitHub"
            title="Laces Out on GitHub"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297 24 5.67 18.627.297 12 .297Z" />
            </svg>
          </a>
        </nav>
      </div>
      <div className={styles.footerBottom}>
        <span>© 2026 Laces Out.</span>
        <span>
          Independent and non-commercial. Not affiliated with or endorsed by Yahoo or ESPN.
        </span>
      </div>
    </footer>
  );
}

export function PublicAccountShell({
  ariaLabel,
  children,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`${styles.page} ${styles.accountPage}`}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <PublicSiteHeader showNavigation={false} solid />
      <main className={styles.accountMain} id="main-content">
        <section className={styles.accountFormSide} aria-label={ariaLabel}>
          {children}
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
