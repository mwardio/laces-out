import { createTransport } from "nodemailer";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type EmailSendOutcome = "sent" | "failed";

/**
 * The only surface the rest of the system sends mail through. Outcomes are two-state on purpose:
 * transport errors can echo the recipient address and raw server responses, so they never leave
 * this module — callers get an outcome to count, and the observer gets a sanitized code to log.
 */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendOutcome>;
}

export interface SmtpConfiguration {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** RFC 5322 From value, e.g. `Laces Out <noreply@lacesout.app>`. */
  readonly from: string;
}

export interface SmtpSendFailure {
  readonly event: "send-failed";
  /** Sanitized failure class (`EAUTH`, `ECONNECTION`, a response code) — never message text. */
  readonly code: string;
}

function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; responseCode?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length <= 40) return candidate.code;
    if (typeof candidate.responseCode === "number") return String(candidate.responseCode);
  }
  return "unknown";
}

/**
 * SMTP submission with mandatory TLS: implicit on port 465, STARTTLS everywhere else. A server
 * that cannot offer TLS fails the send rather than exposing credentials on a plaintext hop.
 */
export function createSmtpEmailTransport(
  configuration: SmtpConfiguration,
  observe?: (failure: SmtpSendFailure) => void,
): EmailTransport {
  const transporter = createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.port === 465,
    requireTLS: true,
    auth: { user: configuration.user, pass: configuration.password },
  });
  return {
    async send(message): Promise<EmailSendOutcome> {
      try {
        await transporter.sendMail({
          from: configuration.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return "sent";
      } catch (error) {
        observe?.({ event: "send-failed", code: failureCode(error) });
        return "failed";
      }
    },
  };
}
