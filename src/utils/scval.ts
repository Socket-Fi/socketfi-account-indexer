import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

export function decodeScVal(base64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(base64, "base64"));
}

export function normalizeNative(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalizeNative);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(normalizeNative(k)), normalizeNative(v)]));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = normalizeNative(child);
    return out;
  }
  return value;
}

export function scAddressToString(scAddress: xdr.ScAddress): string {
  return Address.fromScAddress(scAddress).toString();
}

export function collectStellarAddresses(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^[CGM][A-Z2-7]{20,}$/.test(value)) output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStellarAddresses(item, output);
  else if (value instanceof Map) for (const [key, item] of value) { collectStellarAddresses(key, output); collectStellarAddresses(item, output); }
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStellarAddresses(item, output);
  return output;
}
