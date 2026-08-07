import { AiAnswerContent } from "@laces-out/web";

/* Shaped like a real Decision Desk reply: a lead paragraph, a ranked list, a
   pull quote, and an inline stat line. The [League analytics] tag is left in
   deliberately — the component strips source tags, and the card proves it. */
const startSitAnswer = `## Start Bijan Robinson over Kenneth Walker

Robinson is the **clear start** this week. Atlanta has run 61% of their
first-half plays out of 11 personnel, and Robinson is on the field for 88% of
them. [League analytics]

1. **Volume** — 19.4 touches per game, third among RBs since Week 4.
2. **Matchup** — Carolina is allowing 4.9 yards per carry to the left side.
3. **Game script** — Atlanta is favored by 6.5, which keeps the run rate high.

> Walker is not a bad play. He is a *worse* play, and only because Seattle is
> likely trailing by two scores in the second half.

Robinson projects at \`18.2\` points against Walker's \`13.6\`. That gap is
wider than it looks: Walker's floor collapses in negative game script.`;

const shortAnswer = `Yes — drop Gus Edwards. He is behind two backs on the depth
chart and has not seen a red-zone carry since Week 3. Prefer *any* starting
receiver on your waiver list.`;

export function Answer() {
  return <AiAnswerContent answer={startSitAnswer} />;
}

export function ShortReply() {
  return <AiAnswerContent answer={shortAnswer} />;
}
