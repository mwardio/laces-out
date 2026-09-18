import { readFile, stat, writeFile } from "node:fs/promises";
import { buildRosMarginalDevelopmentReport } from "../src/ros-marginal-development.js";
import type { FirstPartyRosPosition } from "@laces-out/projections";

const required = [
  "--candidate-report",
  "--candidate-sha256",
  "--previous-report",
  "--previous-sha256",
  "--forecast-season",
  "--evaluation-season",
  "--positions",
  "--out",
];
const optional = ["--interval-training-report", "--interval-training-sha256"];
const allowed = [...required, ...optional];
const options = new Map<string, string>();
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  const name = argument.slice(0, separator),
    value = argument.slice(separator + 1);
  if (separator < 0 || !allowed.includes(name) || options.has(name) || !value.trim())
    throw new Error(`Invalid or duplicate marginal evaluation option: ${name}`);
  options.set(name, value);
}
for (const name of required)
  if (!options.has(name)) throw new Error(`Required option: ${name}=<value>`);
if (options.has(optional[0]!) !== options.has(optional[1]!))
  throw new Error("Interval training report and pinned SHA256 must be supplied together");
const readBounded = async (name: string) => {
  const location = options.get(name)!;
  const info = await stat(location);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error("Expected a completed report file no larger than 64 MiB");
  const bytes = await readFile(location);
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Report exceeded 64 MiB while reading");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error("Report must contain valid UTF-8 bytes");
  return text;
};
const [candidateReportJson, previousReportJson, intervalTrainingReportJson] = await Promise.all([
  readBounded("--candidate-report"),
  readBounded("--previous-report"),
  options.has("--interval-training-report")
    ? readBounded("--interval-training-report")
    : Promise.resolve(undefined),
]);
const result = buildRosMarginalDevelopmentReport({
  candidateReportJson,
  previousReportJson,
  candidateReportChecksum: options.get("--candidate-sha256")!,
  previousReportChecksum: options.get("--previous-sha256")!,
  ...(intervalTrainingReportJson === undefined
    ? {}
    : {
        intervalTrainingReportJson,
        intervalTrainingReportChecksum: options.get("--interval-training-sha256")!,
      }),
  forecastSeason: Number(options.get("--forecast-season")),
  evaluationSeason: Number(options.get("--evaluation-season")),
  positions: options.get("--positions")!.split(",") as FirstPartyRosPosition[],
});
// Exclusive creation preserves prior evidence. A failed or interrupted write cannot be reused as
// a valid report: it must parse completely and match its separately recorded checksum.
await writeFile(options.get("--out")!, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
process.stderr.write(
  `${result.state}; ${result.marginalDevelopment.reasons.length} reasons; development evidence only\n`,
);
if (result.state !== "development-screen-passed") process.exitCode = 1;
