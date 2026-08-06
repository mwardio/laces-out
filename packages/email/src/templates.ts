/**
 * The three transactional emails, rendered from one shared layout so they read as designed rather
 * than assembled. Everything is inlined table-and-span HTML — email clients strip stylesheets —
 * and every message carries a full plain-text alternative. All interpolated values are escaped
 * here, so callers pass raw strings and cannot re-introduce markup by accident.
 *
 * The palette is the web app's own: paper `#f3f2ec`, ink `#101712`/`#3d4a41`/`#646f67`, hairline
 * `#dde1db`, lime `#a8cf53`. No images at all — a text wordmark keeps rendering identical with
 * remote content blocked and keeps the messages light enough to stay out of spam heuristics.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface LayoutInput {
  /** Inbox preview line; hidden inside the rendered message. */
  readonly preheader: string;
  readonly heading: string;
  /** Already-escaped paragraph fragments, rendered in order. */
  readonly paragraphsHtml: readonly string[];
  readonly cta?: { readonly label: string; readonly url: string };
  /** Small line under the button, e.g. a paste-this-link fallback. Already escaped. */
  readonly afterCtaHtml?: string;
  /** Already-escaped footer fragments below the divider. */
  readonly footerHtml: readonly string[];
}

function renderLayout(input: LayoutInput): string {
  const paragraphs = input.paragraphsHtml
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#3d4a41;">${paragraph}</p>`,
    )
    .join("\n");
  const cta = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px 0;">
  <tr>
    <td style="border-radius:8px;background:#a8cf53;">
      <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#101712;text-decoration:none;border-radius:8px;">${escapeHtml(input.cta.label)}</a>
    </td>
  </tr>
</table>`
    : "";
  const afterCta = input.afterCtaHtml
    ? `<p style="margin:8px 0 0 0;font-size:13px;line-height:1.6;color:#646f67;word-break:break-all;">${input.afterCtaHtml}</p>`
    : "";
  const footer = input.footerHtml
    .map(
      (fragment) =>
        `<p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#646f67;">${fragment}</p>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Laces Out</title>
</head>
<body style="margin:0;padding:0;background:#f3f2ec;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f2ec;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dde1db;border-radius:12px;">
        <tr>
          <td style="padding:32px 40px 28px 40px;font-family:${FONT_STACK};">
            <p style="margin:0 0 28px 0;font-size:13px;font-weight:700;letter-spacing:0.18em;color:#101712;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#a8cf53;"></span>&nbsp;
              LACES&nbsp;OUT
            </p>
            <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;font-weight:700;color:#101712;">${escapeHtml(input.heading)}</h1>
${paragraphs}
${cta}
${afterCta}
            <hr style="border:none;border-top:1px solid #dde1db;margin:28px 0 20px 0;">
