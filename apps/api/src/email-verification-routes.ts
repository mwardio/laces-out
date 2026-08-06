import type { Environment } from "@fantasy/config";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const verifyEmailBodySchema = z.object({ token: z.string().min(1).max(128) }).strict();
const resendVerificationBodySchema = z.object({ email: z.string().min(3).max(254) }).strict();

export interface EmailVerificationPort {
  verifyEmail(token: string): Promise<{ readonly userId: string } | undefined>;
  requestResend(email: string): Promise<void>;
}

function emailVerificationUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).type("application/problem+json").send({
    type: "https://fantasy.local/problems/email-verification-unavailable",
    title: "Email confirmation is not available",
    status: 404,
    correlationId: request.id,
  });
}

export function registerEmailVerificationRoutes(
  app: FastifyInstance,
  options: {
    readonly environment: Environment;
    readonly emailVerification?: EmailVerificationPort;
  },
): void {
  const isTest = options.environment.NODE_ENV === "test";

  app.post(
    "/v1/auth/verify-email",
    {
      config: {
        rateLimit: {
          max: isTest ? 10_000 : 10,
          timeWindow: "15 minutes",
          keyGenerator: (request) => `verify-email-ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!options.emailVerification) return emailVerificationUnavailable(request, reply);
      const input = verifyEmailBodySchema.parse(request.body);
      const verified = await options.emailVerification.verifyEmail(input.token);
      if (!verified) {
        // Deliberately identical for unknown, expired, and used tokens.
        return reply.code(400).type("application/problem+json").send({
          type: "https://fantasy.local/problems/invalid-verification-token",
          title: "The confirmation link is invalid or has expired",
          status: 400,
          detail: "Request a new confirmation email and use it within its window.",
          correlationId: request.id,
        });
      }
      // Confirmation deliberately does not create a browser session. Legacy iOS returns to its
      // unchanged login flow, and web members take the same explicit sign-in step.
      return { verified: true };
    },
  );

  app.post(
    "/v1/auth/resend-verification",
    {
      config: {
        // Each accepted request can produce an outbound email; as tight as forgot-password.
        rateLimit: {
          max: isTest ? 10_000 : 5,
          timeWindow: "15 minutes",
          keyGenerator: (request) => `resend-verification-ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!options.emailVerification) return emailVerificationUnavailable(request, reply);
      const input = resendVerificationBodySchema.parse(request.body);
      // Do not make response time an account oracle. Delivery continues after the fixed response.
      void options.emailVerification
        .requestResend(input.email)
        .catch((error: unknown) =>
          request.log.error({ err: error }, "verification resend processing failed"),
        );
      return reply.code(202).send({ requested: true });
    },
  );
}
