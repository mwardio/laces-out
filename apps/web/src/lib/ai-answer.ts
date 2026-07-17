const INLINE_SOURCE_TAG_PATTERN = /\[(?:League overview|Decision Desk|League analytics)\]/gu;

export function aiAnswerForDisplay(value: string): string {
  return value
    .replace(INLINE_SOURCE_TAG_PATTERN, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[ \t]+(?=\n|$)/gu, "")
    .trim();
}
