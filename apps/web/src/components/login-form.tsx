"use client";

import { AlertCircle, ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";
import { AUTH_ERRORS } from "../lib/copy";
import { safeReturnTo } from "../lib/safe-return-to";

type LoginError =
  "credentials" | "unverified" | "rate-limit" | "unavailable" | "invalid" | "unknown" | null;

const errorMessages: Record<Exclude<LoginError, null>, string> = {
  credentials: "We couldn’t sign you in with those credentials.",
  unverified: "This account’s email hasn’t been confirmed yet. Use the link in your inbox first.",
  "rate-limit": AUTH_ERRORS.rateLimit,
  unavailable: AUTH_ERRORS.unavailable,
  invalid: "Check the email and password, then try again.",
  unknown: `Sign-in couldn’t be completed. ${AUTH_ERRORS.tryAgain}`,
};

function classifyResponse(status: number): Exclude<LoginError, null> {
  if (status === 401) return "credentials";
  if (status === 429) return "rate-limit";
  if (status === 400 || status === 422) return "invalid";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "unknown";
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<LoginError>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: email.trim(), password }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const problem: unknown = await response.json().catch(() => null);
        if (
          response.status === 403 &&
          problem !== null &&
          typeof problem === "object" &&
          "code" in problem &&
          problem.code === "email_verification_required"
        ) {
          setError("unverified");
          return;
        }
        setError(classifyResponse(response.status));
        return;
      }

      const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
      window.location.replace(returnTo);
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      <div className="login-form__heading">
        <span className="login-lock">
          <LockKeyhole size={17} />
        </span>
        <div>
          <h1>Welcome back</h1>
        </div>
      </div>

      {error ? (
        <div className="login-error" role="alert">
          <AlertCircle size={16} />
          <span>
            {errorMessages[error]}
            {error === "unverified" ? (
              <>
                {" "}
                <Link href="/verify-email">Request a new confirmation link.</Link>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="login-fields">
        <label htmlFor="owner-email">Email address</label>
        <input
          id="owner-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          spellCheck={false}
          required
          maxLength={320}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error === "credentials" || error === "invalid"}
          disabled={isSubmitting}
        />

        <div className="password-label-row">
          <label htmlFor="owner-password">Password</label>
          <Link href="/forgot-password">Forgot password?</Link>
        </div>
        <div className="password-field">
          <input
            id="owner-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error === "credentials" || error === "invalid"}
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
      </div>

      <button className="button button--lime login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
        {isSubmitting ? "Signing in…" : "Sign in"}
        {!isSubmitting ? <ArrowRight size={15} /> : null}
      </button>

      <div className="login-demo-route login-register-route">
        <span>Need an account?</span>
        <Link href="/register">Create your account</Link>
      </div>
    </form>
  );
}
