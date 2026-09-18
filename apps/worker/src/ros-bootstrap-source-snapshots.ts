import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { assertRosCacheHeadroom, RosCacheDiskSpaceError } from "./ros-cache-disk-space.js";

export const ROS_BOOTSTRAP_SOURCE_SNAPSHOT_MAX_BYTES = 4 * 1_024 ** 3;
export const ROS_BOOTSTRAP_SOURCE_NAMESPACE_MAX_BYTES = 16 * 1_024 ** 3;
export const ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE = ".ros-bootstrap-source-snapshot.json";
const NAMESPACE = "bootstrap-snapshots-v1";
const VERSION = "ros-bootstrap-source-snapshot-v1";
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CACHE_FILE = /^[a-f0-9]{64}\.(?:json|body)(?:\.[a-f0-9-]{36}\.partial)?$/u;
const OWNER_PARTIAL = /^\.ros-bootstrap-source-snapshot\.json\.[a-f0-9-]{36}\.partial$/u;
const MAX_FILES = 4_096;
const MAX_NAMESPACE_FILES = 16_384;
const MAX_SNAPSHOTS = 256;
const MAX_REQUESTS = 32;
const MANIFEST_LIMIT = 4_096;

type SnapshotState = "capturing" | "qualified" | "unqualified";
export interface RosBootstrapSourceSnapshot {
  readonly snapshotId: string;
  readonly directory: string;
  readonly state: SnapshotState;
  readonly createdAt: string;
  readonly qualifiedAt: string | null;
}
interface OwnerManifest {
  readonly version: typeof VERSION;
  readonly requestIdentity: string;
  readonly snapshotId: string;
  readonly state: SnapshotState;
  readonly createdAt: string;
  readonly qualifiedAt: string | null;
  readonly unqualifiedAt: string | null;
}
interface Inventory {
  readonly owner: OwnerManifest;
  readonly directory: string;
  readonly files: readonly string[];
  readonly bytes: number;
}

export class RosBootstrapSourceSnapshotError extends Error {
  constructor(readonly code: "source_snapshot_integrity" | "source_snapshot_capacity") {
    super(
      code === "source_snapshot_capacity"
        ? "ROS bootstrap source capture exceeds its bounded storage capacity."
        : "ROS bootstrap source snapshot ownership or contents could not be verified.",
    );
    this.name = "RosBootstrapSourceSnapshotError";
  }
}
const integrity = () => new RosBootstrapSourceSnapshotError("source_snapshot_integrity");
const capacity = () => new RosBootstrapSourceSnapshotError("source_snapshot_capacity");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function identifiers(requestIdentity: string, snapshotId: string) {
  if (!SHA.test(requestIdentity) || !UUID.test(snapshotId)) throw integrity();
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
async function directoryExists(directory: string): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw integrity();
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function regularFile(file: string) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.nlink !== 1 || !Number.isSafeInteger(stats.size)) throw integrity();
  return stats;
}
async function ownerManifest(directory: string, requestIdentity: string, snapshotId: string) {
  const file = path.join(directory, ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE);
  try {
    if ((await regularFile(file)).size > MANIFEST_LIMIT) throw integrity();
  } catch {
    throw integrity();
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let owner: OwnerManifest;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MANIFEST_LIMIT) throw integrity();
    owner = JSON.parse(await handle.readFile("utf8")) as OwnerManifest;
  } catch {
    throw integrity();
  } finally {
    await handle.close();
  }
  if (
    !owner ||
    owner.version !== VERSION ||
    owner.requestIdentity !== requestIdentity ||
    owner.snapshotId !== snapshotId ||
    !timestamp(owner.createdAt) ||
    !["capturing", "qualified", "unqualified"].includes(owner.state) ||
    (owner.state === "qualified"
      ? !timestamp(owner.qualifiedAt) || owner.unqualifiedAt !== null
      : owner.qualifiedAt !== null) ||
    (owner.state === "unqualified"
      ? !timestamp(owner.unqualifiedAt)
      : owner.unqualifiedAt !== null) ||
    (owner.qualifiedAt !== null && owner.qualifiedAt < owner.createdAt) ||
    (owner.unqualifiedAt !== null && owner.unqualifiedAt < owner.createdAt)
  )
    throw integrity();
  return owner;
}
async function inspectSnapshot(directory: string, requestIdentity: string, snapshotId: string) {
  if (!(await directoryExists(directory))) throw integrity();
  const owner = await ownerManifest(directory, requestIdentity, snapshotId);
  const files: string[] = [];
  let bytes = 0;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (files.length >= MAX_FILES) throw capacity();
    if (
      entry.name !== ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE &&
      !CACHE_FILE.test(entry.name) &&
      !OWNER_PARTIAL.test(entry.name)
    )
      throw integrity();
    const stats = await regularFile(path.join(directory, entry.name));
    bytes += stats.size;
    if (!Number.isSafeInteger(bytes)) throw capacity();
    files.push(entry.name);
  }
  return { owner, directory, files, bytes } satisfies Inventory;
}
function descriptor(owner: OwnerManifest, directory: string): RosBootstrapSourceSnapshot {
  return {
    snapshotId: owner.snapshotId,
    directory,
    state: owner.state,
    createdAt: owner.createdAt,
    qualifiedAt: owner.qualifiedAt,
  };
}

