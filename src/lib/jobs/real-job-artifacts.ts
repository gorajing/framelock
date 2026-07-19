import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { SourcePreparationEvidence } from "../media/framelock-cli-core";
import {
  AI_SOURCE_PROVENANCE_FILENAME,
  AiSourceProvenanceError,
  assertAiSourceProvenanceMediaBindings,
  parseAiSourceProvenanceBytes,
  type AiSourceProvenance,
} from "./ai-source-provenance";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const tokenSchema = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);

type CliPort = Readonly<{
  prepareSource(input: {
    sourcePath: string;
    foregroundMaskPath: string;
    outputDirectory: string;
  }): Promise<SourcePreparationEvidence>;
}>;

type Options = Readonly<{
  stagingRoot: string;
  runsRoot: string;
  cli: CliPort;
  createToken?: () => string;
}>;

export type AiSourcePreparationEvidence = SourcePreparationEvidence &
  Readonly<{
    source_provenance: Readonly<{
      path: string;
      file_sha256: string;
      size_bytes: number;
      manifest: AiSourceProvenance;
    }>;
  }>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

export function createRealJobArtifactsPort(options: Options) {
  const stagingRoot = resolve(options.stagingRoot);
  const runsRoot = resolve(options.runsRoot);

  return {
    async prepare(input: {
      jobId: string;
      source: File;
      foregroundMask: File;
      sourceProvenance: File;
    }): Promise<AiSourcePreparationEvidence> {
      const jobId = jobIdSchema.parse(input.jobId);
      const token = tokenSchema.parse((options.createToken ?? randomUUID)());
      const stagingDirectory = join(stagingRoot, `${jobId}-${token}`);
      const sourcePath = join(stagingDirectory, "source.mp4");
      const foregroundMaskPath = join(stagingDirectory, "foreground.png");
      const outputDirectory = join(runsRoot, jobId);
      let ownsStagingDirectory = false;

      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      try {
        await mkdir(stagingDirectory, { mode: 0o700 });
        ownsStagingDirectory = true;
        const [sourceBuffer, foregroundMaskBuffer, provenanceBuffer] =
          await Promise.all([
            input.source.arrayBuffer(),
            input.foregroundMask.arrayBuffer(),
            input.sourceProvenance.arrayBuffer(),
          ]);
        const sourceBytes = new Uint8Array(sourceBuffer);
        const foregroundMaskBytes = new Uint8Array(foregroundMaskBuffer);
        const provenanceBytes = new Uint8Array(provenanceBuffer);
        const provenance = parseAiSourceProvenanceBytes(provenanceBytes);

        assertAiSourceProvenanceMediaBindings(provenance, {
          canonicalSourceMp4Sha256: sha256(sourceBytes),
          foregroundMaskSha256: sha256(foregroundMaskBytes),
        });

        await Promise.all([
          writeFile(sourcePath, sourceBytes, {
            flag: "wx",
            mode: 0o600,
          }),
          writeFile(foregroundMaskPath, foregroundMaskBytes, {
            flag: "wx",
            mode: 0o600,
          }),
        ]);
        const evidence = await options.cli.prepareSource({
          sourcePath,
          foregroundMaskPath,
          outputDirectory,
        });
        assertAiSourceProvenanceMediaBindings(provenance, {
          canonicalSourceMp4Sha256: evidence.source_sha256,
          foregroundMaskSha256: evidence.foreground_mask_sha256,
        });

        const sourceDirectory = dirname(evidence.source);
        if (sourceDirectory !== dirname(evidence.foreground_mask)) {
          throw new AiSourceProvenanceError("PREPARED_INPUT_PATH_MISMATCH");
        }
        const provenancePath = join(
          sourceDirectory,
          AI_SOURCE_PROVENANCE_FILENAME,
        );
        try {
          await writeFile(provenancePath, provenanceBytes, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (isAlreadyExistsError(error)) {
            throw new AiSourceProvenanceError("PROVENANCE_ALREADY_EXISTS");
          }
          throw error;
        }

        return {
          ...evidence,
          source_provenance: {
            path: provenancePath,
            file_sha256: sha256(provenanceBytes),
            size_bytes: provenanceBytes.byteLength,
            manifest: provenance,
          },
        };
      } finally {
        if (ownsStagingDirectory) {
          await rm(stagingDirectory, { recursive: true, force: true });
        }
      }
    },
  };
}
