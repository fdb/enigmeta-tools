// Minimal DER (ASN.1) writer and PEM helpers — just enough to emit PKCS#8 and
// SEC1 private keys. Everything is length-prefixed and byte-exact so the output
// matches what OpenSSL / cryptography libraries produce.

// --- base64 (no Buffer/atob dependency, works in browser and Node) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const len = clean.indexOf("=") === -1 ? clean.length : clean.indexOf("=");
  const outLen = Math.floor((len * 6) / 8);
  const out = new Uint8Array(outLen);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)];
    if (v === -1) continue; // skip '='
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// --- DER primitives ---------------------------------------------------------

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// INTEGER for small non-negative values (0/1 only used here).
export function derInt(value: number): Uint8Array {
  return tlv(0x02, Uint8Array.of(value));
}
export function derSequence(...items: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(...items));
}
export function derOctetString(content: Uint8Array): Uint8Array {
  return tlv(0x04, content);
}
// A pre-encoded OID's *content* bytes -> full OID TLV.
export function derOid(contentBytes: Uint8Array): Uint8Array {
  return tlv(0x06, contentBytes);
}
// BIT STRING with 0 unused bits.
export function derBitString(content: Uint8Array): Uint8Array {
  return tlv(0x03, concat(Uint8Array.of(0x00), content));
}
// Context-specific constructed tag [n].
export function derContext(n: number, content: Uint8Array): Uint8Array {
  return tlv(0xa0 | n, content);
}

// --- PEM --------------------------------------------------------------------

export function toPem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [""];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
