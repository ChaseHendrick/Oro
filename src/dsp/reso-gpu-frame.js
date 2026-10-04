// GPU Resonator (2.12): the frame format and block timing shared by the
// audio thread (reso-feed.js) and the GPU host (reso-gpu-plan.js). Kept in
// its own tiny module so the AudioWorklet bundle does not carry the planner
// or the WGSL kernels.

/** Floats per internal sample from the worklet: x, fTarget, dotX, dotY, strikeAmp, strikeX, strikeY, mode, decay, tone, listen. */
export const FRAME = 11;
export const BLOCK = 256;                // internal samples per GPU job
export const LATENCY_BLOCKS = 3;         // the worklet reads the output this many blocks late
