import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  parseMotionDemoBinding: vi.fn(),
  validateMotionDemoArtifacts: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  readFile: mocks.readFile,
  realpath: mocks.realpath,
}));
vi.mock("./motion-demo-evidence", () => ({
  parseMotionDemoBinding: mocks.parseMotionDemoBinding,
  validateMotionDemoArtifacts: mocks.validateMotionDemoArtifacts,
}));

import {
  readMotionDemoEvidence,
  readRequiredMotionDemoEvidence,
} from "./motion-demo-evidence.server";

const sha = (byte: string) => byte.repeat(64);

const binding = {
  admission: {
    path: "artifacts/motion/admission.json",
    sha256: sha("1"),
    bytes: 2,
  },
  audit: {
    path: "artifacts/motion/audit.json",
    sha256: sha("2"),
    bytes: 2,
  },
  proof_manifest: {
    path: "artifacts/motion/proof-manifest.json",
    sha256: sha("a"),
    bytes: 2,
  },
  temporal_matte: {
    path: "artifacts/motion/matte.json",
    sha256: sha("3"),
    bytes: 2,
  },
  negative_control: {
    summary: {
      path: "artifacts/motion/negative-summary.json",
      sha256: sha("4"),
      bytes: 2,
    },
    audit: {
      path: "artifacts/motion/negative-audit.json",
      sha256: sha("5"),
      bytes: 2,
    },
    manifest: {
      path: "artifacts/motion/negative-manifest.json",
      sha256: sha("b"),
      bytes: 2,
    },
    corrupted_frame: {
      path: "artifacts/motion/corrupted-frame.png",
      sha256: sha("c"),
      bytes: 2,
    },
  },
  mask_preview_provenance: {
    path: "artifacts/motion/mask-preview-provenance.json",
    sha256: sha("d"),
    bytes: 2,
  },
  media: {
    source: { url: "/demo/motion/source.mp4", sha256: sha("6"), bytes: 2 },
    generated_world: {
      url: "/demo/motion/generated-world.mp4",
      sha256: sha("7"),
      bytes: 2,
    },
    mask: { url: "/demo/motion/mask.mp4", sha256: sha("8"), bytes: 2 },
    verified: {
      url: "/demo/motion/verified.mp4",
      sha256: sha("9"),
      bytes: 2,
    },
  },
};

const projection = {
  media: {
    source: "/demo/motion/source.mp4",
    raw: "/demo/motion/generated-world.mp4",
    mask: "/demo/motion/mask.mp4",
    verified: "/demo/motion/verified.mp4",
  },
  evidence: {
    admission: "admitted",
    audit: {
      claimScope: "canonical_pre_encode_frames",
      framesAudited: 121,
      framesExpected: 121,
      changedProtectedPixels: 0,
      temporalMasksBound: 121,
    },
  },
};

describe("Motion demo evidence read boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockResolvedValue(Buffer.from("{}"));
    mocks.lstat.mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 2,
    });
    mocks.realpath.mockImplementation(async (path: string) => path);
    mocks.parseMotionDemoBinding.mockReturnValue(binding);
    mocks.validateMotionDemoArtifacts.mockReturnValue(projection);
  });

  it("reads only bounded evidence and media before projecting admitted claims", async () => {
    await expect(
      readRequiredMotionDemoEvidence({
        projectRoot: "/project",
        bindingPath: "artifacts/motion/binding.json",
      }),
    ).resolves.toBe(projection);

    expect(mocks.validateMotionDemoArtifacts).toHaveBeenCalledOnce();
    expect(mocks.readFile).toHaveBeenCalledTimes(14);
  });

  it("relocates default evidence reads while keeping media under the real public root", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/project");

    try {
      await expect(readRequiredMotionDemoEvidence()).resolves.toBe(projection);
    } finally {
      cwd.mockRestore();
    }

    const readPaths = mocks.readFile.mock.calls.map(([path]) => path);
    expect(readPaths[0]).toBe(
      "/project/demo-evidence/motion/root/artifacts/motion-v1/demo/motion-demo-binding.json",
    );
    expect(readPaths).toContain(
      "/project/demo-evidence/motion/root/artifacts/motion/admission.json",
    );
    expect(readPaths).toContain("/project/public/demo/motion/source.mp4");
    expect(readPaths).toContain("/project/public/demo/motion/verified.mp4");
    expect(mocks.validateMotionDemoArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedPaths: expect.objectContaining({
          projectRoot: "/project/demo-evidence/motion/root",
        }),
      }),
    );
  });

  it("preserves explicit project roots for isolated evidence fixtures", async () => {
    await expect(
      readRequiredMotionDemoEvidence({
        projectRoot: "/fixture",
        bindingPath: "artifacts/motion/binding.json",
      }),
    ).resolves.toBe(projection);

    const readPaths = mocks.readFile.mock.calls.map(([path]) => path);
    expect(readPaths[0]).toBe("/fixture/artifacts/motion/binding.json");
    expect(readPaths).toContain("/fixture/artifacts/motion/admission.json");
    expect(readPaths).toContain("/fixture/public/demo/motion/source.mp4");
    expect(mocks.validateMotionDemoArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedPaths: expect.objectContaining({ projectRoot: "/fixture" }),
      }),
    );
  });

  it("returns null when any required artifact is missing and throws diagnostically on demand", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    mocks.readFile.mockRejectedValue(missing);

    await expect(
      readMotionDemoEvidence({
        projectRoot: "/project",
        bindingPath: "artifacts/motion/binding.json",
      }),
    ).resolves.toBeNull();
    await expect(
      readRequiredMotionDemoEvidence({
        projectRoot: "/project",
        bindingPath: "artifacts/motion/binding.json",
      }),
    ).rejects.toThrow("missing");
  });

  it("rejects traversal in the binding path and in bound evidence paths", async () => {
    await expect(
      readRequiredMotionDemoEvidence({
        projectRoot: "/project",
        bindingPath: "../secret.json",
      }),
    ).rejects.toThrow("escaped its root");

    mocks.parseMotionDemoBinding.mockReturnValue({
      ...binding,
      audit: { ...binding.audit, path: "../secret.json" },
    });
    await expect(
      readRequiredMotionDemoEvidence({
        projectRoot: "/project",
        bindingPath: "artifacts/motion/binding.json",
      }),
    ).rejects.toThrow("escaped its root");
  });
});
