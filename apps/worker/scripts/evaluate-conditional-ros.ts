import { lstat, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRosConditionalDevelopmentReport } from "../src/ros-conditional-development.js";

const REQUIRED = [
  "--candidate-report",
  "--candidate-sha256",
  "--previous-report",
  "--previous-sha256",
  "--protocol",
  "--protocol-sha256",
  "--source-manifest-sha256",
  "--scoring-profile-key",
  "--out",
] as const;
const OPTIONAL = ["--interval-training-report", "--interval-training-sha256"] as const;
const ALLOWED: readonly string[] = [...REQUIRED, ...OPTIONAL];
const REPORT_BYTE_LIMIT = 64 * 1024 * 1024;
const PROTOCOL_BYTE_LIMIT = 1024 * 1024;

/** Fixed full-portfolio development scope: deliberately no year, position or threshold flags. */
export function parseConditionalRosArguments(argv: readonly string[]): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator),
      value = argument.slice(separator + 1);
    if (separator < 0 || !ALLOWED.includes(name) || options.has(name) || !value.trim())
      throw new Error(`Invalid or duplicate conditional evaluation option: ${name}`);
    options.set(name, value);
  }
  for (const name of REQUIRED)
    if (!options.has(name)) throw new Error(`Required option: ${name}=<value>`);
  if (options.has("--interval-training-report") !== options.has("--interval-training-sha256"))
    throw new Error("Interval training report and pinned SHA256 must be supplied together");
  for (const [name, value] of options)
    if (name.endsWith("-sha256") && !/^[a-f0-9]{64}$/u.test(value))
      throw new Error(`Expected an exact lowercase SHA256: ${name}`);
  return options;
}

/** Bound allocation and actual reads, including growth after fstat; preserve the exact UTF-8 bytes. */
export async function readBoundedConditionalRosFile(location: string, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > REPORT_BYTE_LIMIT)
    throw new Error("Invalid conditional input byte limit");
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number")
    throw new Error("This platform cannot securely open bounded conditional input files");
  const file = await open(
    location,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes)
      throw new Error(`Expected a completed regular file no larger than ${maximumBytes} bytes`);
    // One extra byte detects growth without allocating an unbounded readFile buffer.
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > info.size || length > maximumBytes)
      throw new Error("Conditional input grew beyond its bounded initial size while reading");
    const contents = bytes.subarray(0, length);
    const text = contents.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(contents))
      throw new Error("Conditional input must contain valid UTF-8 bytes");
    return text;
  } finally {
    await file.close();
  }
}

/** Read completed pinned artifacts and create one new development report. No simulation or I/O clients. */
export async function runConditionalRosDevelopment(argv: readonly string[]) {
  const options = parseConditionalRosArguments(argv);
  const output = options.get("--out")!;
  try {
    await lstat(output);
    throw new Error(
      "Conditional development output already exists; evidence cannot be overwritten",
    );
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const [candidateReportJson, previousReportJson, intervalTrainingReportJson, protocolText] =
    await Promise.all([
      readBoundedConditionalRosFile(options.get("--candidate-report")!, REPORT_BYTE_LIMIT),
      readBoundedConditionalRosFile(options.get("--previous-report")!, REPORT_BYTE_LIMIT),
      options.has("--interval-training-report")
        ? readBoundedConditionalRosFile(
            options.get("--interval-training-report")!,
            REPORT_BYTE_LIMIT,
          )
        : Promise.resolve(undefined),
      readBoundedConditionalRosFile(options.get("--protocol")!, PROTOCOL_BYTE_LIMIT),
    ]);
  const result = buildRosConditionalDevelopmentReport({
    candidateReportJson,
    candidateReportChecksum: options.get("--candidate-sha256")!,
    previousReportJson,
    previousReportChecksum: options.get("--previous-sha256")!,
    ...(intervalTrainingReportJson === undefined
      ? {}
      : {
          intervalTrainingReportJson,
          intervalTrainingReportChecksum: options.get("--interval-training-sha256")!,
        }),
    protocolText,
    protocolChecksum: options.get("--protocol-sha256")!,
    sourceManifestChecksum: options.get("--source-manifest-sha256")!,
    scoringProfileKey: options.get("--scoring-profile-key")!,
  });
  // The final exclusive create also closes the race after the early existence check. Partial
  // interrupted files cannot qualify as evidence without complete JSON and a separate byte pin.
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runConditionalRosDevelopment(process.argv.slice(2));
  process.stderr.write(
    `${result.state}; ${result.conditionalDevelopment.reasons.length} reasons; development evidence only\n`,
  );
  if (result.state !== "development-screen-passed") process.exitCode = 1;
}
