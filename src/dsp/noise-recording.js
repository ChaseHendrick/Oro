import { base64ToBytes } from './terrains.js';
function bytesToBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export const MAX_NOISE_SECONDS = 16;
export function encodeNoiseRecording(samples, sampleRate, name = 'Recording') {
  const length = Math.min(samples.length, Math.round(sampleRate * MAX_NOISE_SECONDS));
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return { name: String(name).slice(0, 80), sampleRate, data: bytesToBase64(bytes) };
}
export function sanitizeNoiseRecording(src) {
  if (!src || typeof src.data !== 'string' || !Number.isFinite(src.sampleRate)) return null;
  const sampleRate = Math.round(src.sampleRate);
  if (sampleRate < 8000 || sampleRate > 192000 || src.data.length > Math.ceil(sampleRate * MAX_NOISE_SECONDS * 2 / 3) * 4 + 16) return null;
  const bytes = base64ToBytes(src.data);
  if (bytes.length < 4 || bytes.length % 2 || bytes.length > sampleRate * MAX_NOISE_SECONDS * 2) return null;
  return { name: String(src.name || 'Recording').slice(0, 80), sampleRate, data: src.data };
}
export function decodeNoiseRecording(src, targetRate = src?.sampleRate) {
  const clean = sanitizeNoiseRecording(src);
  if (!clean) return new Float32Array(0);
  const bytes = base64ToBytes(clean.data), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / 2, ratio = clean.sampleRate / targetRate;
  const out = new Float32Array(Math.max(2, Math.round(count / ratio)));
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio, j = Math.floor(position), t = position - j;
    out[i] = ((1 - t) * view.getInt16(Math.min(count - 1, j) * 2, true) + t * view.getInt16(Math.min(count - 1, j + 1) * 2, true)) / 32768;
  }
  return out;
}
