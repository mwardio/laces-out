import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  deleteAccountRequestSchema,
  deleteAccountResponseSchema,
  memberPreferencesSchema,
  memberPreferencesUpdateSchema,
} from "@laces-out/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthService } from "./auth.js";
import { sessionCookieName } from "./auth.js";
import type { AccountDataPort } from "./account-data.js";
import type { MemberPreferences } from "./preferences.js";

export interface PreferencesPort {
  get(userId: string): Promise<MemberPreferences>;
  save(
    userId: string,
    preferences: MemberPreferences,
  ): Promise<{ readonly outcome: "saved" | "not-a-member" }>;
}

export interface AccountRouteOptions {
  readonly authService?: AuthService;
  readonly accountData?: AccountDataPort;
  readonly preferences?: PreferencesPort;
  readonly isTest?: boolean;
}

function authenticatedUser(request: FastifyRequest, reply: FastifyReply) {
  if (request.currentUser) return request.currentUser;
  void reply.code(401).type("application/problem+json").send({
    type: "https://fantasy.local/problems/unauthorized",
    title: "Authentication required",
    status: 401,
    correlationId: request.id,
  });
  return undefined;
}

export function registerAccountRoutes(app: FastifyInstance, options: AccountRouteOptions): void {
  app.get(
    "/v1/account/export",
    {
      config: {
        rateLimit: {
          max: options.isTest ? 10_000 : 5,
          timeWindow: "10 minutes",
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.accountData) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/account-data-unavailable",
          title: "Account data export is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const exported = await options.accountData.exportData(user.id);
      if (!exported) {
        void reply.clearCookie(sessionCookieName, { path: "/" });
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/unauthorized",
          title: "The account no longer exists",
          status: 401,
          correlationId: request.id,
        });
      }
      void reply.header(
        "content-disposition",
        'attachment; filename="laces-out-account-export.json"',
      );
      return reply.type("application/json; charset=utf-8").send(exported);
    },
  );

  app.delete(
    "/v1/account",
    {
      config: {
        // Password reauthentication makes this intentionally expensive. A member gets enough
        // attempts to correct a typo without making a live session a useful brute-force oracle.
        rateLimit: {
          max: options.isTest ? 10_000 : 5,
          timeWindow: "10 minutes",
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.accountData) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/account-deletion-unavailable",
          title: "Account deletion is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const input = deleteAccountRequestSchema.parse(request.body);
      const deleted = await options.accountData.deleteAccount({
        userId: user.id,
        currentPassword: input.currentPassword,
        correlationId: request.id,
        deletedAt: new Date(),
      });
      if (!deleted) {
        void reply.clearCookie(sessionCookieName, { path: "/" });
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/unauthorized",
          title: "The account no longer exists",
          status: 401,
          correlationId: request.id,
        });
      }
      if (!deleted.deleted) {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/invalid-credentials",
          title: "The current password is incorrect",
          status: 401,
          correlationId: request.id,
        });
      }
      void reply.clearCookie(sessionCookieName, { path: "/" });
      return deleteAccountResponseSchema.parse(deleted);
    },
  );

  app.post(
    "/v1/auth/password",
    {
      config: {
        // Tighter than login: the caller is already authenticated, so a burst of attempts here
        // is either a mistake or an attempt to brute-force the current password of a live session.
        rateLimit: {
          max: options.isTest ? 10_000 : 10,
          timeWindow: "10 minutes",
        },
      },
    },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user) return reply;
      if (!options.authService) {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/auth-unavailable",
          title: "Authentication is not configured",
          status: 503,
          correlationId: request.id,
        });
      }
      const input = changePasswordRequestSchema.parse(request.body);
      const result = await options.authService.changePassword(
        user.id,
        input.currentPassword,
        input.newPassword,
        request.cookies[sessionCookieName],
      );
      if (result.outcome === "unsupported") {
        return reply.code(503).type("application/problem+json").send({
          type: "https://fantasy.local/problems/password-change-unavailable",
          title: "This deployment cannot change passwords in the app",
          status: 503,
          correlationId: request.id,
        });
      }
      if (result.outcome === "invalid-current-password") {
        return reply.code(401).type("application/problem+json").send({
          type: "https://fantasy.local/problems/invalid-credentials",
          title: "The current password is incorrect",
          status: 401,
          correlationId: request.id,
        });
      }
      return changePasswordResponseSchema.parse({ changed: true, otherSessionsRevoked: true });
    },
  );

  app.get("/v1/preferences", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.preferences) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/preferences-unavailable",
        title: "Preferences are not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    return memberPreferencesSchema.parse(await options.preferences.get(user.id));
  });

  app.patch("/v1/preferences", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user) return reply;
    if (!options.preferences) {
      return reply.code(503).type("application/problem+json").send({
        type: "https://fantasy.local/problems/preferences-unavailable",
        title: "Preferences are not configured",
        status: 503,
        correlationId: request.id,
      });
    }
    const update = memberPreferencesUpdateSchema.parse(request.body);
    const current = await options.preferences.get(user.id);
    const preferences: MemberPreferences = {
      defaultLeagueId:
        "defaultLeagueId" in update ? (update.defaultLeagueId ?? null) : current.defaultLeagueId,
      emailNotifications:
        "emailNotifications" in update
          ? (update.emailNotifications ?? true)
          : current.emailNotifications,
    };
    const result = await options.preferences.save(user.id, preferences);
    if (result.outcome === "not-a-member") {
      return reply.code(403).type("application/problem+json").send({
        type: "https://fantasy.local/problems/not-a-league-member",
        title: "You are not a member of that league",
        status: 403,
        correlationId: request.id,
      });
    }
    return memberPreferencesSchema.parse(preferences);
  });
}
