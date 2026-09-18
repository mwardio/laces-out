import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PgBoss, Job } from "pg-boss";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueNames, registerWorkers, type ProjectionRefreshJob } from "./jobs.js";
import {
  FirstPartyProjectionProcess,
  WEEKLY_PROJECTION_PROCESS_HEAP_MB,
} from "./first-party-projection-process.js";
import {
  isWeeklyProjectionProcessRequest,
  weeklyProjectionProcessError,
} from "./first-party-projection-process-protocol.js";

const directories: string[] = [];
const clients: FirstPartyProjectionProcess[] = [];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function fixture(
  body: string,
  options: { startupTimeoutMs?: number; terminationTimeoutMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "weekly-process-"));
  directories.push(directory);
  const path = join(directory, "worker.mjs");
  await writeFile(path, body);
  const events: Readonly<Record<string, unknown>>[] = [];
  const client = new FirstPartyProjectionProcess({
    connectionString: "postgres://fixture-unused",
    workerEntry: pathToFileURL(path),
    onEvent: (event) => events.push(event),
    ...options,
  });
  clients.push(client);
  return { client, events };
}
const context = () => ({ jobId: "test-weekly-job", signal: new AbortController().signal });
const ready = `process.send({type:'ready',protocol:1});`;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

describe("persistent weekly projection process", () => {
  it("starts lazily and closes without spawning unused work", async () => {
    const { client, events } = await fixture("throw new Error('must not run');");
    await client.close();
    expect(events).toEqual([]);
    await expect(client.refreshProjections({ season: 2026 }, context())).rejects.toThrow("closed");
  });

  it("keeps the parent responsive, reuses the same child, and excludes parent secrets/options", async () => {
    vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096");
    vi.stubEnv("WEEKLY_TEST_PRIVATE_SECRET", "must-not-be-inherited");
    const { client, events } = await fixture(`
      import {getHeapStatistics} from 'node:v8';
      if(process.env.WEEKLY_TEST_PRIVATE_SECRET || process.env.NODE_OPTIONS!=='' || !process.execArgv.includes('--max-old-space-size=${WEEKLY_PROJECTION_PROCESS_HEAP_MB}'))process.exit(2);
      let count=0;
      ${ready}
      process.on('message',message=>{
        if(Object.keys(message.job).some(key=>!['season','week','horizon','reason'].includes(key)))process.exit(3);
        const until=Date.now()+200;while(Date.now()<until){}
        process.send({type:'result',id:message.id,ok:true,memory:{rss:++count,heapLimit:getHeapStatistics().heap_size_limit}});
      });
    `);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await client.refreshProjections(
        { season: 2026, week: 2, ...{ privateIgnored: "not sent" } },
        context(),
      );
      const firstTicks = ticks;
      await client.refreshProjections({ season: 2026, week: 2 }, context());
      expect(ticks - firstTicks).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
    }
    expect(events.filter((e) => e.event === "weekly-projection-process-ready")).toHaveLength(1);
    const resultEvents = events.filter((e) => e.event === "weekly-projection-process-result");
    expect(resultEvents.map((e) => (e.memory as { rss: number }).rss)).toEqual([1, 2]);
    expect((resultEvents[0]!.memory as { heapLimit: number }).heapLimit).toBeLessThan(
      2_200 * 1024 * 1024,
    );
  }, 10_000);

  it("rejects concurrent requests while leaving the active job intact", async () => {
    const { client } = await fixture(
      `${ready} process.on('message',m=>setTimeout(()=>process.send({type:'result',id:m.id,ok:true}),150));`,
    );
    const first = client.refreshProjections({ season: 2026 }, context());
    await expect(client.refreshProjections({ season: 2026 }, context())).rejects.toThrow(
      "active request",
    );
    await first;
  });

  it("captures the validated request before asynchronous startup", async () => {
    const { client } = await fixture(
      `${ready} process.on('message',m=>process.send({type:'result',id:m.id,ok:m.job.season===2026&&m.jobId==='original'}));`,
    );
    const job = { season: 2026 };
    const mutableContext = { jobId: "original", signal: new AbortController().signal };
    const pending = client.refreshProjections(job, mutableContext);
    job.season = 2027;
    mutableContext.jobId = "changed";
    await pending;
  });

  it("waits for a busy child's actual close on abort, then starts a fresh child", async () => {
    const { client, events } = await fixture(
      `
      process.on('SIGTERM',()=>{});
      ${ready}
      process.on('message',m=>{
        if(m.job.week===1){const until=Date.now()+5000;while(Date.now()<until){}}
        process.send({type:'result',id:m.id,ok:true});
      });
    `,
      { terminationTimeoutMs: 75 },
    );
    const controller = new AbortController();
    const pending = client.refreshProjections(
      { season: 2026, week: 1 },
      { jobId: "abort", signal: controller.signal },
    );
    const observed = pending.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(events.some((e) => e.event === "weekly-projection-process-ready")).toBe(true),
    );
    await wait(30);
    const pid = events.find((e) => e.event === "weekly-projection-process-ready")!.pid as number;
    controller.abort();
    await expect(client.refreshProjections({ season: 2026, week: 2 }, context())).rejects.toThrow(
      "active request",
    );
    expect(await observed).toMatchObject({ message: "Weekly projection request aborted" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      events.some((e) => e.event === "weekly-projection-process-closed" && e.pid === pid),
    ).toBe(true);
    await client.refreshProjections({ season: 2026, week: 2 }, context());
    expect(events.filter((e) => e.event === "weekly-projection-process-ready")).toHaveLength(2);
  }, 10_000);

  it.each([
    ["exits before ready", "process.exit(9);", "exited|IPC disconnected"],
    [
      "never becomes ready",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
      "startup timed out",
    ],
    [
      "sends the wrong request identity",
      `${ready} process.on('message',m=>process.send({type:'result',id:m.id+1,ok:true}));`,
      "Invalid",
    ],
    [
      "disconnects its IPC channel",
      `${ready} process.on('message',()=>{process.disconnect();setInterval(()=>{},1000);});`,
      "IPC disconnected",
    ],
  ])("fails only after process close when a child %s", async (_label, body, expected) => {
    const { client, events } = await fixture(body, {
      startupTimeoutMs: 500,
      terminationTimeoutMs: 50,
    });
    await expect(client.refreshProjections({ season: 2026 }, context())).rejects.toThrow(
      new RegExp(expected),
    );
    expect(events.at(-1)?.event).toBe("weekly-projection-process-closed");
  });

  it("preserves a valid child after a bounded service failure, without leaking raw errors", async () => {
    const { client, events } = await fixture(
      `${ready} let count=0;process.on('message',m=>process.send(++count===1?{type:'result',id:m.id,ok:false,error:{name:'PostgresError',code:'23505',message:'postgres://private:secret@host'}}:{type:'result',id:m.id,ok:true}));`,
    );
    await expect(client.refreshProjections({ season: 2026 }, context())).rejects.toThrow(
      "PostgresError, 23505",
    );
    await client.refreshProjections({ season: 2026 }, context());
    expect(events.filter((e) => e.event === "weekly-projection-process-ready")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("propagates a transient input-epoch failure through real IPC to the queue handler, then permits redelivery", async () => {
    const runtime = new URL("./first-party-projection-process-runtime.ts", import.meta.url).href;
    const { client, events } = await fixture(`
      import {startWeeklyProjectionProcess} from ${JSON.stringify(runtime)};
      let attempts=0;
      startWeeklyProjectionProcess({
        connectionString:process.env.DATABASE_URL,
        createService:()=>({refreshProjections:async()=>{
          if(++attempts===1)throw Object.assign(new Error('private source payload must not cross IPC'),{
            code:'PROJECTION_INPUT_EPOCH_CHANGED'
          });
        }})
      });
    `);
    type Handler = (jobs: Job<ProjectionRefreshJob>[]) => Promise<void>;
    const handlers = new Map<string, Handler>();
    const boss = {
      work: (name: string, ...args: unknown[]) => {
        handlers.set(name, args.at(-1) as Handler);
        return Promise.resolve(name);
      },
    } as unknown as PgBoss;
    const info = vi.fn();
    await registerWorkers(boss, { info } as unknown as Logger, { projectionRefresh: client });
    const handler = handlers.get(queueNames.refreshProjections)!;
    const delivery: Job<ProjectionRefreshJob> = {
      id: "retryable-weekly-job",
      name: queueNames.refreshProjections,
      data: { season: 2026, week: 2, horizon: "weekly", reason: "on-demand" },
      expireInSeconds: 900,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };

    await expect(handler([delivery])).rejects.toThrow("Error, PROJECTION_INPUT_EPOCH_CHANGED");
    expect(info).not.toHaveBeenCalled();
    await expect(handler([delivery])).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledExactlyOnceWith(
      { jobId: delivery.id, ...delivery.data },
      "projection refresh completed",
    );
    expect(
      events.filter((event) => event.event === "weekly-projection-process-ready"),
    ).toHaveLength(1);
    const results = events.filter((event) => event.event === "weekly-projection-process-result");
    expect(results.map((event) => event.ok)).toEqual([false, true]);
    expect(results[0]?.error).toEqual({ name: "Error", code: "PROJECTION_INPUT_EPOCH_CHANGED" });
    expect(JSON.stringify(events)).not.toContain("private source payload");
  }, 15_000);

  it("validates request envelopes and only serializes safe error tokens", () => {
    expect(
      isWeeklyProjectionProcessRequest({
        type: "refresh",
        id: 1,
        jobId: "test",
        job: { season: 2026, week: 2 },
      }),
    ).toBe(true);
    for (const value of [
      null,
      {},
      { type: "refresh", id: 1, jobId: "test", job: { season: 1 } },
      { type: "refresh", id: NaN, jobId: "test", job: { season: 2026 } },
    ])
      expect(isWeeklyProjectionProcessRequest(value)).toBe(false);
    expect(
      weeklyProjectionProcessError({
        name: "postgres://secret",
        code: "password=secret",
        stack: "private",
      }),
    ).toEqual({ name: "Error" });
  });
});
