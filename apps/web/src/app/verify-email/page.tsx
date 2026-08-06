import type { Metadata } from "next";

import { VerifyEmailForm } from "../../components/verify-email-form";

export const metadata: Metadata = {
  title: "Confirm Email",
  description: "Confirm your email to activate your Laces Out account.",
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage() {
  return (
    <main className="login-page login-page--single">
      <section className="login-form-side" aria-label="Confirm your email">
        <VerifyEmailForm />
        <p className="login-help">
          Confirmation happens on the button press, never on page load, so a link opened by an email
          scanner is not consumed. The link works once and expires after 24 hours.
        </p>
      </section>
    </main>
  );
}
