import type { Metadata } from "next";

import { VerifyEmailForm } from "../../components/verify-email-form";
import { PublicAccountShell } from "../public-site-chrome";

export const metadata: Metadata = {
  title: "Confirm Email",
  description: "Confirm your email to activate your Laces Out account.",
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage() {
  return (
    <PublicAccountShell ariaLabel="Confirm your email">
      <VerifyEmailForm />
    </PublicAccountShell>
  );
}
