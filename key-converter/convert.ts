// Top-level conversion: detect the input format, extract the key, and emit an
// unencrypted PKCS#8 (or SEC1) PEM. All in-browser; nothing leaves the page.

import { derBitString, derContext, derInt, derOctetString, derOid, derSequence, toPem } from "./der";
import { parseOpenSsh, pemBody, UnsupportedKeyError, type SshKey } from "./openssh";

export type OutputFormat = "pkcs8" | "sec1";

export interface ConvertResult {
  pem: string;
  format: "PKCS#8" | "SEC1";
  /** Human label, e.g. "Ed25519" or "ECDSA (P-256)". */
  keyType: string;
  comment: string | null;
  /** Non-fatal note, e.g. when the input was already in a target format. */
  note?: string;
}

// Pre-encoded OID *content* bytes.
const OID = {
  ed25519: Uint8Array.of(0x2b, 0x65, 0x70), // 1.3.101.112
  ecPublicKey: Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01), // 1.2.840.10045.2.1
  p256: Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07), // 1.2.840.10045.3.1.7
  p384: Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x22), // 1.3.132.0.34
  p521: Uint8Array.of(0x2b, 0x81, 0x04, 0x00, 0x23), // 1.3.132.0.35
};

interface CurveInfo {
  label: string;
  oid: Uint8Array;
  fieldLen: number;
}

function curveInfo(sshCurve: string): CurveInfo {
  switch (sshCurve) {
    case "nistp256":
      return { label: "P-256", oid: OID.p256, fieldLen: 32 };
    case "nistp384":
      return { label: "P-384", oid: OID.p384, fieldLen: 48 };
    case "nistp521":
      return { label: "P-521", oid: OID.p521, fieldLen: 66 };
    default:
      throw new UnsupportedKeyError(`Unsupported ECDSA curve: ${sshCurve}`);
  }
}

// Ed25519 PKCS#8 (RFC 8410): the private key is an OCTET STRING wrapping the
// 32-byte seed, itself wrapped again as the PKCS#8 privateKey OCTET STRING.
function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  return derSequence(derInt(0), derSequence(derOid(OID.ed25519)), derOctetString(derOctetString(seed)));
}

// Left-pad / strip a stored mpint scalar to exactly `fieldLen` bytes.
function normalizeScalar(d: Uint8Array, fieldLen: number): Uint8Array {
  let start = 0;
  while (start < d.length && d[start] === 0) start++;
  const trimmed = d.subarray(start);
  if (trimmed.length > fieldLen) {
    throw new Error("EC private scalar longer than the curve field size.");
  }
  const out = new Uint8Array(fieldLen);
  out.set(trimmed, fieldLen - trimmed.length);
  return out;
}

// SEC1 ECPrivateKey. `withParams` adds the [0] namedCurve tag (present in a
// standalone SEC1 file, omitted inside PKCS#8 where the curve is in the header).
function ecPrivateKey(dNorm: Uint8Array, q: Uint8Array, curve: CurveInfo, withParams: boolean): Uint8Array {
  const items = [derInt(1), derOctetString(dNorm)];
  if (withParams) items.push(derContext(0, derOid(curve.oid)));
  items.push(derContext(1, derBitString(q)));
  return derSequence(...items);
}

function ecPkcs8(dNorm: Uint8Array, q: Uint8Array, curve: CurveInfo): Uint8Array {
  const algo = derSequence(derOid(OID.ecPublicKey), derOid(curve.oid));
  const inner = ecPrivateKey(dNorm, q, curve, false);
  return derSequence(derInt(0), algo, derOctetString(inner));
}

function encodeSshKey(key: SshKey, format: OutputFormat): ConvertResult {
  if (key.kind === "ed25519") {
    if (format === "sec1") {
      throw new UnsupportedKeyError(
        "SEC1 (“EC PRIVATE KEY”) only applies to ECDSA keys. Ed25519 uses " +
          "PKCS#8 — switch the output format to PKCS#8.",
      );
    }
    return {
      pem: toPem("PRIVATE KEY", ed25519Pkcs8(key.seed)),
      format: "PKCS#8",
      keyType: "Ed25519",
      comment: key.comment || null,
    };
  }
  // ECDSA
  const curve = curveInfo(key.sshCurve);
  const dNorm = normalizeScalar(key.d, curve.fieldLen);
  if (format === "sec1") {
    return {
      pem: toPem("EC PRIVATE KEY", ecPrivateKey(dNorm, key.q, curve, true)),
      format: "SEC1",
      keyType: `ECDSA (${curve.label})`,
      comment: key.comment || null,
    };
  }
  return {
    pem: toPem("PRIVATE KEY", ecPkcs8(dNorm, key.q, curve)),
    format: "PKCS#8",
    keyType: `ECDSA (${curve.label})`,
    comment: key.comment || null,
  };
}

/**
 * Convert a pasted private key to the requested unencrypted PEM format.
 * @param input       the key text (OpenSSH or PEM)
 * @param passphrase  passphrase for encrypted keys ("" if none)
 * @param format      "pkcs8" (default) or "sec1"
 */
export async function convertKey(
  input: string,
  passphrase: string,
  format: OutputFormat = "pkcs8",
): Promise<ConvertResult> {
  const text = input.trim();
  if (!text) throw new Error("Paste a private key first.");

  // OpenSSH format — the primary path.
  const ossh = pemBody(text, "OPENSSH PRIVATE KEY");
  if (ossh) {
    const key = await parseOpenSsh(ossh, passphrase);
    return encodeSshKey(key, format);
  }

  // Already in a target format (or an unsupported PEM) — detect and advise.
  if (pemBody(text, "PRIVATE KEY")) {
    return {
      pem: text.endsWith("\n") ? text : text + "\n",
      format: "PKCS#8",
      keyType: "PKCS#8",
      comment: null,
      note: "This key is already an unencrypted PKCS#8 key — no conversion needed.",
    };
  }
  if (pemBody(text, "EC PRIVATE KEY")) {
    return {
      pem: text.endsWith("\n") ? text : text + "\n",
      format: "SEC1",
      keyType: "ECDSA (SEC1)",
      comment: null,
      note: "This key is already a SEC1 EC private key — already a supported format.",
    };
  }
  if (pemBody(text, "ENCRYPTED PRIVATE KEY")) {
    throw new UnsupportedKeyError(
      "This is an encrypted PKCS#8 key. Decrypt it first, e.g. " +
        "`openssl pkcs8 -in key.pem -out key.unenc.pem`, then it’s ready to use.",
    );
  }
  if (pemBody(text, "RSA PRIVATE KEY")) {
    throw new UnsupportedKeyError(
      "This is an RSA key (PKCS#1). The target formats support only Ed25519 " + "and ECDSA, so RSA can’t be converted.",
    );
  }
  if (pemBody(text, "DSA PRIVATE KEY")) {
    throw new UnsupportedKeyError("This is a DSA key, which the target formats don’t support.");
  }

  throw new Error("Unrecognized key. Paste an OpenSSH private key " + "(-----BEGIN OPENSSH PRIVATE KEY-----).");
}
