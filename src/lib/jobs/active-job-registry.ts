import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { jobStateSchema, type JobState } from "../contracts/job";

const ACTIVE_JOB_FILENAME = "active-job.json";
const ACTIVE_JOB_LOCK_FILENAME = ".active-job.lock";
const ACTIVE_JOB_LOCK_LEASE_MS = 5 * 60 * 1_000;

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

const activeJobPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: jobIdSchema,
    claimedAt: z.string().datetime(),
  })
  .strict();

const activeJobClaimSchema = z
  .object({
    jobId: jobIdSchema,
  })
  .strict();

const ownerLeaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerPid: z.number().int().positive().safe(),
    ownerHost: z.string().trim().min(1).max(255),
    ownerToken: z.string().trim().min(1).max(128),
    acquiredAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
  })
  .strict();

const TERMINAL_JOB_STATES = new Set<JobState>([
  "submission_unknown",
  "not_comparable",
  "verified",
  "failed",
]);

export type ActiveJobPointer = z.infer<typeof activeJobPointerSchema>;
export type ActiveJobClaim = z.input<typeof activeJobClaimSchema>;
export type ActiveJobStateReader = (jobId: string) => Promise<unknown>;
type OwnerLease = z.infer<typeof ownerLeaseSchema>;

export class ActiveJobRegistryError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_JOB_BUSY"
      | "ACTIVE_JOB_NONTERMINAL"
      | "ACTIVE_JOB_RECORD_INVALID"
      | "ACTIVE_JOB_STATE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ActiveJobRegistryError";
  }
}

/**
 * Stores the single active FrameLock job without owning any job artifacts.
 *
 * The caller supplies server-generated job IDs. The required state reader must
 * resolve persisted job state from an authoritative source such as
 * LocalJobStore.readJob. Replacing a different active job is allowed only when
 * that reader reports an irreversible terminal state. The registry only
 * rewrites active-job.json; it never deletes or edits a completed job directory.
 */
export class ActiveJobRegistry {
  readonly root: string;

  constructor(
    root: string,
    private readonly readJobState: ActiveJobStateReader,
  ) {
    this.root = resolve(root);
  }

  async read(): Promise<ActiveJobPointer | null> {
    return readActiveJobPointer(this.pointerPath());
  }

  async claim(input: ActiveJobClaim): Promise<ActiveJobPointer> {
    const parsed = activeJobClaimSchema.parse(input);
    await mkdir(this.root, { recursive: true });

    return this.withRootLock(async () => {
      const active = await this.read();
      if (!active) {
        return this.writeClaim(parsed.jobId);
      }

      if (active.jobId === parsed.jobId) {
        return active;
      }

      const activeState = await this.readAuthoritativeState(active.jobId);
      if (!TERMINAL_JOB_STATES.has(activeState)) {
        throw new ActiveJobRegistryError(
          "ACTIVE_JOB_NONTERMINAL",
          `Job ${active.jobId} remains ${activeState}`,
        );
      }

      return this.writeClaim(parsed.jobId);
    });
  }

  /**
   * Runs intake preparation only after proving that its job may become active,
   * then publishes the active pointer last under the same root lock.
   */
  async runWithClaim<T>(
    input: ActiveJobClaim,
    prepareAndPersist: () => Promise<T>,
  ): Promise<T> {
    const parsed = activeJobClaimSchema.parse(input);
    await mkdir(this.root, { recursive: true });

    return this.withRootLock(async () => {
      const active = await this.read();
      if (active) {
        if (active.jobId === parsed.jobId) {
          throw new ActiveJobRegistryError(
            "ACTIVE_JOB_NONTERMINAL",
            `Job ${active.jobId} already owns the active intake slot`,
          );
        }
        const activeState = await this.readAuthoritativeState(active.jobId);
        if (!TERMINAL_JOB_STATES.has(activeState)) {
          throw new ActiveJobRegistryError(
            "ACTIVE_JOB_NONTERMINAL",
            `Job ${active.jobId} remains ${activeState}`,
          );
        }
      }

      const result = await prepareAndPersist();
      await this.writeClaim(parsed.jobId);
      return result;
    });
  }

  private pointerPath(): string {
    return join(this.root, ACTIVE_JOB_FILENAME);
  }

  private async readAuthoritativeState(jobId: string): Promise<JobState> {
    try {
      return jobStateSchema.parse(await this.readJobState(jobId));
    } catch {
      throw new ActiveJobRegistryError(
        "ACTIVE_JOB_STATE_UNAVAILABLE",
        `Could not confirm authoritative state for job ${jobId}`,
      );
    }
  }

  private async writeClaim(jobId: string): Promise<ActiveJobPointer> {
    const pointer = activeJobPointerSchema.parse({
      schemaVersion: 1,
      jobId,
      claimedAt: new Date().toISOString(),
    });
    const temporary = join(
      this.root,
      `.active-job.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.pointerPath());
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return pointer;
  }

  private async withRootLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, ACTIVE_JOB_LOCK_FILENAME);
    const owner = createOwnerLease(ACTIVE_JOB_LOCK_LEASE_MS);
    try {
      await createOwnedLock(lockPath, owner);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      if (!(await reclaimDemonstrablyStaleLock(lockPath))) {
        throw activeJobBusy();
      }
      try {
        await createOwnedLock(lockPath, owner);
      } catch (retryError) {
        if (isNodeError(retryError, "EEXIST")) {
          throw activeJobBusy();
        }
        throw retryError;
      }
    }

    try {
      return await action();
    } finally {
      await releaseOwnedLock(lockPath, owner.ownerToken);
    }
  }
}

async function readActiveJobPointer(
  path: string,
): Promise<ActiveJobPointer | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  try {
    return activeJobPointerSchema.parse(JSON.parse(raw));
  } catch {
    throw new ActiveJobRegistryError(
      "ACTIVE_JOB_RECORD_INVALID",
      "The active job pointer is malformed",
    );
  }
}

function activeJobBusy(): ActiveJobRegistryError {
  return new ActiveJobRegistryError(
    "ACTIVE_JOB_BUSY",
    "The active job pointer is being updated",
  );
}

function createOwnerLease(durationMs: number, now = new Date()): OwnerLease {
  return ownerLeaseSchema.parse({
    schemaVersion: 1,
    ownerPid: process.pid,
    ownerHost: hostname(),
    ownerToken: randomUUID(),
    acquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + durationMs).toISOString(),
  });
}

function isDemonstrablyStale(owner: OwnerLease): boolean {
  if (
    owner.ownerHost !== hostname() ||
    Date.parse(owner.leaseExpiresAt) > Date.now()
  ) {
    return false;
  }
  try {
    process.kill(owner.ownerPid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, "ESRCH");
  }
}

async function createOwnedLock(path: string, owner: OwnerLease): Promise<void> {
  const candidate = `${path}.${owner.ownerToken}.candidate`;
  try {
    const handle = await open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(candidate, path);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

async function readOwnerLease(path: string): Promise<OwnerLease | undefined> {
  try {
    return ownerLeaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function reclaimDemonstrablyStaleLock(path: string): Promise<boolean> {
  const observed = await readOwnerLease(path);
  if (!observed || !isDemonstrablyStale(observed)) {
    return false;
  }
  const confirmed = await readOwnerLease(path);
  if (
    !confirmed ||
    confirmed.ownerToken !== observed.ownerToken ||
    !isDemonstrablyStale(confirmed)
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function releaseOwnedLock(path: string, ownerToken: string): Promise<void> {
  const current = await readOwnerLease(path);
  if (current?.ownerToken !== ownerToken) {
    return;
  }
  await unlink(path).catch(() => undefined);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
