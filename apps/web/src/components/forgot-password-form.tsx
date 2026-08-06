"use client";

import { AlertCircle, ArrowRight, KeyRound, LoaderCircle, MailCheck } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { AUTH_ERRORS, BACK_TO_SIGN_IN } from "../lib/copy";

type RequestError = "rate-limit" | "unavailable" | "not-configured" | "invalid" | "unknown" | null;

const errorMessages: Record<Exclude<RequestError, null>, string> = {
  "rate-limit": AUTH_ERRORS.rateLimit,
  unavailable: AUTH_ERRORS.unavailable,
  "not-configured":
    "This deployment doesn’t send email. Ask the host to reset your password instead.",
  invalid: "Check the email address, then try again.",
  unknown: `The request couldn’t be completed. ${AUTH_ERRORS.tryAgain}`,
};

function classifyResponse(status: number): Exclude<RequestError, null> {
  if (status === 404) return "not-configured";
  if (status === 429) return "rate-limit";
  if (status === 400 || status === 422) return "invalid";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "unknown";
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<RequestError>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/forgot-password`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: email.trim() }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setError(classifyResponse(response.status));
        return;
      }
      setSent(true);
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="login-form">
        <div className="login-form__heading">
          <span className="login-lock">
            <MailCheck size={17} />
          </span>
          <div>
            <p className="eyebrow">Password reset</p>
            <h1>Check your inbox</h1>
          </div>
        </div>
        <div className="login-demo-route">
          <span>Remembered it after all?</span>
          <Link href="/login">{BACK_TO_SIGN_IN}</Link>
        </div>
      </div>
    );
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      <div className="login-form__heading">
        <span className="login-lock">
          <KeyRound size={17} />
        </span>
        <div>
          <p className="eyebrow">Password reset</p>
          <h1>Forgot your password?</h1>
        </div>
      </div>

      {error ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>{errorMessages[error]}</span>
        </div>
      ) : null}

      <div className="login-fields">
        <label htmlFor="forgot-email">Email address</label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          spellCheck={false}
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error === "invalid"}
          disabled={isSubmitting}
        />
      </div>

      <button className="button button--lime login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
        {isSubmitting ? "Sending…" : "Email me a reset link"}
        {!isSubmitting ? <ArrowRight size={15} /> : null}
      </button>

      <div className="login-demo-route">
        <span>Remembered it after all?</span>
        <Link href="/login">{BACK_TO_SIGN_IN}</Link>
      </div>
    </form>
  );
}
