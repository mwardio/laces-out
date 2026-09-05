/**
 * Rule-level unused-CSS estimator.
 *
 * Usage: node scripts/css-usage.mjs <stylesheet path or URL> <html path or URL> [--verbose]
 *
 * Walks a built stylesheet with postcss and counts a rule as "used" when at least one of its
 * selectors could match the given HTML: every compound in that selector names only classes, ids,
 * element names, and attribute names the document actually contains. Combinators, pseudo-classes,
 * and pseudo-elements are ignored; `:is()`/`:where()` hold when any argument holds, `:not()` and
 * `:has()` always hold.
 *
 * It is deliberately approximate — selector presence, not runtime coverage — so it over-reports
 * usage for rules needing a specific tree shape or interaction state, and it ignores bytes spent on
 * at-rule wrappers. Cheap, deterministic, and dependency-free beyond postcss (hoisted at the
 * repository root): an audit aid, not a substitute for a coverage trace.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import postcss from "postcss";

const SIMPLE_TOKEN =
  /^(?:\*|[A-Za-z][\w-]*|\.[^.#:[\s]+|#[^.#:[\s]+|\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?)/;
const COMBINATORS = [" ", "\t", "\n", ">", "+", "~"];

function splitTopLevel(input, separators) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const character of input) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (depth === 0 && separators.includes(character)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function tokenizeCompound(compound) {
  const tokens = [];
  let rest = compound;
  while (rest.length > 0) {
    const match = SIMPLE_TOKEN.exec(rest);
    if (match) tokens.push(match[0]);
    rest = rest.slice(match ? match[0].length : 1);
  }
  return tokens;
}

function compoundMatches(compound, page) {
  for (const token of tokenizeCompound(compound)) {
    if (token.startsWith("::")) continue;
    if (token.startsWith(":")) {
      const open = token.indexOf("(");
      const name = open === -1 ? "" : token.slice(1, open).toLowerCase();
      if (name !== "is" && name !== "where" && name !== "matches") continue;
      const alternatives = splitTopLevel(token.slice(open + 1, -1), [","]);
      if (!alternatives.some((alternative) => selectorMatches(alternative, page))) return false;
    } else if (token.startsWith(".")) {
      if (!page.classes.has(token.slice(1))) return false;
    } else if (token.startsWith("#")) {
      if (!page.ids.has(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      const name = /^\[\s*([\w-]+)/.exec(token)?.[1];
      if (name && !page.attributes.has(name.toLowerCase())) return false;
    } else if (token !== "*" && !page.tags.has(token.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** True when `selector` could match a document with the given vocabulary. */
export function selectorMatches(selector, page) {
  return splitTopLevel(selector, COMBINATORS).every((compound) => compoundMatches(compound, page));
}

/** Collect the class, id, element, and attribute vocabulary of an HTML document. */
export function readPage(html) {
  const page = { classes: new Set(), ids: new Set(), tags: new Set(), attributes: new Set() };
  for (const element of html.matchAll(/<([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    page.tags.add(element[1].toLowerCase());
    for (const attribute of element[2].matchAll(
      /([\w:.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
    )) {
      const name = attribute[1].toLowerCase();
      page.attributes.add(name);
      const value = (attribute[2] ?? "").replace(/^["']|["']$/g, "");
      if (name === "class") for (const token of value.split(/\s+/)) page.classes.add(token);
      if (name === "id" && value.length > 0) page.ids.add(value);
    }
  }
  page.classes.delete("");
  return page;
}

/** Classify every rule in `css` against `html`, returning totals and the unused rules. */
export function analyze(css, html, from) {
  const page = readPage(html);
  const totals = { used: 0, unused: 0, usedBytes: 0, unusedBytes: 0, keyframeRules: 0 };
  const unused = [];
  postcss.parse(css, { from }).walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) {
      totals.keyframeRules += 1;
      return;
    }
    const bytes = Buffer.byteLength(rule.toString());
    if (rule.selectors.some((selector) => selectorMatches(selector, page))) {
      totals.used += 1;
      totals.usedBytes += bytes;
      return;
    }
    totals.unused += 1;
    totals.unusedBytes += bytes;
    unused.push({ selector: rule.selector, bytes, line: rule.source?.start?.line ?? 0 });
  });
  return { totals, unused };
}

async function load(reference) {
  if (/^https?:\/\//.test(reference)) {
    const response = await fetch(reference);
    if (!response.ok) throw new Error(`${reference} responded ${response.status}`);
    return await response.text();
  }
  return await readFile(reference, "utf8");
}

async function main() {
  const [stylesheet, page] = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  if (!stylesheet || !page) {
    console.error("usage: node scripts/css-usage.mjs <stylesheet> <html> [--verbose]");
    process.exitCode = 2;
    return;
  }
  const [css, html] = await Promise.all([load(stylesheet), load(page)]);
  const { totals, unused } = analyze(css, html, stylesheet);
  const rules = totals.used + totals.unused;
  const bytes = totals.usedBytes + totals.unusedBytes;
  const share = (part, whole) => (whole === 0 ? "0.0" : ((part / whole) * 100).toFixed(1));
  if (process.argv.includes("--verbose")) {
    for (const rule of [...unused].sort((a, b) => b.bytes - a.bytes)) {
      console.log(`unused  line ${rule.line}\t${rule.bytes}B\t${rule.selector}`);
    }
  }
  console.log(`stylesheet: ${stylesheet}`);
  console.log(`html:       ${page}`);
  console.log(`rules:      ${rules} (${totals.keyframeRules} keyframe rules skipped)`);
  console.log(`used:       ${totals.used} (${share(totals.used, rules)}%), ${totals.usedBytes} B`);
  console.log(
    `unused:     ${totals.unused} (${share(totals.unused, rules)}%), ${totals.unusedBytes} B` +
      ` (${share(totals.unusedBytes, bytes)}% of rule bytes)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
