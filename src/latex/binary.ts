/** Decode large PDFs without millions of JS callbacks or a long fallback task. */
export async function decodeBase64(base64: string): Promise<Uint8Array> {
  const native = (Uint8Array as typeof Uint8Array & { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (native) return native.call(Uint8Array, base64);
  const length = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (let start = 0; start < base64.length; start += 262144) {
    const raw = atob(base64.slice(start, start + 262144));
    for (let i = 0; i < raw.length; i++) result[offset++] = raw.charCodeAt(i);
    if (start + 262144 < base64.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return result;
}