/**
 * Called under the bootstrap coordinator's global lock. The coordinator must protect every ledger
 * reference and outstanding execution; this helper never infers liveness from age or directory names.
 * Unrecognized entries stop cleanup. The legacy source-root namespace is never inventoried or edited.
 */
export class RosBootstrapSourceSnapshots {
  private readonly root: string;
  private readonly namespace: string;
  private readonly maxSnapshotBytes: number;
  private readonly maxNamespaceBytes: number;
  private readonly retainUnqualified: number;

  constructor(options: {
    readonly sourceRoot: string;
    readonly maxSnapshotBytes?: number;
    readonly maxNamespaceBytes?: number;
    readonly retainUnqualified?: number;
  }) {
    this.root = path.resolve(options.sourceRoot);
    this.namespace = path.join(this.root, NAMESPACE);
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? ROS_BOOTSTRAP_SOURCE_SNAPSHOT_MAX_BYTES;
    this.maxNamespaceBytes = options.maxNamespaceBytes ?? ROS_BOOTSTRAP_SOURCE_NAMESPACE_MAX_BYTES;
    this.retainUnqualified = options.retainUnqualified ?? 1;
    if (
      ![this.maxSnapshotBytes, this.maxNamespaceBytes].every(
        (value) => Number.isSafeInteger(value) && value >= MANIFEST_LIMIT,
      ) ||
      this.maxNamespaceBytes < this.maxSnapshotBytes ||
      !Number.isSafeInteger(this.retainUnqualified) ||
      this.retainUnqualified < 0
    )
      throw new RangeError("Invalid ROS bootstrap source storage bounds");
  }

