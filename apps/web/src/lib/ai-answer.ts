const INLINE_SOURCE_TAG_PATTERN = /\[(?:League overview|Decision Desk|League analytics)\]/giu;
const SOURCE_ONLY_LINE_PATTERN =
  /^\s*(?:#{1,6}\s*)?(?:sources?|references?)\s*:?\s*(?:\n\s*)?(?:\[(?:League overview|Decision Desk|League analytics)\][,\s·]*)+\s*$/gimu;

export type AiAnswerInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong"; readonly children: readonly AiAnswerInline[] }
  | { readonly type: "emphasis"; readonly children: readonly AiAnswerInline[] }
  | { readonly type: "code"; readonly value: string }
  | {
      readonly type: "link";
      readonly href: string;
      readonly children: readonly AiAnswerInline[];
    };

export type AiAnswerBlock =
  | {
      readonly type: "paragraph";
      readonly lines: readonly (readonly AiAnswerInline[])[];
    }
  | {
      readonly type: "heading";
      readonly level: number;
      readonly children: readonly AiAnswerInline[];
    }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly AiAnswerInline[])[];
    }
  | {
      readonly type: "quote";
      readonly lines: readonly (readonly AiAnswerInline[])[];
    }
  | { readonly type: "codeBlock"; readonly value: string };

export function aiAnswerForDisplay(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(SOURCE_ONLY_LINE_PATTERN, "")
    .replace(INLINE_SOURCE_TAG_PATTERN, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[ \t]+(?=\n|$)/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function appendText(nodes: AiAnswerInline[], value: string): void {
  if (!value) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") {
    nodes[nodes.length - 1] = { type: "text", value: previous.value + value };
  } else {
    nodes.push({ type: "text", value });
  }
}

interface InlineMatch {
  readonly index: number;
  readonly length: number;
  readonly node: AiAnswerInline;
}

function firstInlineMatch(value: string): InlineMatch | undefined {
  const candidates: InlineMatch[] = [];
  const markdownLink = /\[([^\]\n]+)\]\(([^\s)]+)\)/u.exec(value);
  if (markdownLink?.index !== undefined) {
    const href = safeHttpUrl(markdownLink[2] ?? "");
    if (href) {
      candidates.push({
        index: markdownLink.index,
        length: markdownLink[0].length,
        node: { type: "link", href, children: parseAiAnswerInline(markdownLink[1] ?? "") },
      });
    }
  }

  const strong = /(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__)/u.exec(value);
  if (strong?.index !== undefined) {
    const content = strong[1] ?? strong[2] ?? "";
    candidates.push({
      index: strong.index,
      length: strong[0].length,
      node: { type: "strong", children: parseAiAnswerInline(content) },
    });
  }

  const emphasis = /(?:\*([^*\n]+)\*|_([^_\n]+)_)/u.exec(value);
  if (emphasis?.index !== undefined) {
    const content = emphasis[1] ?? emphasis[2] ?? "";
    candidates.push({
      index: emphasis.index,
      length: emphasis[0].length,
      node: { type: "emphasis", children: parseAiAnswerInline(content) },
    });
  }

  const code = /`([^`\n]+)`/u.exec(value);
  if (code?.index !== undefined) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      node: { type: "code", value: code[1] ?? "" },
    });
  }

  const automaticLink = /https?:\/\/[^\s<>]+/iu.exec(value);
  if (automaticLink?.index !== undefined) {
    const visible = automaticLink[0].replace(/[.,;:!?]+$/u, "");
    const href = safeHttpUrl(visible);
    if (href) {
      candidates.push({
        index: automaticLink.index,
        length: visible.length,
        node: { type: "link", href, children: [{ type: "text", value: visible }] },
      });
    }
  }

  return candidates.sort(
    (left, right) => left.index - right.index || right.length - left.length,
  )[0];
}

export function parseAiAnswerInline(value: string): readonly AiAnswerInline[] {
  const nodes: AiAnswerInline[] = [];
  let remaining = value;
  while (remaining) {
    const match = firstInlineMatch(remaining);
    if (!match) {
      appendText(nodes, remaining);
      break;
    }
    appendText(nodes, remaining.slice(0, match.index));
    nodes.push(match.node);
    remaining = remaining.slice(match.index + match.length);
  }
  return nodes;
}

export function parseAiAnswer(value: string): readonly AiAnswerBlock[] {
  const lines = aiAnswerForDisplay(value).split("\n");
  const blocks: AiAnswerBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*```/u.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/u.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "codeBlock", value: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 2,
        children: parseAiAnswerInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    const unordered = /^\s*[-+*]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items: (readonly AiAnswerInline[])[] = [];
      while (index < lines.length) {
        const item = isOrdered
          ? /^\s*\d+[.)]\s+(.+)$/u.exec(lines[index] ?? "")
          : /^\s*[-+*]\s+(.+)$/u.exec(lines[index] ?? "");
        if (!item) break;
        items.push(parseAiAnswerInline(item[1] ?? ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const quoteLines: (readonly AiAnswerInline[])[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? "")) {
        quoteLines.push(parseAiAnswerInline((lines[index] ?? "").replace(/^\s*>\s?/u, "")));
        index += 1;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    const paragraphLines: (readonly AiAnswerInline[])[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";
      if (!paragraphLine.trim()) break;
      if (
        paragraphLines.length > 0 &&
        (/^(?:#{1,6})\s+/u.test(paragraphLine.trim()) ||
          /^\s*(?:[-+*]|\d+[.)])\s+/u.test(paragraphLine) ||
          /^\s*>\s?/u.test(paragraphLine) ||
          /^\s*```/u.test(paragraphLine))
      ) {
        break;
      }
      paragraphLines.push(parseAiAnswerInline(paragraphLine));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraphLines });
  }

  return blocks;
}
