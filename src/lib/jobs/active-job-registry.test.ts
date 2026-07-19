import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobState } from "../contracts/job";
import {
  ActiveJobRegistry,
  type ActiveJobClaim,
} from "./active-job-registry";

const FIRST_JOB_ID = "real_hero_run_001";
const SECOND_JOB_ID = "real_hero_run_002";
const NONTERMINAL_STATES: JobState[] = [
  "created",
  "validated",
  "submitting",
  "submitted",
  "queued",
  "generating",
  "generated",
  "composited",
];
const TERMINAL_STATES: JobState[] = [
  "submission_unknown",
  "not_comparable",
  "verified",
  "failed",
];

describe("one-active-job registry", () => {
  let root: string;
  let registry: ActiveJobRegistry;
  let authoritativeStates: Map<string, JobState>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "framelock-active-job-"));
    authoritativeStates = new Map();
    registry = new ActiveJobRegistry(root, async (jobId) => {
      const state = authoritativeStates.get(jobId);
      if (!state) throw new Error(`Missing authoritative state for ${jobId}`);
      return state;
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("atomically claims the first job and idempotently preserves its timestamp", async () => {
    const first = await registry.claim({ jobId: FIRST_JOB_ID });
    const before = await readFile(join(root, "active-job.json"), "utf8");
    const repeated = await registry.claim({ jobId: FIRST_JOB_ID });
    const after = await readFile(join(root, "active-job.json"), "utf8");

    expect(repeated).toEqual(first);
    expect(after).toBe(before);
    expect(
      await new ActiveJobRegistry(root, async () => "verified").read(),
    ).toEqual(first);
    expect((await stat(join(root, "active-job.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it.each(NONTERMINAL_STATES)(
    "rejects replacement while the active job is %s",
    async (state) => {
      const first = await registry.claim({ jobId: FIRST_JOB_ID });
      authoritativeStates.set(FIRST_JOB_ID, state);

      await expect(
        registry.claim({ jobId: SECOND_JOB_ID }),
      ).rejects.toMatchObject({ code: "ACTIVE_JOB_NONTERMINAL" });

      expect(await registry.read()).toEqual(first);
    },
  );

  it("rejects a competing intake before its preparation action runs", async () => {
    await registry.claim({ jobId: FIRST_JOB_ID });
    authoritativeStates.set(FIRST_JOB_ID, "validated");
    const prepareAndPersist = vi.fn(async () => SECOND_JOB_ID);

    await expect(
      registry.runWithClaim(
        { jobId: SECOND_JOB_ID },
        prepareAndPersist,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_NONTERMINAL" });

    expect(prepareAndPersist).not.toHaveBeenCalled();
    expect((await registry.read())?.jobId).toBe(FIRST_JOB_ID);
  });

  it.each(TERMINAL_STATES)(
    "replaces a terminal %s job without deleting its record",
    async (state) => {
      const completedDirectory = join(root, FIRST_JOB_ID);
      const completedRecord = join(completedDirectory, "job.json");
      await mkdir(completedDirectory);
      await writeFile(completedRecord, "immutable completed evidence\n", "utf8");
      await registry.claim({ jobId: FIRST_JOB_ID });
      authoritativeStates.set(FIRST_JOB_ID, state);

      const replacement = await registry.claim({ jobId: SECOND_JOB_ID });

      expect(replacement.jobId).toBe(SECOND_JOB_ID);
      expect(await registry.read()).toEqual(replacement);
      expect(await readFile(completedRecord, "utf8")).toBe(
        "immutable completed evidence\n",
      );
    },
  );

  it("fails closed when authoritative state cannot be read", async () => {
    const first = await registry.claim({ jobId: FIRST_JOB_ID });

    await expect(
      registry.claim({ jobId: SECOND_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_STATE_UNAVAILABLE" });

    expect(await registry.read()).toEqual(first);
  });

  it("rejects a forged terminal claim when the active job is actually submitting", async () => {
    const first = await registry.claim({ jobId: FIRST_JOB_ID });
    authoritativeStates.set(FIRST_JOB_ID, "submitting");
    const forgedClaim = {
      jobId: SECOND_JOB_ID,
      referencedJob: { jobId: FIRST_JOB_ID, state: "verified" },
    } as unknown as ActiveJobClaim;

    await expect(registry.claim(forgedClaim)).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(
      registry.claim({ jobId: SECOND_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_NONTERMINAL" });

    expect(await registry.read()).toEqual(first);
  });

  it("fails closed when the authoritative reader returns an invalid state", async () => {
    const invalidRegistry = new ActiveJobRegistry(
      root,
      async () => "forged-terminal-state",
    );
    const first = await invalidRegistry.claim({ jobId: FIRST_JOB_ID });

    await expect(
      invalidRegistry.claim({ jobId: SECOND_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_STATE_UNAVAILABLE" });

    expect(await invalidRegistry.read()).toEqual(first);
  });

  it("serializes competing first claims so exactly one job wins", async () => {
    const results = await Promise.allSettled([
      registry.claim({ jobId: FIRST_JOB_ID }),
      registry.claim({ jobId: SECOND_JOB_ID }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof registry.claim>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect([
      "ACTIVE_JOB_BUSY",
      "ACTIVE_JOB_STATE_UNAVAILABLE",
    ]).toContain(rejected[0].reason.code);
    expect((await registry.read())?.jobId).toBe(fulfilled[0].value.jobId);
  });

  it("reclaims only an expired lock whose recorded local owner is dead", async () => {
    await writeRootLock({
      ownerPid: 2_147_483_647,
      ownerHost: hostname(),
      ownerToken: "dead-expired-owner",
      leaseExpiresAt: "2000-01-01T00:15:00.000Z",
    });

    const claimed = await registry.claim({ jobId: FIRST_JOB_ID });

    expect(claimed.jobId).toBe(FIRST_JOB_ID);
  });

  it.each([
    [
      "live owner",
      {
        ownerPid: process.pid,
        ownerHost: hostname(),
        ownerToken: "live-owner",
        leaseExpiresAt: "2000-01-01T00:15:00.000Z",
      },
    ],
    [
      "unexpired lease",
      {
        ownerPid: 2_147_483_647,
        ownerHost: hostname(),
        ownerToken: "unexpired-owner",
        leaseExpiresAt: "2999-01-01T00:15:00.000Z",
      },
    ],
    [
      "foreign host",
      {
        ownerPid: 2_147_483_647,
        ownerHost: "another-host.invalid",
        ownerToken: "foreign-owner",
        leaseExpiresAt: "2000-01-01T00:15:00.000Z",
      },
    ],
  ] as const)("does not reclaim a lock with a %s", async (_label, owner) => {
    await writeRootLock(owner);

    await expect(
      registry.claim({ jobId: FIRST_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_BUSY" });
    expect(await registry.read()).toBeNull();
    expect(await readFile(join(root, ".active-job.lock"), "utf8")).toContain(
      owner.ownerToken,
    );
  });

  it("does not reclaim a malformed lock", async () => {
    await writeFile(join(root, ".active-job.lock"), "not-json\n", "utf8");

    await expect(
      registry.claim({ jobId: FIRST_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_BUSY" });
    expect(await readFile(join(root, ".active-job.lock"), "utf8")).toBe(
      "not-json\n",
    );
  });

  it("refuses to overwrite a malformed active-job pointer", async () => {
    await writeFile(join(root, "active-job.json"), "not-json\n", "utf8");

    await expect(registry.read()).rejects.toMatchObject({
      code: "ACTIVE_JOB_RECORD_INVALID",
    });
    await expect(
      registry.claim({ jobId: FIRST_JOB_ID }),
    ).rejects.toMatchObject({ code: "ACTIVE_JOB_RECORD_INVALID" });
    expect(await readFile(join(root, "active-job.json"), "utf8")).toBe(
      "not-json\n",
    );
  });

  it("validates caller-supplied job IDs before touching the registry root", async () => {
    await expect(registry.claim({ jobId: "../escape" })).rejects.toThrow();

    expect(await readdir(root)).toEqual([]);
  });

  async function writeRootLock(owner: {
    ownerPid: number;
    ownerHost: string;
    ownerToken: string;
    leaseExpiresAt: string;
  }) {
    await writeFile(
      join(root, ".active-job.lock"),
      `${JSON.stringify({
        schemaVersion: 1,
        ...owner,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
  }
});
