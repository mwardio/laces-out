import type { Environment } from "@laces-out/config";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const forgotPasswordBodySchema = z.object({ email: z.string().min(3).max(254) }).strict();
const resetPasswordBodySchema = z
  .object({ token: z.string().min(1).max(128), password: z.string().min(12).max(128) })
  .strict();

export interface PasswordResetPort {
  requestReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<"reset" | "invalid">;
}

function passwordResetUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/password-reset-unavailable",
    title: "Self-service password reset is not available",
    status: 404,
    correlationId: request.id,
  });
}

export function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: { readonly environment: Environment; readonly passwordReset?: PasswordResetPort },
): void {
  const isTest = options.environment.NODE_ENV === "test";

  app.post(
    "/v1/auth/forgot-password",
    {
      config: {
        // Each accepted request can produce an outbound email, so this is the tightest
        // unauthenticated limit in the API.
        rateLimit: {
          max: isTest ? 10_000 : 5,
          timeWindow: "15 minutes",
          keyGenerator: (request) => `forgot-password-ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!options.passwordReset) return passwordResetUnavailable(request, reply);
      const input = forgotPasswordBodySchema.parse(request.body);
      // Do not make response time an account oracle. Delivery continues after the fixed response.
      void options.passwordReset
        .requestReset(input.email)
        .catch((error: unknown) =>
          request.log.error({ err: error }, "password reset request processing failed"),
        );
      return reply.code(202).send({ requested: true });
    },
  );

  app.post(
    "/v1/auth/reset-password",
    {
      config: {
        rateLimit: {
          max: isTest ? 10_000 : 10,
          timeWindow: "15 minutes",
          keyGenerator: (request) => `reset-password-ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!options.passwordReset) return passwordResetUnavailable(request, reply);
      const input = resetPasswordBodySchema.parse(request.body);
      const outcome = await options.passwordReset.resetPassword(input.token, input.password);
      if (outcome === "invalid") {
        // Deliberately identical for unknown, expired, used, and malformed tokens.
        return reply.code(400).type("application/problem+json").send({
          type: "https://fantasy.local/problems/invalid-reset-token",
          title: "The reset link is invalid or has expired",
          status: 400,
          detail: "Request a new reset email and use it within its window.",
          correlationId: request.id,
        });
      }
      return { reset: true };
    },
  );
}
