"use client";

import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { AUTH_ERRORS } from "../lib/copy";

const MINIMUM_PASSWORD_LENGTH = 12;

type ResetError =
  | "expired"
  | "mismatch"
  | "too-short"
  | "rate-limit"
  | "unavailable"
  | "not-configured"
  | "unknown"
  | null;

const errorMessages: Record<Exclude<ResetError, null>, string> = {
  expired: "This reset link is invalid or has expired. Request a fresh one below.",
  mismatch: "The passwords do not match.",
  "too-short": `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
  "rate-limit": AUTH_ERRORS.rateLimit,
  unavailable: AUTH_ERRORS.unavailable,
  "not-configured":
    "This deployment doesn’t support self-service reset. Ask the host to reset your password.",
  unknown: `The reset couldn’t be completed. ${AUTH_ERRORS.tryAgain}`,
};

function classifyResponse(status: number): Exclude<ResetError, null> {
  if (status === 400 || status === 422) return "expired";
  if (status === 404) return "not-configured";
  if (status === 429) return "rate-limit";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "unknown";
}

export function ResetPasswordForm() {
  const [token, setToken] = useState<string | null>(null);
  const [linkChecked, setLinkChecked] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ResetError>(null);

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    let candidate = "";
    try {
      candidate = decodeURIComponent(fragment);
    } catch {
      candidate = "";
    }
    setToken(/^[A-Za-z0-9_-]{43}$/u.test(candidate) ? candidate : "");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setLinkChecked(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || !token) return;
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError("too-short");
      return;
    }
    if (password !== confirmPassword) {
      setError("mismatch");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/reset-password`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, password }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setError(classifyResponse(response.status));
        return;
      }
      setDone(true);
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="login-form">
        <div className="login-form__heading">
          <span className="login-lock">
            <ShieldCheck size={17} />
          </span>
          <div>
            <p className="eyebrow">Password reset</p>
            <h1>You’re back in business</h1>
          </div>
        </div>
        <div className="login-demo-route">
          <span>All set?</span>
          <Link href="/login">Go to sign in</Link>
        </div>
      </div>
    );
  }

  if (!linkChecked) {
    return (
      <div className="login-form">
        <button className="button button--lime login-submit" type="button" disabled>
          <LoaderCircle className="spin" size={16} /> Checking reset link…
        </button>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="login-form">
        <div className="login-form__heading">
          <span className="login-lock">
            <AlertCircle size={17} />
          </span>
          <div>
            <p className="eyebrow">Password reset</p>
            <h1>That link is incomplete</h1>
          </div>
        </div>
        <div className="login-demo-route">
          <span>Need a link?</span>
          <Link href="/forgot-password">Request a password reset</Link>
        </div>
      </div>
    );
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      <div className="login-form__heading">
        <span className="login-lock">
          <LockKeyhole size={17} />
        </span>
        <div>
          <p className="eyebrow">Password reset</p>
          <h1>Set a new password</h1>
          <p>
            At least {MINIMUM_PASSWORD_LENGTH} characters. Completing the reset signs out every
            previously signed-in device.
          </p>
        </div>
      </div>

      {error ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>{errorMessages[error]}</span>
        </div>
      ) : null}

      <div className="login-fields">
        <div className="password-label-row">
          <label htmlFor="new-password">New password</label>
        </div>
        <div className="password-field">
          <input
            id="new-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error === "too-short" || error === "mismatch"}
            disabled={isSubmitting}
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            disabled={isSubmitting}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>

        <div className="password-label-row">
          <label htmlFor="confirm-password">Confirm new password</label>
        </div>
        <div className="password-field">
          <input
            id="confirm-password"
            name="confirmPassword"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            maxLength={128}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={error === "mismatch"}
            disabled={isSubmitting}
          />
        </div>
      </div>

      <button className="button button--lime login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
        {isSubmitting ? "Saving…" : "Save new password"}
        {!isSubmitting ? <ArrowRight size={15} /> : null}
      </button>

      <div className="login-demo-route">
        <span>Link expired?</span>
        <Link href="/forgot-password">Request a fresh reset email</Link>
      </div>
    </form>
  );
}
