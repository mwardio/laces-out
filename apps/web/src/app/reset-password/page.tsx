import type { Metadata } from "next";

import { ResetPasswordForm } from "../../components/reset-password-form";
import { PublicAccountShell } from "../public-site-chrome";

export const metadata: Metadata = {
  title: "Reset Password",
  description: "Set a new Laces Out password.",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <PublicAccountShell ariaLabel="Set a new password">
      <ResetPasswordForm />
    </PublicAccountShell>
  );
}
