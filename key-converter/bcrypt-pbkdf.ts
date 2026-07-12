// bcrypt-pbkdf — the password-based key derivation function OpenSSH uses to turn
// a passphrase into the key/IV that decrypts a private key. Pure TypeScript port
// of the OpenBSD reference (bcrypt_pbkdf.c + blowfish.c), which WebCrypto does
// not provide. All arithmetic is kept in unsigned 32-bit space with `>>> 0`.

import { P_ORIG, S_ORIG } from "./blowfish-boxes";

const BLOWFISH_ROUNDS = 16;

interface BlowfishCtx {
  P: Uint32Array; // 18 subkeys
  S: Uint32Array; // 4 × 256 S-box entries, flattened
}

function newCtx(): BlowfishCtx {
  return { P: Uint32Array.from(P_ORIG), S: Uint32Array.from(S_ORIG) };
}

// The Blowfish F function and a single 64-bit encipher round pair. `xl`/`xr` are
// passed and returned via a 2-element array to keep both halves in 32-bit range.
function F(ctx: BlowfishCtx, x: number): number {
  const S = ctx.S;
  const a = (x >>> 24) & 0xff;
  const b = (x >>> 16) & 0xff;
  const c = (x >>> 8) & 0xff;
  const d = x & 0xff;
  // ((S0[a] + S1[b]) ^ S2[c]) + S3[d], all mod 2^32.
  let y = (S[a] + S[256 + b]) >>> 0;
  y = (y ^ S[512 + c]) >>> 0;
  y = (y + S[768 + d]) >>> 0;
  return y >>> 0;
}

function encipher(ctx: BlowfishCtx, lr: Uint32Array, off: number): void {
  const P = ctx.P;
  let xl = lr[off] >>> 0;
  let xr = lr[off + 1] >>> 0;
  for (let i = 0; i < BLOWFISH_ROUNDS; i += 2) {
    xl = (xl ^ P[i]) >>> 0;
    xr = (xr ^ F(ctx, xl)) >>> 0;
    xr = (xr ^ P[i + 1]) >>> 0;
    xl = (xl ^ F(ctx, xr)) >>> 0;
  }
  xl = (xl ^ P[16]) >>> 0;
  xr = (xr ^ P[17]) >>> 0;
  // Halves swap on output.
  lr[off] = xr >>> 0;
  lr[off + 1] = xl >>> 0;
}

// Read the next big-endian 32-bit word from `data`, advancing `pos` cyclically.
// Returns [word, newPos].
function stream2word(data: Uint8Array, pos: number): [number, number] {
  let w = 0;
  for (let i = 0; i < 4; i++) {
    w = ((w << 8) | data[pos]) >>> 0;
    pos = (pos + 1) % data.length;
  }
  return [w >>> 0, pos];
}

// Key-only expansion (Blowfish_expand0state): XOR key into P, then run the
// cipher forward filling P and the S-boxes with zero input.
function expand0state(ctx: BlowfishCtx, key: Uint8Array): void {
  const P = ctx.P;
  const S = ctx.S;
  let kpos = 0;
  for (let i = 0; i < 18; i++) {
    let w: number;
    [w, kpos] = stream2word(key, kpos);
    P[i] = (P[i] ^ w) >>> 0;
  }
  const lr = new Uint32Array(2); // both zero
  for (let i = 0; i < 18; i += 2) {
    encipher(ctx, lr, 0);
    P[i] = lr[0];
    P[i + 1] = lr[1];
  }
  for (let i = 0; i < 1024; i += 2) {
    encipher(ctx, lr, 0);
    S[i] = lr[0];
    S[i + 1] = lr[1];
  }
}

// Full expansion with salt (Blowfish_expandstate): like expand0state but the
// running cipher input is XORed with successive salt words before each block.
function expandstate(ctx: BlowfishCtx, data: Uint8Array, key: Uint8Array): void {
  const P = ctx.P;
  const S = ctx.S;
  let kpos = 0;
  for (let i = 0; i < 18; i++) {
    let w: number;
    [w, kpos] = stream2word(key, kpos);
    P[i] = (P[i] ^ w) >>> 0;
  }
  let dpos = 0;
  const lr = new Uint32Array(2);
  for (let i = 0; i < 18; i += 2) {
    let a: number, b: number;
    [a, dpos] = stream2word(data, dpos);
    [b, dpos] = stream2word(data, dpos);
    lr[0] = (lr[0] ^ a) >>> 0;
    lr[1] = (lr[1] ^ b) >>> 0;
    encipher(ctx, lr, 0);
    P[i] = lr[0];
    P[i + 1] = lr[1];
  }
  for (let i = 0; i < 1024; i += 2) {
    let a: number, b: number;
    [a, dpos] = stream2word(data, dpos);
    [b, dpos] = stream2word(data, dpos);
    lr[0] = (lr[0] ^ a) >>> 0;
    lr[1] = (lr[1] ^ b) >>> 0;
    encipher(ctx, lr, 0);
    S[i] = lr[0];
    S[i + 1] = lr[1];
  }
}