${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function textDocument(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

export interface EmailConfirmationEmailInput {
  readonly displayName: string;
  /** Full confirmation link including the one-time token. */
  readonly confirmUrl: string;
  readonly expiresHours: number;
}

/**
 * The welcome email and the activation gate are one message: the account stays pending until
 * this link is used, so the copy welcomes and asks for the single click in the same breath.
 */
export function renderEmailConfirmationEmail(input: EmailConfirmationEmailInput): RenderedEmail {
  const name = escapeHtml(input.displayName);
  const hours = String(input.expiresHours);
  return {
    subject: "Confirm your email to open your locker room",
    html: renderLayout({
      preheader: "One click activates your Laces Out account.",
      heading: "Welcome — one click to go.",
      paragraphsHtml: [
        `${name} — welcome to Laces Out, your private fantasy football locker room: draft help, start/sit calls, waiver targets, and trade analysis built from your actual leagues.`,
        `Confirm this email address within ${hours} hours to activate your account. Until then, the account stays dormant and nobody can sign in to it.`,
      ],
      cta: { label: "Confirm my email", url: input.confirmUrl },
      afterCtaHtml: `If the button doesn't work, paste this link into your browser:<br>${escapeHtml(input.confirmUrl)}`,
      footerHtml: [
        `The link works once. If it expires, request a fresh one from the sign-in screen.`,
        `Didn't create a Laces Out account? Ignore this email and nothing will happen.`,
      ],
    }),
    text: textDocument([
      "LACES OUT",
      "",
      `${input.displayName} — welcome to Laces Out, your private fantasy football locker room: draft help, start/sit calls, waiver targets, and trade analysis built from your actual leagues.`,
      "",
      `Confirm this email address within ${hours} hours to activate your account. Until then, the account stays dormant and nobody can sign in to it.`,
      "",
      `Confirm my email: ${input.confirmUrl}`,
      "",
      "The link works once. If it expires, request a fresh one from the sign-in screen.",
      "Didn't create a Laces Out account? Ignore this email and nothing will happen.",
    ]),
  };
}

export interface PasswordResetEmailInput {
  readonly displayName: string;
  /** Full reset link including the one-time token. */
  readonly resetUrl: string;
  readonly expiresMinutes: number;
}

export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const name = escapeHtml(input.displayName);
  const minutes = String(input.expiresMinutes);
  return {
    subject: "Reset your Laces Out password",
    html: renderLayout({
      preheader: `Set a new password within ${minutes} minutes.`,
      heading: "Let's get you back in.",
      paragraphsHtml: [
        `${name} — someone asked to reset the password for the Laces Out account tied to this address. If that was you, set a new password within ${minutes} minutes; after that this link expires.`,
      ],
      cta: { label: "Set a new password", url: input.resetUrl },
      afterCtaHtml: `If the button doesn't work, paste this link into your browser:<br>${escapeHtml(input.resetUrl)}`,
      footerHtml: [
        `Didn't request this? You can ignore this email — your password is unchanged, and the link is useless without access to this inbox.`,
        `For safety, completing a reset signs out every device that was signed in.`,
      ],
    }),
    text: textDocument([
      "LACES OUT",
      "",
      `${input.displayName} — someone asked to reset the password for the Laces Out account tied to this address. If that was you, set a new password within ${minutes} minutes; after that this link expires.`,
      "",
      `Set a new password: ${input.resetUrl}`,
      "",
      "Didn't request this? You can ignore this email — your password is unchanged, and the link is useless without access to this inbox.",
      "For safety, completing a reset signs out every device that was signed in.",
    ]),
  };
}

export interface LeagueSyncNudgeEmailInput {
  readonly displayName: string;
  readonly webUrl: string;
}

export function renderLeagueSyncNudgeEmail(input: LeagueSyncNudgeEmailInput): RenderedEmail {
  const connectionsUrl = `${input.webUrl}/connections`;
  const settingsUrl = `${input.webUrl}/settings`;
  const name = escapeHtml(input.displayName);
  return {
    subject: "One step left: sync your league",
    html: renderLayout({
      preheader: "Your Laces Out account is ready — it just needs a league.",
      heading: "Your locker room is still empty.",
      paragraphsHtml: [
        `${name} — you created your Laces Out account a few days ago, but no league is connected yet, so the locker room is running on empty.`,
        `Sync your ESPN or Yahoo league and the analysis starts immediately: start/sit calls, waiver targets, and trade evaluations built from your actual roster, not a generic one.`,
      ],
      cta: { label: "Sync your league", url: connectionsUrl },
      footerHtml: [
        `This is the only reminder we'll send about league setup.`,
        `Prefer no email at all? Turn off email updates in <a href="${escapeHtml(settingsUrl)}" style="color:#5e7a20;">Settings</a>.`,
      ],
    }),
    text: textDocument([
      "LACES OUT",
      "",
      `${input.displayName} — you created your Laces Out account a few days ago, but no league is connected yet, so the locker room is running on empty.`,
      "",
      "Sync your ESPN or Yahoo league and the analysis starts immediately: start/sit calls, waiver targets, and trade evaluations built from your actual roster, not a generic one.",
      "",
      `Sync your league: ${connectionsUrl}`,
      "",
      "This is the only reminder we'll send about league setup.",
      `Prefer no email at all? Turn off email updates in Settings: ${settingsUrl}`,
    ]),
  };
}
