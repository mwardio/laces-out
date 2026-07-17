import {
  aiAnalysisRequestSchema,
  aiAnalysisResponseSchema,
  aiFeatureNameSchema,
  aiFeatureRequestSchema,
  aiFeatureResponseSchema,
  aiProviderConfigurationSchema,
  aiProviderListResponseSchema,
  aiProviderNameSchema,
  aiProviderSaveRequestSchema,
  aiProviderTestResponseSchema,
  type AiAnalysisResponse,
  type AiFeatureName,
  type AiFeatureResponse,
  type AiProviderConfiguration,
  type AiProviderListResponse,
  type AiProviderName,
  type AiProviderSaveRequest,
  type AiProviderTestResponse,
} from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export interface AiServicePort {
  listProviders(userId: string): Promise<AiProviderListResponse>;
  saveProvider(
    userId: string,
    provider: AiProviderName,
    input: AiProviderSaveRequest,
  ): Promise<AiProviderConfiguration>;
  deleteProvider(userId: string, provider: AiProviderName): Promise<boolean>;
  testProvider(userId: string, provider: AiProviderName): Promise<AiProviderTestResponse>;
  analyzeLeague(input: {
    readonly userId: string;
    readonly provider?: AiProviderName;
    readonly leagueId: string;
    readonly question: string;
  }): Promise<AiAnalysisResponse>;
  generateFeature(input: {
    readonly userId: string;
    readonly feature: AiFeatureName;
    readonly provider?: AiProviderName;
    readonly leagueId: string;
    readonly instructions?: string;
  }): Promise<AiFeatureResponse>;
}

const providerPathSchema = z.object({ provider: aiProviderNameSchema }).strict();
const featurePathSchema = z.object({ feature: aiFeatureNameSchema }).strict();

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

function availableService(
  request: FastifyRequest,
  reply: FastifyReply,
  service: AiServicePort | undefined,
): service is AiServicePort {
  if (service) return true;
  void reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/ai-unavailable",
    title: "Private AI is not configured on this Laces Out server",
    status: 503,
    correlationId: request.id,
  });
  return false;
}

export function registerAiRoutes(app: FastifyInstance, ai?: AiServicePort): void {
  app.get("/v1/ai/providers", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user || !availableService(request, reply, ai)) return reply;
    return aiProviderListResponseSchema.parse(await ai.listProviders(user.id));
  });

  app.put(
    "/v1/ai/providers/:provider",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, ai)) return reply;
      const { provider } = providerPathSchema.parse(request.params);
      const input = aiProviderSaveRequestSchema.parse(request.body);
      return aiProviderConfigurationSchema.parse(await ai.saveProvider(user.id, provider, input));
    },
  );

  app.delete("/v1/ai/providers/:provider", async (request, reply) => {
    const user = authenticatedUser(request, reply);
    if (!user || !availableService(request, reply, ai)) return reply;
    const { provider } = providerPathSchema.parse(request.params);
    await ai.deleteProvider(user.id, provider);
    return reply.code(204).send();
  });

  app.post(
    "/v1/ai/providers/:provider/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, ai)) return reply;
      const { provider } = providerPathSchema.parse(request.params);
      return aiProviderTestResponseSchema.parse(await ai.testProvider(user.id, provider));
    },
  );

  app.post(
    "/v1/ai/analyze",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, ai)) return reply;
      const input = aiAnalysisRequestSchema.parse(request.body);
      return aiAnalysisResponseSchema.parse(
        await ai.analyzeLeague({
          userId: user.id,
          leagueId: input.leagueId,
          question: input.question,
          ...(input.provider ? { provider: input.provider } : {}),
        }),
      );
    },
  );

  app.post(
    "/v1/ai/features/:feature",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = authenticatedUser(request, reply);
      if (!user || !availableService(request, reply, ai)) return reply;
      const { feature } = featurePathSchema.parse(request.params);
      const input = aiFeatureRequestSchema.parse(request.body);
      return aiFeatureResponseSchema.parse(
        await ai.generateFeature({
          userId: user.id,
          feature,
          leagueId: input.leagueId,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
        }),
      );
    },
  );
}
