import { describe, expect, it } from "vitest";

import {
  OWNERSHIP_CONFIRMATION,
  RealJobIntakeError,
  parseRealJobIntake,
} from "./real-job-intake";

const PROVENANCE_BYTES = new TextEncoder().encode('{"schemaVersion":1}');

function validForm(): FormData {
  const form = new FormData();
  form.set(
    "source",
    new File([new Uint8Array([0, 1, 2])], "source.mp4", {
      type: "video/mp4",
    }),
  );
  form.set(
    "foregroundMask",
    new File([new Uint8Array([3, 4])], "foreground.png", {
      type: "image/png",
    }),
  );
  form.set(
    "sourceProvenance",
    new File([PROVENANCE_BYTES], "source-provenance.json", {
      type: "application/json",
    }),
  );
  form.set("prompt", "  Move the product into a moonlit gallery.  ");
  form.set("ownershipConfirmation", OWNERSHIP_CONFIRMATION);
  return form;
}

describe("real hero job intake", () => {
  it("accepts only the frozen source, mask, provenance, prompt and ownership contract", () => {
    const parsed = parseRealJobIntake(validForm());

    expect(parsed.source.type).toBe("video/mp4");
    expect(parsed.foregroundMask.type).toBe("image/png");
    expect(parsed.sourceProvenance.type).toBe("application/json");
    expect(parsed.prompt).toBe("Move the product into a moonlit gallery.");
  });

  it("requires exactly one non-empty provenance upload", () => {
    const missing = validForm();
    missing.delete("sourceProvenance");
    expect(() => parseRealJobIntake(missing)).toThrowError(
      expect.objectContaining({ code: "INVALID_PROVENANCE_FILE" }),
    );

    const duplicate = validForm();
    duplicate.append(
      "sourceProvenance",
      new File([PROVENANCE_BYTES], "duplicate.json", {
        type: "application/json",
      }),
    );
    expect(() => parseRealJobIntake(duplicate)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_FIELD" }),
    );
  });

  it("rejects missing ownership attestation", () => {
    const form = validForm();
    form.delete("ownershipConfirmation");

    expect(() => parseRealJobIntake(form)).toThrowError(
      expect.objectContaining({ code: "OWNERSHIP_NOT_CONFIRMED" }),
    );
  });

  it.each([
    ["source", "video/quicktime", "INVALID_SOURCE_TYPE"],
    ["foregroundMask", "image/jpeg", "INVALID_MASK_TYPE"],
    ["sourceProvenance", "text/plain", "INVALID_PROVENANCE_TYPE"],
  ] as const)("rejects an invalid %s MIME type", (field, type, code) => {
    const form = validForm();
    form.set(field, new File([new Uint8Array([1])], "wrong", { type }));

    expect(() => parseRealJobIntake(form)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("enforces byte limits before copying any upload", () => {
    const form = validForm();

    expect(() =>
      parseRealJobIntake(form, {
        sourceBytes: 2,
        maskBytes: 2,
        provenanceBytes: PROVENANCE_BYTES.byteLength,
      }),
    ).toThrowError(expect.objectContaining({ code: "SOURCE_TOO_LARGE" }));

    expect(() =>
      parseRealJobIntake(form, {
        sourceBytes: 3,
        maskBytes: 2,
        provenanceBytes: PROVENANCE_BYTES.byteLength - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVENANCE_TOO_LARGE" }));
  });

  it("rejects empty or oversized prompts and unexpected fields", () => {
    const empty = validForm();
    empty.set("prompt", "   ");
    expect(() => parseRealJobIntake(empty)).toThrowError(
      expect.objectContaining({ code: "INVALID_PROMPT" }),
    );

    const unknown = validForm();
    unknown.set("model", "something-else");
    expect(() => parseRealJobIntake(unknown)).toThrowError(
      expect.objectContaining({ code: "UNEXPECTED_FIELD" }),
    );
  });

  it("uses stable, non-reflective error messages", () => {
    const form = validForm();
    form.set("prompt", "secret-user-prompt");
    form.set("unexpected", "secret-user-prompt");

    let error: unknown;
    try {
      parseRealJobIntake(form);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RealJobIntakeError);
    expect(String(error)).not.toContain("secret-user-prompt");
  });
});
