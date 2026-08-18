import * as React from 'react';

/**
 * AiAnswerContent — from @laces-out/web@0.1.0.
 */
export interface AiAnswerContentProps {
  /** Assistant answer text. Supports headings, ordered and unordered lists, block quotes, fenced code, and inline strong/emphasis/code/links. Inline source tags such as [League overview] are stripped before rendering. */
  answer: string;
}

export declare const AiAnswerContent: React.ComponentType<AiAnswerContentProps>;
