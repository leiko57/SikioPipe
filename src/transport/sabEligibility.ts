export type SabEligibility = {
  eligible: boolean;
  reasons: string[];
  supportsSharedArrayBuffer: boolean;
  supportsAtomicsWaitAsync: boolean;
  crossOriginIsolated: boolean | null;
  policyHints: string[];
};

const policyHints = [
  "Cross-Origin-Opener-Policy: same-origin",
  "Cross-Origin-Embedder-Policy: require-corp or credentialless",
  "Permissions-Policy: cross-origin-isolated",
];

export function getSabEligibility(): SabEligibility {
  const supportsSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const supportsAtomicsWaitAsync = typeof Atomics !== "undefined" && typeof (Atomics as any).waitAsync === "function";
  const coi = (globalThis as any).crossOriginIsolated;
  const crossOriginIsolated = typeof coi === "boolean" ? coi : null;
  const reasons: string[] = [];
  if (!supportsSharedArrayBuffer) reasons.push("SharedArrayBuffer is not available");
  if (!supportsAtomicsWaitAsync) reasons.push("Atomics.waitAsync is not available");
  if (crossOriginIsolated === false) reasons.push("crossOriginIsolated is false");
  const eligible = supportsSharedArrayBuffer && supportsAtomicsWaitAsync && crossOriginIsolated !== false;
  return {
    eligible,
    reasons,
    supportsSharedArrayBuffer,
    supportsAtomicsWaitAsync,
    crossOriginIsolated,
    policyHints,
  };
}

export function isSabEligible() {
  return getSabEligibility().eligible;
}
