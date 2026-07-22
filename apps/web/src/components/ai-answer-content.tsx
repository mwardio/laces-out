import type { ReactNode } from "react";

import { parseAiAnswer, type AiAnswerBlock, type AiAnswerInline } from "../lib/ai-answer";
import styles from "./ai-answer-content.module.css";

function inlineContent(nodes: readonly AiAnswerInline[], keyPrefix: string): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "strong":
        return <strong key={key}>{inlineContent(node.children, key)}</strong>;
      case "emphasis":
        return <em key={key}>{inlineContent(node.children, key)}</em>;
      case "code":
        return <code key={key}>{node.value}</code>;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {inlineContent(node.children, key)}
          </a>
        );
    }
  });
}

function linesContent(lines: readonly (readonly AiAnswerInline[])[], keyPrefix: string): ReactNode {
  return lines.map((line, index) => (
    <span className={styles.line} key={`${keyPrefix}-${index}`}>
      {inlineContent(line, `${keyPrefix}-${index}`)}
    </span>
  ));
}

function AnswerBlock({ block, index }: { readonly block: AiAnswerBlock; readonly index: number }) {
  const keyPrefix = `answer-${index}`;
  switch (block.type) {
    case "heading":
      return <h4>{inlineContent(block.children, keyPrefix)}</h4>;
    case "paragraph":
      return <p>{linesContent(block.lines, keyPrefix)}</p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List>
          {block.items.map((item, itemIndex) => (
            <li key={`${keyPrefix}-${itemIndex}`}>
              {inlineContent(item, `${keyPrefix}-${itemIndex}`)}
            </li>
          ))}
        </List>
      );
    }
    case "quote":
      return <blockquote>{linesContent(block.lines, keyPrefix)}</blockquote>;
    case "codeBlock":
      return (
        <pre>
          <code>{block.value}</code>
        </pre>
      );
  }
}

export function AiAnswerContent({ answer }: { readonly answer: string }) {
  const blocks = parseAiAnswer(answer);
  return (
    <div className={styles.content}>
      {blocks.map((block, index) => (
        <AnswerBlock block={block} index={index} key={`${block.type}-${index}`} />
      ))}
    </div>
  );
}
