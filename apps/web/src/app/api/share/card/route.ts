import { ImageResponse } from "next/og";
import { createElement, type ReactElement, type ReactNode } from "react";
import { z } from "zod";

/**
 * Renders a group-chat-ready awards card.
 *
 * The caller supplies already-formatted strings for everything on the card, so this route holds no
 * league data, needs no session, and never fetches a remote asset — team identity is drawn as an
 * initials disc rather than a provider-hosted logo, which keeps the renderer free of outbound
 * requests. A same-origin guard keeps it from being used as a general-purpose image generator.
 *
 * The layout is built with `createElement` rather than JSX so the module stays a plain `.ts` file
 * the test suite can import directly; the satori renderer takes React elements either way.
 */
const shareCardSchema = z
  .object({
    leagueName: z.string().min(1).max(80),
    week: z.number().int().min(1).max(30),
    /** Draws the sample ribbon so a demo card is never mistaken for a real week. */
    sample: z.boolean(),
    awards: z
      .array(
        z
          .object({
            label: z.string().min(1).max(40),
            teamName: z.string().min(1).max(60),
            initials: z.string().min(1).max(3),
            value: z.string().min(1).max(24),
            caption: z.string().max(140),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

type ShareCard = z.infer<typeof shareCardSchema>;

const INK = "#162019";
const INK_SOFT = "#253229";
const PAPER = "#f3f2ec";
const MUTED = "#b5bbb5";
const LIME = "#a8cf53";
const RIBBON = "#c96d42";

/** Header, footer, and padding, measured against the rendered card. */
const CARD_CHROME_HEIGHT = 300;
/** One award row plus the gap beneath it. */
const AWARD_ROW_HEIGHT = 140;

type Style = Record<string, string | number>;

/** Satori requires an explicit display on every node with children, so flex is the default. */
function box(style: Style, children: ReactNode, key?: string): ReactElement {
  return createElement("div", { style: { display: "flex", ...style }, key }, children);
}

function text(style: Style, value: string, key?: string): ReactElement {
  return createElement("div", { style: { display: "flex", ...style }, key }, value);
}

function column(style: Style, children: ReactNode, key?: string): ReactElement {
  return box({ flexDirection: "column", ...style }, children, key);
}

function awardRow(award: ShareCard["awards"][number]): ReactElement {
  return box(
    {
      alignItems: "center",
      gap: 20,
      padding: "16px 24px",
      background: INK_SOFT,
      borderRadius: 18,
      borderLeft: `6px solid ${LIME}`,
    },
    [
      box(
        {
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: 999,
          background: PAPER,
          color: INK,
          fontSize: 22,
          fontWeight: 700,
        },
        award.initials.toUpperCase(),
        "initials",
      ),
      column(
        { flexGrow: 1 },
        [
          text({ fontSize: 19, color: LIME, letterSpacing: 1.6 }, award.label.toUpperCase(), "l"),
          text({ fontSize: 31, fontWeight: 700, marginTop: 4 }, award.teamName, "t"),
          ...(award.caption.length > 0
            ? [text({ fontSize: 19, color: MUTED, marginTop: 4 }, award.caption, "c")]
            : []),
        ],
        "body",
      ),
      text({ fontSize: 38, fontWeight: 700, color: LIME }, award.value, "value"),
    ],
    award.label,
  );
}

function card(data: ShareCard): ReactElement {
  return column(
    {
      width: "100%",
      height: "100%",
      padding: "48px 56px",
      background: INK,
      color: PAPER,
      fontFamily: "sans-serif",
    },
    [
      box(
        { alignItems: "center", justifyContent: "space-between" },
        [
          column(
            {},
            [
              text(
                { fontSize: 22, letterSpacing: 4, color: LIME },
                "MONDAY MORNING AWARDS",
                "eyebrow",
              ),
              text({ fontSize: 46, fontWeight: 700, marginTop: 8 }, `Week ${data.week}`, "week"),
            ],
            "left",
          ),
          column(
            { alignItems: "flex-end" },
            [
              text({ fontSize: 26, fontWeight: 600 }, data.leagueName, "league"),
              text({ fontSize: 20, color: MUTED, marginTop: 6 }, "Laces Out", "brand"),
            ],
            "right",
          ),
        ],
        "header",
      ),
      column(
        { flexGrow: 1, justifyContent: "center", gap: 14, marginTop: 24 },
        data.awards.map((award) => awardRow(award)),
        "awards",
      ),
      box(
        {
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 24,
          fontSize: 19,
          color: MUTED,
        },
        [
          text({}, "Computed from final scores only.", "note"),
          ...(data.sample
            ? [
                text(
                  {
                    padding: "8px 18px",
                    borderRadius: 999,
                    background: RIBBON,
                    color: PAPER,
                    fontWeight: 700,
                    letterSpacing: 1.4,
                  },
                  "SAMPLE DATA",
                  "ribbon",
                ),
              ]
            : []),
        ],
        "footer",
      ),
    ],
    "card",
  );
}

function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "same-site") return true;
  if (site !== null) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  const parsed = shareCardSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "invalid-payload" }, { status: 400 });
  }
  // Sized to the number of awards rather than a fixed banner: this image is shared into a chat,
  // not used as a link preview, so a one-award card should not carry three rows of dead space.
  const height = CARD_CHROME_HEIGHT + parsed.data.awards.length * AWARD_ROW_HEIGHT;
  return new ImageResponse(card(parsed.data), { width: 1200, height });
}
