export type SabEligibility = {
  eligible: boolean;
  reasons: string[];
  supportsSharedArrayBuffer: boolean;
  supportsAtomicsWaitAsync: boolean;
  crossOriginIsolated: boolean | null;
  policyHints: string[];
};

type AtomicsWithWaitAsync = typeof Atomics & { waitAsync?: (...args: unknown[]) => unknown };
type GlobalThisWithCoi = typeof globalThis & { crossOriginIsolated?: boolean };

const policyHints = [
  "Cross-Origin-Opener-Policy: same-origin",
  "Cross-Origin-Embedder-Policy: require-corp or credentialless",
  "Permissions-Policy: cross-origin-isolated",
];

export function getSabEligibility(): SabEligibility {
  const supportsSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const supportsAtomics = typeof Atomics !== "undefined";
  const supportsAtomicsWaitAsync =
    supportsAtomics && typeof (Atomics as AtomicsWithWaitAsync).waitAsync === "function";
  const coi = (globalThis as GlobalThisWithCoi).crossOriginIsolated;
  const crossOriginIsolated = typeof coi === "boolean" ? coi : null;
  const reasons: string[] = [];
  if (!supportsSharedArrayBuffer) reasons.push("SharedArrayBuffer is not available");
  if (!supportsAtomics) reasons.push("Atomics is not available");
  if (crossOriginIsolated === false) reasons.push("crossOriginIsolated is false");
  const eligible = supportsSharedArrayBuffer && supportsAtomics && crossOriginIsolated !== false;
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
