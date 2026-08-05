import type { Environment } from "@fantasy/config";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sessionCookieName, sessionLifetimeSeconds, type LoginResult } from "./auth.js";

const registrationBodySchema = z
  .object({
    inviteCode: z.string().min(1).max(128).optional(),
    displayName: z.string().trim().min(1).max(100),
    email: z.email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();

export interface RegistrationPort {
  register(input: {
    readonly inviteCode?: string;
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<LoginResult | undefined>;
}

export function registerRegistrationRoutes(
  app: FastifyInstance,
  options: { readonly environment: Environment; readonly registration?: RegistrationPort },
): void {
  app.post(
    "/v1/auth/register",
    { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (!options.registration) {
        return reply.code(404).type("application/problem+json").send({
          type: "https://fantasy.local/problems/registration-unavailable",
          title: "Registration is not available",
          status: 404,
          correlationId: request.id,
        });
      }
      const input = registrationBodySchema.parse(request.body);
      const result = await options.registration.register({
        displayName: input.displayName,
        email: input.email,
        password: input.password,
        ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
      });
      if (!result) {
        // Deliberately identical for an invalid code and an existing email.
        return reply.code(400).type("application/problem+json").send({
          type: "https://fantasy.local/problems/registration-rejected",
          title: "Account could not be created",
          status: 400,
          detail: "Check the registration details and try again.",
          correlationId: request.id,
        });
      }
      void reply.setCookie(sessionCookieName, result.token, {
        path: "/",
        httpOnly: true,
        secure: options.environment.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: sessionLifetimeSeconds,
        expires: result.expiresAt,
      });
      return reply.code(201).send({
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );
}
