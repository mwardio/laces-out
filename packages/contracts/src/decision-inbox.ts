import { z } from "zod";

import {
  decisionLeagueSchema,
  decisionProvenanceSchema,
  decisionTeamSchema,
  decisionUnavailableReasonSchema,
} from "./decision-primitives.js";

export const decisionInboxKindSchema = z.enum(["lineup", "waiver", "trade"]);
export type DecisionInboxKind = z.infer<typeof decisionInboxKindSchema>;

export const decisionInboxItemStateSchema = z.enum(["open", "reviewed", "dismissed"]);
export type DecisionInboxItemState = z.infer<typeof decisionInboxItemStateSchema>;

export const decisionInboxItemIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const decisionInboxItemSchema = z
  .object({
    id: decisionInboxItemIdSchema,
    kind: decisionInboxKindSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    detail: z.array(z.string().min(1)),
    impact: z
      .object({
        /** Includes the actual unit; roster value must never be presented as win probability. */
        label: z.string().min(1),
        value: z.number().finite().nullable(),
      })
      .strict(),
    href: z
      .string()
      .regex(/^\/decisions\?league=[0-9a-f-]{36}#decision-(?:lineup|waivers|trades)$/u),
    state: decisionInboxItemStateSchema,
  })
  .strict();
export type DecisionInboxItem = z.infer<typeof decisionInboxItemSchema>;

export const decisionInboxSectionSchema = z.discriminatedUnion("state", [
  z
    .object({
      kind: decisionInboxKindSchema,
      state: z.literal("available"),
      reasons: z.array(decisionUnavailableReasonSchema).length(0),
    })
    .strict(),
  z
    .object({
      kind: decisionInboxKindSchema,
      state: z.literal("unavailable"),
      reasons: z.array(decisionUnavailableReasonSchema).min(1),
    })
    .strict(),
]);
export type DecisionInboxSection = z.infer<typeof decisionInboxSectionSchema>;

export const decisionInboxResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    league: decisionLeagueSchema,
    team: decisionTeamSchema,
    provenance: decisionProvenanceSchema,
    sections: z.array(decisionInboxSectionSchema).length(3),
    /** One complete lineup plan, up to three waiver alternatives, and two trade alternatives. */
    items: z.array(decisionInboxItemSchema).max(6),
  })
  .strict()
  .superRefine((response, context) => {
    if (new Set(response.sections.map((section) => section.kind)).size !== 3) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Each decision kind must appear once",
      });
    }
    const seenIds = new Set<string>();
    response.items.forEach((item, index) => {
      if (seenIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Inbox item IDs must be unique",
        });
      }
      seenIds.add(item.id);
      if (
        !response.sections.some(
          (section) => section.kind === item.kind && section.state === "available",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "kind"],
          message: "Inbox items require an available decision section",
        });
      }
    });
  });
export type DecisionInboxResponse = z.infer<typeof decisionInboxResponseSchema>;

export const decisionInboxStateRequestSchema = z
  .object({ state: decisionInboxItemStateSchema })
  .strict();
export type DecisionInboxStateRequest = z.infer<typeof decisionInboxStateRequestSchema>;

export const decisionInboxStateResponseSchema = z
  .object({
    itemId: decisionInboxItemIdSchema,
    state: decisionInboxItemStateSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type DecisionInboxStateResponse = z.infer<typeof decisionInboxStateResponseSchema>;
