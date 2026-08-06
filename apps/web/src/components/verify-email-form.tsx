"use client";

import {
  AlertCircle,
  ArrowRight,
  LoaderCircle,
  MailCheck,
  MailQuestion,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { AUTH_ERRORS, BACK_TO_SIGN_IN } from "../lib/copy";

type VerifyError = "expired" | "rate-limit" | "unavailable" | "not-configured" | "unknown" | null;

const errorMessages: Record<Exclude<VerifyError, null>, string> = {
  expired: "This confirmation link is invalid or has expired. Request a fresh one below.",
  "rate-limit": AUTH_ERRORS.rateLimit,
  unavailable: AUTH_ERRORS.unavailable,
  "not-configured":
    "This deployment doesn’t send email, so accounts activate immediately — just sign in.",
  unknown: `Confirmation couldn’t be completed. ${AUTH_ERRORS.tryAgain}`,
};

function classifyResponse(status: number): Exclude<VerifyError, null> {
  if (status === 400 || status === 422) return "expired";
  if (status === 404) return "not-configured";
  if (status === 429) return "rate-limit";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "unknown";
}

/**
 * Confirmation is a deliberate button press, never a page load: inbox security scanners follow
 * GET links, and a link that self-consumed on fetch would burn the token before the member saw
 * the page.
 */
export function VerifyEmailForm() {
  const [token, setToken] = useState<string | null>(null);
  const [linkChecked, setLinkChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  const [showResend, setShowResend] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<VerifyError>(null);

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    let candidate = "";
    try {
      candidate = decodeURIComponent(fragment);
    } catch {
      candidate = "";
    }
    setToken(/^[A-Za-z0-9_-]{43}$/u.test(candidate) ? candidate : "");
    // Remove the bearer token from the visible URL as soon as the client has retained it.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setLinkChecked(true);
  }, []);

  async function confirm() {
    if (isSubmitting || !token) return;
    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/verify-email`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const classified = classifyResponse(response.status);
        setError(classified);
        if (classified === "expired") setShowResend(true);
        return;
      }
      setConfirmed(true);
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/resend-verification`, {
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
      setResent(true);
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  if (!linkChecked) {
    return (
      <div className="login-form">
        <button className="button button--lime login-submit" type="button" disabled>
          <LoaderCircle className="spin" size={16} /> Checking confirmation link…
        </button>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="login-form">
        <div className="login-form__heading">
          <span className="login-lock">
            <ShieldCheck size={17} />
          </span>
          <div>
            <p className="eyebrow">Email confirmed</p>
            <h1>You’re ready to sign in</h1>
          </div>
        </div>
        <Link className="button button--lime login-submit" href="/login">
          Go to sign in <ArrowRight size={15} />
        </Link>
      </div>
    );
  }

  if (resent) {
    return (
      <div className="login-form">
        <div className="login-form__heading">
          <span className="login-lock">
            <MailCheck size={17} />
          </span>
          <div>
            <p className="eyebrow">Email confirmation</p>
            <h1>Check your inbox</h1>
          </div>
        </div>
        <div className="login-demo-route">
          <Link href="/login">{BACK_TO_SIGN_IN}</Link>
        </div>
      </div>
    );
  }

  const resendForm = (
    <form className={token ? undefined : "login-form"} onSubmit={(event) => void resend(event)}>
      {!token ? (
        <div className="login-form__heading">
          <span className="login-lock">
            <MailQuestion size={17} />
          </span>
          <div>
            <p className="eyebrow">Email confirmation</p>
            <h1>Need a new link?</h1>
          </div>
        </div>
      ) : null}
      {!token && error ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>{errorMessages[error]}</span>
        </div>
      ) : null}
      <div className="login-fields">
        <label htmlFor="resend-email">Email address</label>
        <input
          id="resend-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          spellCheck={false}
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={isSubmitting}
        />
      </div>
      <button className="button button--lime login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
        {isSubmitting ? "Sending…" : "Email me a new link"}
        {!isSubmitting ? <ArrowRight size={15} /> : null}
      </button>
      {!token ? (
        <div className="login-demo-route">
          <Link href="/login">{BACK_TO_SIGN_IN}</Link>
        </div>
      ) : null}
    </form>
  );

  if (!token) return resendForm;

  return (
    <div className="login-form">
      <div className="login-form__heading">
        <span className="login-lock">
          <ShieldCheck size={17} />
        </span>
        <div>
          <p className="eyebrow">Email confirmation</p>
          <h1>One click to go</h1>
        </div>
      </div>

      {error ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>{errorMessages[error]}</span>
        </div>
      ) : null}

      {!showResend ? (
        <button
          className="button button--lime login-submit"
          type="button"
          onClick={() => void confirm()}
          disabled={isSubmitting}
        >
          {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
          {isSubmitting ? "Confirming…" : "Confirm my email"}
          {!isSubmitting ? <ArrowRight size={15} /> : null}
        </button>
      ) : (
        resendForm
      )}

      <div className="login-demo-route">
        <Link href="/login">{BACK_TO_SIGN_IN}</Link>
      </div>
    </div>
  );
}
