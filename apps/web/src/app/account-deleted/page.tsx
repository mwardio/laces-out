import { ArrowLeft, CheckCircle2, LockKeyhole } from "lucide-react";
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
            Your sessions and account-private data have been removed from the live deployment. You
            are signed out on every device.
          </p>
        </aside>

        <section>
          <h2>What remains</h2>
          <p>
            Deterministic shared league facts remain available to surviving members without your
            account attribution. League Intel and recap text you created was removed, and a league
            where you were the only member was removed. Encrypted backups may retain deleted records
            until this deployment&apos;s documented backup rotation completes.
          </p>
        </section>

        <footer className={styles.footer}>
          <LockKeyhole size={15} aria-hidden="true" />
          <span>This deletion cannot be undone.</span>
        </footer>
      </article>
    </main>
  );
}
