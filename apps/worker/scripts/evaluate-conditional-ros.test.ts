import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConditionalRosArguments,
  readBoundedConditionalRosFile,
  runConditionalRosDevelopment,
} from "./evaluate-conditional-ros.js";

const SHA = "a".repeat(64);
function argv(directory = "/synthetic") {
  return [
    `--candidate-report=${directory}/candidate.json`,
    `--candidate-sha256=${SHA}`,
    `--previous-report=${directory}/previous.json`,
    `--previous-sha256=${SHA}`,
    `--protocol=${directory}/protocol.md`,
    `--protocol-sha256=${SHA}`,
    `--source-manifest-sha256=${SHA}`,
    '--scoring-profile-key={"passingYards":0.04}',
    `--out=${directory}/development.json`,
  ];
}
const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "conditional-cli-controls-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("isolated pinned conditional development CLI", () => {
  it("requires every exact pin and accepts paired training without allowing scope or tuning flags", () => {
    const valid = argv();
    expect(parseConditionalRosArguments(valid).size).toBe(9);
    for (let index = 0; index < valid.length; index++)
      expect(() => parseConditionalRosArguments(valid.filter((_, i) => i !== index))).toThrow(
        /Required option/u,
      );
    for (const extra of [
      "--positions=DST",
      "--forecast-season=2027",
      "--evaluation-season=2024",
      "--minimum-samples=1",
      "--out=/different",
      "--candidate-report",
      "--unknown=value",
    ])
      expect(() => parseConditionalRosArguments([...valid, extra])).toThrow(/option/u);
    expect(() =>
      parseConditionalRosArguments([...valid, "--interval-training-report=training.json"]),
    ).toThrow(/together/u);
    expect(() =>
      parseConditionalRosArguments([...valid, `--interval-training-sha256=${SHA}`]),
    ).toThrow(/together/u);
    expect(
      parseConditionalRosArguments([
        ...valid,
        "--interval-training-report=training.json",
        `--interval-training-sha256=${SHA}`,
      ]).size,
    ).toBe(11);
    for (const pin of ["short", "A".repeat(64), `${SHA} `])
      expect(() =>
        parseConditionalRosArguments(
          valid.map((arg) => arg.replace(`--candidate-sha256=${SHA}`, `--candidate-sha256=${pin}`)),
        ),
      ).toThrow(/SHA256/u);
  });

  it("preserves exact valid UTF-8 and refuses malformed, oversized or non-file input", async () => {
    const directory = await temporary();
    const file = join(directory, "bytes.txt");
    const original = Buffer.from("\ufeffsnowman☃\r\n");
    await writeFile(file, original);
    expect(Buffer.from(await readBoundedConditionalRosFile(file, original.length))).toEqual(
      original,
    );
    await expect(readBoundedConditionalRosFile(file, original.length - 1)).rejects.toThrow(
      /no larger/u,
    );
    await expect(readBoundedConditionalRosFile(directory, 1024)).rejects.toThrow(/regular file/u);
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await expect(readBoundedConditionalRosFile(file, 1024)).rejects.toThrow(/UTF-8/u);
  });

  it("refuses existing output before reading input and preserves its exact bytes", async () => {
    const directory = await temporary();
    const output = join(directory, "development.json");
    await writeFile(output, "previous pinned evidence\n");
    await expect(runConditionalRosDevelopment(argv(directory))).rejects.toThrow(/already exists/u);
    expect(await readFile(output, "utf8")).toBe("previous pinned evidence\n");
  });

  it("rejects symlink inputs without following their target", async () => {
    const directory = await temporary();
    const target = join(directory, "target.txt"),
      link = join(directory, "link.txt");
    await writeFile(target, "valid UTF-8 target\n");
    await symlink(target, link);
    await expect(readBoundedConditionalRosFile(link, 1024)).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await readFile(target, "utf8")).toBe("valid UTF-8 target\n");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer",
    async () => {
      const directory = await temporary();
      const fifo = join(directory, "unwritten.fifo");
      await promisify(execFile)("mkfifo", [fifo]);
      await expect(readBoundedConditionalRosFile(fifo, 1024)).rejects.toThrow(/regular file/u);
    },
    2_000,
  );

  it("creates no output when completed inputs fail their protocol byte pin", async () => {
    const directory = await temporary();
    await Promise.all([
      writeFile(join(directory, "candidate.json"), "{}"),
      writeFile(join(directory, "previous.json"), "{}"),
      writeFile(join(directory, "protocol.md"), "changed protocol\n"),
    ]);
    await expect(runConditionalRosDevelopment(argv(directory))).rejects.toThrow(
      /protocol byte pin/u,
    );
    await expect(readFile(join(directory, "development.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
