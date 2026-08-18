import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  composeFirstPartyRosValidationReport,
  sha256Text,
  type FirstPartyRosSourceEquivalence,
  type FirstPartyRosValidationSlice,
} from "../src/first-party-ros-compose.js";

function stringOption(name: string): string | undefined {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return raw?.slice(name.length + 1);
}

function readReport(path: string): FirstPartyRosValidationSlice {
  const raw = readFileSync(path, "utf8");
  return { id: path, sha256: sha256Text(raw), report: JSON.parse(raw) };
}

function readSourceEquivalence(path: string): FirstPartyRosSourceEquivalence {
  const raw = readFileSync(path, "utf8");
  return { id: path, sha256: sha256Text(raw), audit: JSON.parse(raw) };
}

function fail(message: string): never {
  throw new Error(message);
}

function main(): void {
  const basePath = stringOption("--base") ?? fail("Missing required --base=<complete-report.json>");
  const outPath = stringOption("--out") ?? fail("Missing required --out=<composed-report.json>");
  const slicePaths = process.argv
    .filter((argument) => argument.startsWith("--slice="))
    .map((argument) => argument.slice("--slice=".length));
  const sourceEquivalencePaths = process.argv
    .filter((argument) => argument.startsWith("--source-equivalence="))
    .map((argument) => argument.slice("--source-equivalence=".length));
  if (slicePaths.length === 0) fail("Pass at least one --slice=<position-report.json>");
  if (outPath === basePath || slicePaths.includes(outPath)) {
    fail("--out must not overwrite a source report");
  }
  if (existsSync(outPath) && !process.argv.includes("--overwrite")) {
    fail(`${outPath} already exists; pass --overwrite to replace it`);
  }

  const report = composeFirstPartyRosValidationReport({
    base: readReport(basePath),
    slices: slicePaths.map(readReport),
    sourceEquivalences: sourceEquivalencePaths.map(readSourceEquivalence),
    composedAt: new Date().toISOString(),
  });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        state: "composed",
        base: basePath,
        slices: slicePaths,
        out: outPath,
        reportState: (report.report as Record<string, unknown>).state,
        blockers: (report.report as Record<string, unknown>).blockers,
        publicationPolicyChecksum: (report.champion as Record<string, unknown>)
          .publicationPolicyChecksum,
      },
      null,
      2,
    )}\n`,
  );
}

main();
