"use client";

import { AlertCircle, ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import { apiBaseUrl } from "../lib/api-client";

type RegistrationError =
  "rejected" | "rate-limit" | "unavailable" | "invalid" | "mismatch" | "unknown" | null;

const errorMessages: Record<Exclude<RegistrationError, null>, string> = {
  rejected: "We couldn’t create the account. Check every field and the shared invite code.",
  "rate-limit": "Too many attempts. Wait ten minutes before trying again.",
  unavailable: "Registration isn’t open on this deployment. Ask your Laces Out host for access.",
  invalid: "Check each field. Passwords must be between 12 and 128 characters.",
  mismatch: "The two passwords don’t match.",
  unknown: "Registration couldn’t be completed. Try again in a moment.",
};

function classifyResponse(status: number): Exclude<RegistrationError, null> {
  if (status === 429) return "rate-limit";
  if (status === 404 || status === 502 || status === 503 || status === 504) return "unavailable";
  if (status === 400) return "rejected";
  if (status === 422) return "invalid";
  return "unknown";
}

export function RegistrationForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<RegistrationError>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    if (password !== confirmation) {
      setError("mismatch");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/register`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteCode: inviteCode.trim(),
          displayName: displayName.trim(),
          email: email.trim(),
          password,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setError(classifyResponse(response.status));
        return;
      }

      router.replace("/app");
      router.refresh();
    } catch {
      setError("unavailable");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  return (
    <form className="login-form register-form" onSubmit={(event) => void submit(event)}>
      <div className="login-form__heading">
        <span className="login-lock">
          <KeyRound size={17} />
        </span>
        <div>
          <p className="eyebrow">Shared-code access</p>
          <h1>Create your account</h1>
          <p>Use the invite code from your Laces Out host. Your account remains your own.</p>
        </div>
      </div>

      {error ? (
        <div className="login-error" role="alert" aria-live="polite">
          <AlertCircle size={16} />
          <span>{errorMessages[error]}</span>
        </div>
      ) : null}

      <div className="login-fields">
        <label htmlFor="registration-name">Display name</label>
        <input
          id="registration-name"
          name="displayName"
          type="text"
          autoComplete="name"
          required
          maxLength={100}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={isSubmitting}
        />

        <div className="password-label-row">
          <label htmlFor="registration-email">Email address</label>
          <span>Used to sign in</span>
        </div>
        <input
          id="registration-email"
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

        <div className="password-label-row">
          <label htmlFor="registration-code">Shared invite code</label>
          <span>From your host</span>
        </div>
        <input
          id="registration-code"
          name="inviteCode"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={128}
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
          disabled={isSubmitting}
        />

        <div className="password-label-row">
          <label htmlFor="registration-password">Password</label>
          <span>12–128 characters</span>
        </div>
        <div className="password-field">
          <input
            id="registration-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error === "mismatch" || error === "invalid"}
            disabled={isSubmitting}
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Hide passwords" : "Show passwords"}
            aria-pressed={showPassword}
            disabled={isSubmitting}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>

        <div className="password-label-row">
          <label htmlFor="registration-password-confirmation">Confirm password</label>
        </div>
        <div className="password-field">
          <input
            id="registration-password-confirmation"
            name="passwordConfirmation"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            aria-invalid={error === "mismatch"}
            disabled={isSubmitting}
          />
        </div>
      </div>

      <button className="button button--lime login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="spin" size={16} /> : null}
        {isSubmitting ? "Creating account…" : "Create account"}
        {!isSubmitting ? <ArrowRight size={15} /> : null}
      </button>

      <div className="login-demo-route registration-signin-route">
        <span>Already have an account?</span>
        <Link href="/login">Sign in</Link>
      </div>
    </form>
  );
}
