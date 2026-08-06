import { randomBytes } from "node:crypto";

import type { Environment } from "@laces-out/config";
import {
  createBrowserHandoffRequestSchema,
  createBrowserHandoffResponseSchema,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { sessionCookieName, sessionLifetimeSeconds } from "./auth.js";
import type { BrowserHandoffPort } from "./browser-handoff.js";

export const browserHandoffLandingPath = "/v1/auth/browser-handoff";
export const browserHandoffStagePath = "/v1/auth/browser-handoff/stage";
export const browserHandoffConfirmPath = "/v1/auth/browser-handoff/confirm";
export const browserHandoffConsumePath = "/v1/auth/browser-handoff/consume";
export const browserHandoffCookieName = "fantasy_browser_handoff";

const bearerSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const stageResponseSchema = z.object({ accountHint: z.string().min(1).max(320) }).strict();

export interface BrowserHandoffRouteOptions {
  readonly environment: Environment;
  readonly browserHandoffs?: BrowserHandoffPort;
  readonly isTest?: boolean;
}

function unavailable(reply: FastifyReply, correlationId: string) {
  return reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/browser-handoff-unavailable",
    title: "Browser handoff is not configured",
    status: 503,
    correlationId,
  });
}

function invalidHandoff(reply: FastifyReply, correlationId: string) {
  return reply.code(401).type("application/problem+json").send({
    type: "https://fantasy.local/problems/browser-handoff-invalid",
    title: "This browser handoff expired or was already used",
    status: 401,
    correlationId,
  });
}

function handoffFailureUrl(webUrl: string): string {
  const destination = new URL("/login", webUrl);
  destination.searchParams.set("handoff", "expired");
  return destination.toString();
}

function redirectWithoutReferrer(reply: FastifyReply, destination: string) {
  void reply.header("referrer-policy", "no-referrer");
  return reply.code(303).redirect(destination);
}

function clearHandoffCookie(reply: FastifyReply): void {
  void reply.clearCookie(browserHandoffCookieName, { path: browserHandoffLandingPath });
}

/**
 * This document has no external subresources. The one-time token exists only in `location.hash`,
 * which HTTP and Referer headers omit, and is removed from history before the first request.
 */
export function browserHandoffLandingHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Open Laces Out</title>
  <style nonce="${nonce}">
    :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111713;color:#f5f1e8}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{width:min(440px,100%);padding:28px;border:1px solid #425248;border-radius:18px;background:#19211c;text-align:center;box-shadow:0 20px 60px #0006}
    .mark{width:46px;height:46px;margin:0 auto 18px;display:grid;place-items:center;border-radius:14px;background:#d7ff62;color:#10150f;font-weight:900;font-size:22px}
    h1{margin:0 0 10px;font-size:24px}p{margin:0;color:#b8c4bc;line-height:1.55}
    #account{margin-top:14px;color:#f5f1e8;font-weight:700}
    button{width:100%;margin-top:22px;padding:13px 18px;border:0;border-radius:12px;background:#d7ff62;color:#10150f;font:inherit;font-weight:800;cursor:pointer}
    button:disabled{cursor:wait;opacity:.65}button[hidden],p[hidden]{display:none}
  </style>
</head>
<body>
  <main aria-live="polite">
    <div class="mark" aria-hidden="true">LO</div>
    <h1>Open Laces Out</h1>
    <p id="status">Checking this one-time sign-in…</p>
    <p id="account" hidden></p>
    <button id="continue" type="button" hidden disabled>Continue</button>
  </main>
  <script nonce="${nonce}">
    (() => {
      let token = location.hash.startsWith("#") ? location.hash.slice(1) : "";
      history.replaceState(null, "", location.pathname);
      const status = document.getElementById("status");
      const account = document.getElementById("account");
      const continueButton = document.getElementById("continue");
      let ready = false;
      const fail = () => {
        ready = false;
        status.textContent = "This sign-in link expired or was already used.";
        account.hidden = true;
        continueButton.hidden = true;
      };
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { fail(); return; }
      const body = JSON.stringify({ token });
      token = "";
      fetch("${browserHandoffStagePath}", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body
      }).then(async (response) => {
        if (!response.ok) throw new Error("handoff rejected");
        const staged = await response.json();
        if (!staged || typeof staged.accountHint !== "string") throw new Error("invalid response");
        account.textContent = "Target account: " + staged.accountHint;
        account.hidden = false;
        status.textContent = "Confirm this is the account you want to open in this browser.";
        continueButton.textContent = "Continue as " + staged.accountHint;
        continueButton.hidden = false;
        continueButton.disabled = false;
        ready = true;
      }).catch(fail);
      continueButton.addEventListener("click", () => {
        if (!ready) return;
        ready = false;
        continueButton.disabled = true;
        status.textContent = "Securing your browser session…";
        fetch("${browserHandoffConfirmPath}", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "accept": "application/json" }
        }).then((response) => {
          if (!response.ok) throw new Error("confirmation rejected");
          location.replace("${browserHandoffConsumePath}");
        }).catch(fail);
      });
    })();
  </script>
