import {
  renderEmailConfirmationEmail,
  renderPasswordResetEmail,
  type EmailTransport,
} from "@fantasy/email";

import type { EmailConfirmationDelivery } from "./email-verification.js";
import type { PasswordResetEmailDelivery } from "./password-reset.js";

/**
 * Adapters from the shared transport to the account-email services. Both throw on a failed send
 * so the caller can log an operational error; the thrown errors carry no address and no message
 * content.
 */

export function createEmailConfirmationDelivery(
  transport: EmailTransport,
): EmailConfirmationDelivery {
  return {
    async sendConfirmationEmail(input): Promise<void> {
      const rendered = renderEmailConfirmationEmail({
        displayName: input.displayName,
        confirmUrl: input.confirmUrl,
        expiresHours: input.expiresHours,
      });
      const outcome = await transport.send({
        to: input.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (outcome === "failed") {
        throw new Error("Confirmation email transport failed");
      }
    },
  };
}

export function createPasswordResetEmailDelivery(
  transport: EmailTransport,
): PasswordResetEmailDelivery {
  return {
    async sendPasswordResetEmail(input): Promise<void> {
      const rendered = renderPasswordResetEmail({
        displayName: input.displayName,
        resetUrl: input.resetUrl,
        expiresMinutes: input.expiresMinutes,
      });
      const outcome = await transport.send({
        to: input.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (outcome === "failed") {
        throw new Error("Password reset email transport failed");
      }
    },
  };
}
