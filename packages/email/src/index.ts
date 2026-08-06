export {
  createSmtpEmailTransport,
  type EmailMessage,
  type EmailSendOutcome,
  type EmailTransport,
  type SmtpConfiguration,
  type SmtpSendFailure,
} from "./transport.js";
export {
  escapeHtml,
  renderEmailConfirmationEmail,
  renderLeagueSyncNudgeEmail,
  renderPasswordResetEmail,
  type EmailConfirmationEmailInput,
  type LeagueSyncNudgeEmailInput,
  type PasswordResetEmailInput,
  type RenderedEmail,
} from "./templates.js";
