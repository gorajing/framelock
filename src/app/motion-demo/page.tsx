import type { Metadata } from "next";

import { readMotionDemoEvidence } from "@/lib/demo/motion-demo-evidence.server";

import { MotionDemo } from "./motion-demo";

export const metadata: Metadata = {
  title: "FrameLock Motion — Character Reshoot Proof",
  description:
    "A fal-generated world reshoot with temporal character protection and a 121-frame canonical pixel audit.",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MotionDemoPage() {
  const admitted = await readMotionDemoEvidence();
  return admitted ? (
    <MotionDemo evidence={admitted.evidence} media={admitted.media} />
  ) : (
    <MotionDemo />
  );
}
