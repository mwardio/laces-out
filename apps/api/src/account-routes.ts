import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  memberPreferencesSchema,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthService } from "./auth.js";
import { sessionCookieName } from "./auth.js";
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
    const input = memberPreferencesSchema.parse(request.body);
    const result = await options.preferences.save(user.id, input);
    if (result.outcome === "not-a-member") {
      return reply.code(403).type("application/problem+json").send({
        type: "https://fantasy.local/problems/not-a-league-member",
        title: "You are not a member of that league",
        status: 403,
        correlationId: request.id,
      });
    }
    return memberPreferencesSchema.parse(input);
  });
}
