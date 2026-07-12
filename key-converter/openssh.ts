// Parser for the OpenSSH private key format ("openssh-key-v1"), including
// bcrypt-encrypted keys. Returns the raw key material; DER/PEM encoding of the
// result lives in convert.ts.

import { fromBase64 } from "./der";
import { bcryptPbkdf } from "./bcrypt-pbkdf";

export interface Ed25519Key {
  kind: "ed25519";
  seed: Uint8Array; // 32-byte private scalar seed
  pub: Uint8Array; // 32-byte public key
  comment: string;
}

export interface EcdsaKey {
  kind: "ecdsa";
  sshCurve: string; // "nistp256" | "nistp384" | "nistp521"
  d: Uint8Array; // private scalar (mpint, as stored)
  q: Uint8Array; // public point, uncompressed (0x04 || X || Y)
  comment: string;
}

export type SshKey = Ed25519Key | EcdsaKey;

// Thrown for inputs we understand but deliberately don't convert (RSA/DSA), so
// the UI can show a precise message.
export class UnsupportedKeyError extends Error {}
// Thrown when the passphrase is missing or wrong.
export class PassphraseError extends Error {}

const MAGIC = "openssh-key-v1\0";

// Sequential reader over SSH wire format (uint32 length-prefixed fields).
class Reader {
  private view: DataView;
  constructor(
    private buf: Uint8Array,
    private pos = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get offset() {
    return this.pos;
  }
  remaining() {
    return this.buf.length - this.pos;
  }
  uint32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("truncated key data");
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v >>> 0;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("truncated key data");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  string(): Uint8Array {
    return this.bytes(this.uint32());
  }
  cstr(): string {
    return new TextDecoder().decode(this.string());
  }
}

// Extract the base64 payload from a PEM block with the given label.
export function pemBody(pem: string, label: string): Uint8Array | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const m = pem.match(re);
  if (!m) return null;
  return fromBase64(m[1]);
}

// AES-CTR decryption via WebCrypto. keyLen/ivLen come from the cipher spec.
async function aesCtrDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-CTR" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: iv as BufferSource, length: 128 },
    ck,
    data as BufferSource,
  );
  return new Uint8Array(pt);
}

interface CipherSpec {
  keyLen: number;
  ivLen: number;
  blockSize: number;
  decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => Promise<Uint8Array>;
}

function cipherSpec(name: string): CipherSpec {
  switch (name) {
    case "aes256-ctr":
      return { keyLen: 32, ivLen: 16, blockSize: 16, decrypt: aesCtrDecrypt };
    case "aes192-ctr":
      return { keyLen: 24, ivLen: 16, blockSize: 16, decrypt: aesCtrDecrypt };
    case "aes128-ctr":
      return { keyLen: 16, ivLen: 16, blockSize: 16, decrypt: aesCtrDecrypt };
    default:
      throw new UnsupportedKeyError(
        `This key is encrypted with the “${name}” cipher, which this tool can’t ` +
          `decrypt. Re-encrypt it with the modern default (aes256-ctr), e.g. ` +
          `\`ssh-keygen -p -Z aes256-ctr -f <keyfile>\`, then try again.`,
      );
  }
}

// Read the per-key private fields for a supported key type from the decrypted,
// checkint-validated private section.
function readPrivateKey(r: Reader): SshKey {
  const keyType = r.cstr();
  if (keyType === "ssh-ed25519") {
    const pub = r.string(); // 32
    const priv = r.string(); // 64 = seed(32) || pub(32)
    const comment = r.cstr();
    if (priv.length !== 64) throw new Error("unexpected ed25519 private length");
    return {
      kind: "ed25519",
      seed: priv.slice(0, 32),
      pub: pub.slice(),
      comment,
    };
  }
  if (keyType.startsWith("ecdsa-sha2-")) {
    const sshCurve = r.cstr(); // "nistp256" etc.
    const q = r.string(); // public point 0x04||X||Y
    const d = r.string(); // private scalar (mpint)
    const comment = r.cstr();
    return { kind: "ecdsa", sshCurve, d: d.slice(), q: q.slice(), comment };
  }
  if (keyType === "ssh-rsa" || keyType === "ssh-dss") {
    const nice = keyType === "ssh-rsa" ? "RSA" : "DSA";
    throw new UnsupportedKeyError(
      `This is an ${nice} key. The target formats (PKCS#8/SEC1 for Ed25519 or ` +
        `ECDSA) don’t support ${nice}, so it can’t be converted. Generate an ` +
        `Ed25519 or ECDSA key instead.`,
    );
  }
  throw new UnsupportedKeyError(`Unsupported key type: ${keyType}`);
}

/**
 * Parse (and if needed decrypt) an OpenSSH private key.
 * @throws PassphraseError, UnsupportedKeyError, or Error on malformed input.
 */
export async function parseOpenSsh(bin: Uint8Array, passphrase: string): Promise<SshKey> {
  const magic = new TextDecoder().decode(bin.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error("Not an openssh-key-v1 private key.");

  const r = new Reader(bin, MAGIC.length);
  const cipherName = r.cstr();
  const kdfName = r.cstr();
  const kdfOptions = r.string();
  const numKeys = r.uint32();
  if (numKeys !== 1) throw new Error(`Expected 1 key, found ${numKeys}.`);
  r.string(); // public key blob (unused; the private section carries its own)
  const encrypted = r.string();

  let priv: Uint8Array;
  if (cipherName === "none") {
    if (kdfName !== "none") throw new Error("Inconsistent key header.");
    priv = encrypted;
  } else {
    if (kdfName !== "bcrypt") {
      throw new UnsupportedKeyError(`Unsupported key-derivation function “${kdfName}”.`);
    }
    if (!passphrase) {
      throw new PassphraseError("This key is encrypted. Enter its passphrase.");
    }
    const spec = cipherSpec(cipherName);
    const ko = new Reader(kdfOptions);
    const salt = ko.string();
    const rounds = ko.uint32();
    const material = await bcryptPbkdf(new TextEncoder().encode(passphrase), salt, rounds, spec.keyLen + spec.ivLen);
    const key = material.subarray(0, spec.keyLen);
    const iv = material.subarray(spec.keyLen, spec.keyLen + spec.ivLen);
    priv = await spec.decrypt(key, iv, encrypted);
  }

  // Validate the paired check integers — the definitive right-passphrase test.
  const pr = new Reader(priv);
  const check1 = pr.uint32();
  const check2 = pr.uint32();
  if (check1 !== check2) {
    if (cipherName !== "none") {
      throw new PassphraseError("Wrong passphrase (decryption check failed). Try again.");
    }
    throw new Error("Corrupt key: check integers don’t match.");
  }

  return readPrivateKey(pr);
}