</body>
</html>`;
}

export function registerBrowserHandoffRoutes(
  app: FastifyInstance,
  options: BrowserHandoffRouteOptions,
): void {
  app.post(
    "/v1/auth/browser-handoffs",
    {
      config: {
        rateLimit: { max: options.isTest ? 10_000 : 10, timeWindow: "10 minutes" },
      },
    },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/unauthorized",
          title: "Authentication required",
          status: 401,
          correlationId: request.id,
        });
      }
      if (!options.browserHandoffs) return unavailable(reply, request.id);
      const input = createBrowserHandoffRequestSchema.parse(request.body);
      const result = await options.browserHandoffs.create(
        request.currentUser.id,
        request.cookies[sessionCookieName],
        input.destination,
      );
      if (!result) return invalidHandoff(reply, request.id);
      return createBrowserHandoffResponseSchema.parse({
        handoffUrl: result.handoffUrl,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.get(browserHandoffLandingPath, async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64url");
    void reply.headers({
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
    });
    return reply.type("text/html; charset=utf-8").send(browserHandoffLandingHtml(nonce));
  });

  app.post(
    browserHandoffStagePath,
    {
      config: {
        rateLimit: { max: options.isTest ? 10_000 : 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!options.browserHandoffs) return unavailable(reply, request.id);
      const input = bearerSchema.parse(request.body);
      const staged = await options.browserHandoffs.stage(input.token);
      if (!staged) return invalidHandoff(reply, request.id);
      const maxAge = Math.max(1, Math.floor((staged.expiresAt.getTime() - Date.now()) / 1000));
      void reply.setCookie(browserHandoffCookieName, staged.redemptionToken, {
        path: browserHandoffLandingPath,
        httpOnly: true,
        secure: options.environment.NODE_ENV === "production",
        sameSite: "strict",
        maxAge,
        expires: staged.expiresAt,
      });
      return reply.code(200).send(stageResponseSchema.parse({ accountHint: staged.accountHint }));
    },
  );

  app.post(
    browserHandoffConfirmPath,
    {
      config: {
        rateLimit: { max: options.isTest ? 10_000 : 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const redemptionToken = request.cookies[browserHandoffCookieName];
      if (!redemptionToken || !options.browserHandoffs) {
        clearHandoffCookie(reply);
        return invalidHandoff(reply, request.id);
      }
      const confirmed = await options.browserHandoffs.confirm(redemptionToken);
      if (!confirmed) {
        clearHandoffCookie(reply);
        return invalidHandoff(reply, request.id);
      }
      return reply.code(204).send();
    },
  );

  app.get(browserHandoffConsumePath, async (request, reply) => {
    const redemptionToken = request.cookies[browserHandoffCookieName];
    clearHandoffCookie(reply);
    if (!redemptionToken || !options.browserHandoffs) {
      return redirectWithoutReferrer(reply, handoffFailureUrl(options.environment.WEB_URL));
    }
    const consumed = await options.browserHandoffs.consume(
      redemptionToken,
      request.cookies[sessionCookieName],
    );
    if (!consumed || consumed.outcome === "account-mismatch") {
      return redirectWithoutReferrer(reply, handoffFailureUrl(options.environment.WEB_URL));
    }

    if (consumed.outcome === "session-created") {
      void reply.setCookie(sessionCookieName, consumed.session.token, {
        path: "/",
        httpOnly: true,
        secure: options.environment.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: sessionLifetimeSeconds,
        expires: consumed.session.expiresAt,
      });
    }
    return redirectWithoutReferrer(
      reply,
      new URL(consumed.destination, options.environment.WEB_URL).toString(),
    );
  });
}