// The bcrypt "magic" — 4 blocks (8 words) of "OxychromaticBlowfishSwatDynamite"
// encrypted 64 times under the eks-derived state.
const MAGIC = new TextEncoder().encode("OxychromaticBlowfishSwatDynamite");

// bcrypt_hash: eks-expand the state from (sha512pass, sha512salt), then encrypt
// the magic string 64 times. Writes 32 bytes into `out`.
function bcryptHash(sha2pass: Uint8Array, sha2salt: Uint8Array, out: Uint8Array): void {
  const ctx = newCtx();
  expandstate(ctx, sha2salt, sha2pass);
  for (let i = 0; i < 64; i++) {
    expand0state(ctx, sha2salt);
    expand0state(ctx, sha2pass);
  }

  const cdata = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    // big-endian read of the magic into words
    const [w] = stream2word(MAGIC, i * 4);
    cdata[i] = w;
  }
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 8; j += 2) encipher(ctx, cdata, j);
  }

  // Store each word little-endian (the reference's byte-swap on output).
  for (let i = 0; i < 8; i++) {
    out[4 * i + 3] = (cdata[i] >>> 24) & 0xff;
    out[4 * i + 2] = (cdata[i] >>> 16) & 0xff;
    out[4 * i + 1] = (cdata[i] >>> 8) & 0xff;
    out[4 * i + 0] = cdata[i] & 0xff;
  }
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-512", data as BufferSource);
  return new Uint8Array(buf);
}

/**
 * Derive `keylen` bytes from a passphrase using OpenSSH's bcrypt-pbkdf.
 * @param pass  passphrase bytes (UTF-8)
 * @param salt  salt bytes from the key's kdfoptions
 * @param rounds  iteration count from kdfoptions
 * @param keylen  number of output bytes (e.g. 48 for aes256-ctr: 32 key + 16 IV)
 */
export async function bcryptPbkdf(
  pass: Uint8Array,
  salt: Uint8Array,
  rounds: number,
  keylen: number,
): Promise<Uint8Array> {
  if (rounds < 1) throw new Error("bcrypt-pbkdf: rounds must be >= 1");
  if (keylen <= 0 || keylen > 1024) throw new Error("bcrypt-pbkdf: bad key length");

  const origkeylen = keylen;
  const out = new Uint8Array(origkeylen);
  const tmpout = new Uint8Array(32);
  const stride = Math.floor((origkeylen + 32 - 1) / 32);
  let amt = Math.floor((origkeylen + stride - 1) / stride);

  const sha2pass = await sha512(pass);

  let rem = origkeylen; // bytes still owed
  for (let count = 1; rem > 0; count++) {
    // countsalt = salt || uint32_be(count)
    const countsalt = new Uint8Array(salt.length + 4);
    countsalt.set(salt, 0);
    countsalt[salt.length + 0] = (count >>> 24) & 0xff;
    countsalt[salt.length + 1] = (count >>> 16) & 0xff;
    countsalt[salt.length + 2] = (count >>> 8) & 0xff;
    countsalt[salt.length + 3] = count & 0xff;

    let sha2salt = await sha512(countsalt);
    bcryptHash(sha2pass, sha2salt, tmpout);
    const out32 = tmpout.slice(); // per-block accumulator (XOR of every round)

    for (let i = 1; i < rounds; i++) {
      sha2salt = await sha512(tmpout);
      bcryptHash(sha2pass, sha2salt, tmpout);
      for (let j = 0; j < 32; j++) out32[j] ^= tmpout[j];
    }

    // Spread this block's bytes across the key at `stride` intervals.
    amt = Math.min(amt, rem);
    let i = 0;
    for (; i < amt; i++) {
      const dest = i * stride + (count - 1);
      if (dest >= origkeylen) break;
      out[dest] = out32[i];
    }
    rem -= i;
  }

  return out;
}
