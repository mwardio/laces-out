import { ArrowLeft, CheckCircle2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../../components/laces-out-mark";

import styles from "../privacy/privacy.module.css";

export const metadata: Metadata = {
  title: "Account deleted",
  description: "Confirmation that a Laces Out account was deleted.",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <span>
            <strong>Laces Out</strong>
            <small>Account deletion</small>
          </span>
        </Link>
        <Link className={styles.back} href="/">
          <ArrowLeft size={15} /> Return home
        </Link>
      </header>

      <article className={styles.document}>
        <div className={styles.heading}>
          <p>Deletion complete</p>
          <h1>Your account was deleted</h1>
        </div>

        <aside className={styles.summary}>
          <CheckCircle2 size={20} aria-hidden="true" />
          <p>
            Your account, sessions, and private data were removed; shared league facts may remain
            for other members, and encrypted backups expire with this deployment&apos;s configured
            rotation.
          </p>
        </aside>
      </article>
    </main>
  );
}
