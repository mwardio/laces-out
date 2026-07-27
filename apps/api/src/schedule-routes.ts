import { scheduleByesResponseSchema, scheduleResponseSchema } from "@fantasy/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ScheduleQuery } from "./schedule.js";

export interface SchedulePort {
  getSchedule(query: ScheduleQuery): Promise<unknown>;
  getByeWeeks(season: number): Promise<unknown>;
}

export interface ScheduleRouteOptions {
  readonly schedule?: SchedulePort;
  readonly now?: () => Date;
}

const seasonSchema = z.coerce.number().int().min(1999).max(2200);

const scheduleQuerySchema = z
  .object({
    season: seasonSchema.optional(),
    week: z.coerce.number().int().min(1).max(25).optional(),
    team: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2,4}$/u)
      .optional(),
  })
  .strict();

const byesQuerySchema = z.object({ season: seasonSchema.optional() }).strict();

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).type("application/problem+json").send({
    type: "https://fantasy.local/problems/schedule-unavailable",
    title: "Schedule is not configured",
    status: 503,
    correlationId: request.id,
  });
}

/**
 * Schedule research turns toward the upcoming season once that year's schedule-release window
 * begins. Before May, the previous season remains the useful default.
 */
export function defaultScheduleSeason(now: Date): number {
  return now.getUTCMonth() < 4 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

export function registerScheduleRoutes(app: FastifyInstance, options: ScheduleRouteOptions): void {
  const now = options.now ?? (() => new Date());

  app.get("/v1/schedule", async (request, reply) => {
    if (!options.schedule) return unavailable(request, reply);
    const input = scheduleQuerySchema.parse(request.query);
    const query: ScheduleQuery = {
      season: input.season ?? defaultScheduleSeason(now()),
      week: input.week ?? null,
      team: input.team ?? null,
    };
    return scheduleResponseSchema.parse(await options.schedule.getSchedule(query));
  });

  app.get("/v1/schedule/byes", async (request, reply) => {
    if (!options.schedule) return unavailable(request, reply);
    const input = byesQuerySchema.parse(request.query);
    const season = input.season ?? defaultScheduleSeason(now());
    return scheduleByesResponseSchema.parse(await options.schedule.getByeWeeks(season));
  });
}
