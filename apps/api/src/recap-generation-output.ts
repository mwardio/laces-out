import type { AiToolParameterSchema } from "@laces-out/contracts";

/** Provider enforcement complements, but never replaces, the final output validator. */
export function weeklyRecapOutputSchema(requestedWeek: number): AiToolParameterSchema {
  if (!Number.isInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > 30) {
    throw new RangeError("The requested recap week is invalid.");
  }
  return {
    type: "object",
    properties: {
      week: {
        type: "integer",
        description: "The requested completed recap week.",
        minimum: requestedWeek,
        maximum: requestedWeek,
      },
      status: {
        type: "string",
        description: "Written only when the supplied facts support a complete recap.",
        enum: ["written", "unavailable"],
      },
      body: {
        type: "string",
        description: "The complete Markdown recap, or an empty string when unavailable.",
      },
    },
    required: ["week", "status", "body"],
    additionalProperties: false,
  };
}

/** The output envelope is validated before any generated recap can be saved. */
export const WEEKLY_RECAP_OUTPUT_INSTRUCTIONS = [
  'Return only one JSON object with exactly these keys: {"week": REQUESTED_WEEK, "status": "written", "body": "MARKDOWN_RECAP"}.',
  "Set week to the numeric requested recap week, never the current fantasy week or a week inferred from other context.",
  "Write a substantive 150–250-word Markdown recap in body using only the supplied facts for that requested week.",
  "Escape body as a JSON string. Do not add a code fence, introduction, or text outside the JSON object.",
  'If the requested week cannot be recapped from the supplied facts, return {"week": REQUESTED_WEEK, "status": "unavailable", "body": ""}.',
  'Never mark an explanation of missing data, a refusal, or a recap of another week as "written".',
].join("\n");

export type WeeklyRecapOutput =
  { readonly state: "written"; readonly body: string } | { readonly state: "invalid" };

const MAX_BODY_CHARACTERS = 30_000;
// A 30,000-character body may use six characters per escaped JSON code unit.
const MAX_RESPONSE_CHARACTERS = MAX_BODY_CHARACTERS * 6 + 1_000;

/** Invalid responses deliberately return no provider text for persistence or display. */
export function parseWeeklyRecapOutput(text: string, requestedWeek: number): WeeklyRecapOutput {
  if (
    !Number.isInteger(requestedWeek) ||
    requestedWeek < 1 ||
    requestedWeek > 30 ||
    text.length > MAX_RESPONSE_CHARACTERS
  ) {
    return { state: "invalid" };
  }

  const trimmed = text.trim();
  const fence = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const json = fence?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { state: "invalid" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "invalid" };
  }
  const output = value as Record<string, unknown>;
  if (
    Object.keys(output).length !== 3 ||
    output.week !== requestedWeek ||
    output.status !== "written" ||
    typeof output.body !== "string"
  ) {
    return { state: "invalid" };
  }

  const body = output.body.trim();
  if (body.length < 100 || body.length > MAX_BODY_CHARACTERS) {
    return { state: "invalid" };
  }
  return { state: "written", body };
}
