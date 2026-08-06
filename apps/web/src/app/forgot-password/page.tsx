import type { Metadata } from "next";

import { ForgotPasswordForm } from "../../components/forgot-password-form";
import { PublicAccountShell } from "../public-site-chrome";

export const metadata: Metadata = {
  title: "Forgot Password",
  description: "Request a Laces Out password reset link.",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <PublicAccountShell ariaLabel="Request a password reset">
      <ForgotPasswordForm />
    </PublicAccountShell>
  );
}
