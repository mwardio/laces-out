import type { Metadata } from "next";

import { ResetPasswordForm } from "../../components/reset-password-form";

export const metadata: Metadata = {
  title: "Reset Password",
  description: "Set a new Laces Out password.",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <main className="login-page login-page--single">
      <section className="login-form-side" aria-label="Set a new password">
        <ResetPasswordForm />
        <p className="login-help">
          Completing a reset signs out every previously signed-in device, so anyone holding an old
          session loses access the moment the new password lands.
        </p>
      </section>
    </main>
  );
}
