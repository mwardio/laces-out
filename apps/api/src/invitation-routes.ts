import type { Environment } from "@laces-out/config";
import type { ApplicationRole } from "@laces-out/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sessionCookieName, sessionLifetimeSeconds, type AuthService } from "./auth.js";
import { emailVerificationRequiredProblem } from "./email-verification.js";
import type {
  AcceptedInvitationRecord,
  CreatedInvitation,
  InvitationInspection,
  InvitationScope,
} from "./invitation.js";
import { publicLeagueAccessRole } from "./public-league-access.js";

const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const capabilityBodySchema = z.object({ token: capabilitySchema }).strict();
const requestedLeagueRoleSchema = z.enum(["commissioner", "member", "manager", "viewer"]);
const createBodySchema = z
  .object({
    email: z.email().max(254),
    role: z.enum(["member", "admin"]).default("member"),
    leagueId: z.string().uuid().optional(),
    leagueRole: requestedLeagueRoleSchema.optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .strict()
  .refine((value) => (value.leagueId === undefined) === (value.leagueRole === undefined), {
    message: "leagueId and leagueRole must be supplied together",
  });
const acceptBodySchema = z
  .object({
    token: capabilitySchema,
    displayName: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(12).max(128).optional(),
  })
  .strict();
const invitationIdParamsSchema = z.object({ invitationId: z.string().uuid() }).strict();

function canonicalLeagueRole(
  role: z.infer<typeof requestedLeagueRoleSchema>,
): InvitationScope["leagueRole"] {
  return role === "commissioner" ? "commissioner" : "member";
}

export interface InvitationPort {
  create(input: {
    readonly invitedByUserId: string;
    readonly email: string;
    readonly role?: ApplicationRole;
    readonly scope?: InvitationScope;
    readonly expiresAt?: Date;
  }): Promise<CreatedInvitation>;
  inspect(token: string): Promise<InvitationInspection>;
  accept(input: {
    readonly token: string;
    readonly authenticatedUserId?: string;
    readonly displayName?: string;
    readonly password?: string;
  }): Promise<AcceptedInvitationRecord>;
  revoke(revokedByUserId: string, invitationId: string): Promise<{ readonly id: string }>;
}

export interface InvitationRouteOptions {
  readonly environment: Environment;
  readonly authService?: AuthService;
  readonly invitations?: InvitationPort;
}

function unavailable(requestId: string) {
  return {
    type: "https://fantasy.local/problems/invitations-unavailable",
    title: "Invitations are not configured",
    status: 503,
    correlationId: requestId,
  };
}

export function registerInvitationRoutes(
  app: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  app.post("/v1/admin/invitations", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (request.currentUser.role !== "admin") {
      return reply.code(403).send({
        type: "https://fantasy.local/problems/forbidden",
        title: "Administrator access required",
        status: 403,
        correlationId: request.id,
      });
    }
    if (!options.invitations) return reply.code(503).send(unavailable(request.id));

    const input = createBodySchema.parse(request.body);
    const created = await options.invitations.create({
      invitedByUserId: request.currentUser.id,
      email: input.email,
      role: input.role,
      ...(input.leagueId && input.leagueRole
        ? {
            scope: {
              leagueId: input.leagueId,
              leagueRole: canonicalLeagueRole(input.leagueRole),
            },
          }
        : {}),
      expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000),
    });
    const invitationUrl = new URL("/invite", options.environment.WEB_URL);
    invitationUrl.hash = created.token;
    return reply.code(201).send({
      id: created.id,
      // This is the only response that exposes the capability. Response bodies are not logged.
      invitationUrl: invitationUrl.toString(),
      email: created.email,
      role: created.role,
      scope: created.scope,
      expiresAt: created.expiresAt.toISOString(),
    });
  });

  app.post("/v1/invitations/inspect", async (request, reply) => {
    if (!options.invitations) return reply.code(503).send(unavailable(request.id));
    const input = capabilityBodySchema.parse(request.body);
    const inspection = await options.invitations.inspect(input.token);
    return {
      ...inspection,
      expiresAt: inspection.expiresAt.toISOString(),
    };
  });

  app.post(
    "/v1/invitations/accept",
    {
      config: {
        rateLimit: {
          max: options.environment.NODE_ENV === "test" ? 10_000 : 10,
          timeWindow: "15 minutes",
          keyGenerator: (request) => `invitation-accept-ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!options.invitations) return reply.code(503).send(unavailable(request.id));
      const input = acceptBodySchema.parse(request.body);
      const sessionUser = await options.authService?.validate(request.cookies[sessionCookieName]);
      const acceptance = await options.invitations.accept({
        token: input.token,
        ...(sessionUser ? { authenticatedUserId: sessionUser.id } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.password ? { password: input.password } : {}),
      });

      let sessionEstablished = sessionUser !== undefined;
      if (acceptance.verificationRequired) {
        return reply
          .code(403)
          .type("application/problem+json")
          .send(emailVerificationRequiredProblem(request.id));
      }
      if (acceptance.createdUser && input.password && options.authService) {
        const login = await options.authService.login(acceptance.user.email, input.password);
        if (login && login !== "unverified") {
          sessionEstablished = true;
          void reply.setCookie(sessionCookieName, login.token, {
            path: "/",
            httpOnly: true,
            secure: options.environment.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: sessionLifetimeSeconds,
            expires: login.expiresAt,
          });
        }
      }
      return {
        invitationId: acceptance.invitationId,
        user: acceptance.user,
        createdUser: acceptance.createdUser,
        membership: acceptance.membership
          ? {
              leagueId: acceptance.membership.leagueId,
              role: publicLeagueAccessRole({
                role: acceptance.membership.role,
                explicitCommissioner: acceptance.membership.explicitCommissioner,
              }),
            }
          : null,
        sessionEstablished,
      };
    },
  );

  app.delete("/v1/admin/invitations/:invitationId", async (request, reply) => {
    if (!request.currentUser) {
      return reply.code(401).send({
        type: "https://fantasy.local/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        correlationId: request.id,
      });
    }
    if (request.currentUser.role !== "admin") {
      return reply.code(403).send({
        type: "https://fantasy.local/problems/forbidden",
        title: "Administrator access required",
        status: 403,
        correlationId: request.id,
      });
    }
    if (!options.invitations) return reply.code(503).send(unavailable(request.id));
    const { invitationId } = invitationIdParamsSchema.parse(request.params);
    await options.invitations.revoke(request.currentUser.id, invitationId);
    return reply.code(204).send();
  });
}
