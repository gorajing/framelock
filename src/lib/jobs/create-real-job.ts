import { z } from "zod";

import {
  KLING_O3_STANDARD_EDIT_ENDPOINT,
  KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
} from "../fal/kling-contract";
import type { AiSourcePreparationEvidence } from "./real-job-artifacts";
import type { AiSourceProvenanceBinding } from "./ai-source-provenance";
import type { GenerationIdentity } from "./generation-digest";
import type { RealJobIntake } from "./real-job-intake";

const jobIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

type PreparedArtifactsPort = Readonly<{
  prepare(input: {
    jobId: string;
    source: File;
    foregroundMask: File;
    sourceProvenance: File;
  }): Promise<AiSourcePreparationEvidence>;
}>;

type ValidatedJobPort = Readonly<{
  createValidatedJob(input: {
    id: string;
    generation: GenerationIdentity;
    sourceProvenance: AiSourceProvenanceBinding;
  }): Promise<{
    id: string;
    state: string;
    generation: { digest: string };
  }>;
}>;

type ActiveJobPort = Readonly<{
  runWithClaim<T>(
    input: { jobId: string },
    prepareAndPersist: () => Promise<T>,
  ): Promise<T>;
}>;

type Dependencies = Readonly<{
  createId(): string;
  artifacts: PreparedArtifactsPort;
  jobs: ValidatedJobPort;
  activeJobs: ActiveJobPort;
}>;

export type RealJobCreatedView = Readonly<{
  id: string;
  state: "validated";
  claim: null;
  nextStep: "confirm_generation";
  endpoint: typeof KLING_O3_STANDARD_EDIT_ENDPOINT;
  generationDigest: string;
  prompt: string;
  sourceSha256: string;
  editMaskSha256: string;
  protectedCorePixelsPerFrame: number;
  sourceProvenance: Readonly<
    AiSourceProvenanceBinding["manifest"] & {
      fileSha256: string;
    }
  >;
}>;

export function createRealJobService(dependencies: Dependencies) {
  return {
    async create(input: RealJobIntake): Promise<RealJobCreatedView> {
      const jobId = jobIdSchema.parse(dependencies.createId());
      return dependencies.activeJobs.runWithClaim({ jobId }, async () => {
        const evidence = await dependencies.artifacts.prepare({
          jobId,
          source: input.source,
          foregroundMask: input.foregroundMask,
          sourceProvenance: input.sourceProvenance,
        });
        const sourceProvenance = {
          fileSha256: evidence.source_provenance.file_sha256,
          manifest: evidence.source_provenance.manifest,
        };
        const record = await dependencies.jobs.createValidatedJob({
          id: jobId,
          generation: {
            sourceSha256: evidence.source_sha256,
            editMaskSha256: evidence.foreground_mask_sha256,
            prompt: input.prompt,
            endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
            parameters: KLING_O3_STANDARD_EDIT_FIXED_PARAMETERS,
          },
          sourceProvenance,
        });
        if (
          record.id !== jobId ||
          record.state !== "validated" ||
          !sha256Schema.safeParse(record.generation.digest).success
        ) {
          throw new Error("Validated job persistence returned invalid state");
        }

        return {
          id: jobId,
          state: "validated",
          claim: null,
          nextStep: "confirm_generation",
          endpoint: KLING_O3_STANDARD_EDIT_ENDPOINT,
          generationDigest: record.generation.digest,
          prompt: input.prompt,
          sourceSha256: evidence.source_sha256,
          editMaskSha256: evidence.foreground_mask_sha256,
          protectedCorePixelsPerFrame:
            evidence.protected_core_pixels_per_frame,
          sourceProvenance: {
            fileSha256: sourceProvenance.fileSha256,
            ...sourceProvenance.manifest,
          },
        };
      });
    },
  };
}