  private async verifyParents(requestIdentity: string, create: boolean) {
    if (!SHA.test(requestIdentity)) throw integrity();
    // mkdir never follows an unverified namespace or request symlink. Source-root ancestors are
    // configured mount paths; the source root itself must be a real directory.
    if (!(await directoryExists(this.root))) {
      if (!create) throw integrity();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!(await directoryExists(this.root))) throw integrity();
    }
    const requestDirectory = path.join(this.namespace, requestIdentity);
    for (const directory of [this.namespace, requestDirectory]) {
      if (!(await directoryExists(directory))) {
        if (!create) throw integrity();
        await mkdir(directory, { mode: 0o700 });
      }
    }
    return requestDirectory;
  }

  async getPath(requestIdentity: string, snapshotId: string): Promise<string> {
    identifiers(requestIdentity, snapshotId);
    const parent = await this.verifyParents(requestIdentity, false);
    const directory = path.join(parent, snapshotId);
    if (
      (await inspectSnapshot(directory, requestIdentity, snapshotId)).bytes > this.maxSnapshotBytes
    )
      throw capacity();
    return directory;
  }

  private async inventory(): Promise<Inventory[]> {
    const snapshots: Inventory[] = [];
    let requests = 0;
    let files = 0;
    for await (const request of await opendir(this.namespace)) {
      if (++requests > MAX_REQUESTS) throw capacity();
      if (!SHA.test(request.name)) throw integrity();
      const directory = path.join(this.namespace, request.name);
      if (!(await directoryExists(directory))) throw integrity();
      for await (const snapshot of await opendir(directory)) {
        if (snapshots.length >= MAX_SNAPSHOTS) throw capacity();
        identifiers(request.name, snapshot.name);
        const inspected = await inspectSnapshot(
          path.join(directory, snapshot.name),
          request.name,
          snapshot.name,
        );
        files += inspected.files.length;
        if (files > MAX_NAMESPACE_FILES || inspected.bytes > this.maxSnapshotBytes)
          throw capacity();
        snapshots.push(inspected);
      }
    }
    return snapshots;
  }

  private async hasCapacity(totalBytes: number, pendingBytes: number): Promise<boolean> {
    if (totalBytes + pendingBytes > this.maxNamespaceBytes) return false;
    try {
      await assertRosCacheHeadroom(this.namespace, pendingBytes);
      return true;
    } catch (error) {
      if (error instanceof RosCacheDiskSpaceError && error.code === "insufficient_disk_space")
        return false;
      throw error;
    }
  }

  private async makeRoom(
    inventory: readonly Inventory[],
    pendingBytes: number,
    protectedIds: ReadonlySet<string>,
  ) {
    let totalBytes = inventory.reduce((total, item) => total + item.bytes, 0);
    if (await this.hasCapacity(totalBytes, pendingBytes)) return;
    const eligible = inventory
      .filter(
        (item) => item.owner.state === "unqualified" && !protectedIds.has(item.owner.snapshotId),
      )
      .sort(
        (a, b) =>
          a.owner.createdAt.localeCompare(b.owner.createdAt) ||
          a.owner.snapshotId.localeCompare(b.owner.snapshotId),
      );
    // Old diagnostics go first. The retained recent diagnostic is reclaimed only if needed to
    // preserve capacity, and is never reclaimed merely because it has reached an arbitrary age.
    const preferred = eligible.slice(0, Math.max(0, eligible.length - this.retainUnqualified));
    const recent = eligible.slice(preferred.length);
    for (const candidate of [...preferred, ...recent]) {
      const current = await inspectSnapshot(
        candidate.directory,
        candidate.owner.requestIdentity,
        candidate.owner.snapshotId,
      );
      if (
        JSON.stringify(current.owner) !== JSON.stringify(candidate.owner) ||
        current.bytes !== candidate.bytes ||
        [...current.files].sort().join("\n") !== [...candidate.files].sort().join("\n")
      )
        throw integrity();
      // No recursive deletion: a concurrently added or unknown file causes rmdir to fail, and is
      // preserved. Under the coordinator lock, unqualified/protected state cannot change here.
      for (const file of current.files.filter(
        (file) => file !== ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE,
      )) {
        await regularFile(path.join(current.directory, file));
        await unlink(path.join(current.directory, file));
      }
      await unlink(path.join(current.directory, ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE));
      await rmdir(current.directory);
      totalBytes -= current.bytes;
      if (await this.hasCapacity(totalBytes, pendingBytes)) return;
    }
    throw capacity();
  }

  async prepare(options: {
    readonly requestIdentity: string;
    readonly snapshotId: string;
    readonly allowCreate: boolean;
    readonly protectedSnapshotIds: readonly string[];
  }): Promise<RosBootstrapSourceSnapshot> {
    identifiers(options.requestIdentity, options.snapshotId);
    if (options.protectedSnapshotIds.some((id) => !UUID.test(id))) throw integrity();
    const parent = await this.verifyParents(options.requestIdentity, options.allowCreate);
    const directory = path.join(parent, options.snapshotId);
    const exists = await directoryExists(directory);
    if (!exists && !options.allowCreate) throw integrity();
    const inventory = await this.inventory();
    const existing = inventory.find((item) => item.directory === directory);
    if (exists && !existing) throw integrity();
    if (
      !existing &&
      (inventory.length >= MAX_SNAPSHOTS ||
        inventory.reduce((total, item) => total + item.files.length, 0) >= MAX_NAMESPACE_FILES)
    )
      throw capacity();
    if (existing && existing.owner.state !== "capturing")
      return descriptor(existing.owner, directory);
    await this.makeRoom(
      inventory,
      this.maxSnapshotBytes - (existing?.bytes ?? 0),
      new Set([...options.protectedSnapshotIds, options.snapshotId]),
    );
    if (existing) return descriptor(existing.owner, directory);
    const owner: OwnerManifest = {
      version: VERSION,
      requestIdentity: options.requestIdentity,
      snapshotId: options.snapshotId,
      state: "capturing",
      createdAt: new Date().toISOString(),
      qualifiedAt: null,
      unqualifiedAt: null,
    };
    await mkdir(directory, { mode: 0o700 });
    await this.writeOwner(directory, owner, true);
    return descriptor(owner, directory);
  }

  private async writeOwner(directory: string, owner: OwnerManifest, initial: boolean) {
    const destination = path.join(directory, ROS_BOOTSTRAP_SOURCE_SNAPSHOT_OWNER_FILE);
    const bytes = JSON.stringify(owner);
    await assertRosCacheHeadroom(directory, Buffer.byteLength(bytes));
    const target = initial ? destination : `${destination}.${randomUUID()}.partial`;
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!initial) await rename(target, destination);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  private async mark(
    requestIdentity: string,
    snapshotId: string,
    state: "qualified" | "unqualified",
  ) {
    const directory = await this.getPath(requestIdentity, snapshotId);
    const owner = await ownerManifest(directory, requestIdentity, snapshotId);
    if (owner.state === state) return descriptor(owner, directory);
    if (owner.state !== "capturing") throw integrity();
    const now = new Date().toISOString();
    const updated: OwnerManifest = {
      ...owner,
      state,
      qualifiedAt: state === "qualified" ? now : null,
      unqualifiedAt: state === "unqualified" ? now : null,
    };
    await this.writeOwner(directory, updated, false);
    return descriptor(updated, directory);
  }

  markQualified(requestIdentity: string, snapshotId: string): Promise<RosBootstrapSourceSnapshot> {
    return this.mark(requestIdentity, snapshotId, "qualified");
  }

  markUnqualified(
    requestIdentity: string,
    snapshotId: string,
  ): Promise<RosBootstrapSourceSnapshot> {
    return this.mark(requestIdentity, snapshotId, "unqualified");
  }
}
