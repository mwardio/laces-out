import type { Metadata } from "next";

import { ForgotPasswordForm } from "../../components/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot Password",
  description: "Request a Laces Out password reset link.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="login-page login-page--single">
      <section className="login-form-side" aria-label="Request a password reset">
        <ForgotPasswordForm />
        <p className="login-help">
          The reset link arrives by email and works for 30 minutes. For your privacy, the response
          looks the same whether or not an account exists for the address.
        </p>
      </section>
    </main>
  );
}
