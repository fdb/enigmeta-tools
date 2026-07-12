import { convertKey } from "../convert";
import vectors from "./vectors.json" with { type: "json" };

const PASS: string = (vectors as any).passphrase;
const keys: Record<string, any> = (vectors as any).keys;

function norm(pem: string): string {
  return pem.trim().replace(/\r/g, "");
}

let failures = 0;
function check(name: string, got: string, want: string) {
  if (norm(got) === norm(want)) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
    console.error("  got :", norm(got).split("\n").slice(0, 2).join(" / "));
    console.error("  want:", norm(want).split("\n").slice(0, 2).join(" / "));
    console.error("---got---\n" + norm(got));
    console.error("---want---\n" + norm(want));
  }
}

for (const [name, rec] of Object.entries(keys)) {
  const pass = rec.encrypted ? PASS : "";

  // PKCS#8 output should match the reference for ed25519 + ecdsa.
  if (name.startsWith("ed25519") || name.startsWith("ecdsa")) {
    const r = await convertKey(rec.openssh, pass, "pkcs8");
    check(`${name} pkcs8`, r.pem, rec.pkcs8);
  }

  // SEC1 output for ECDSA keys.
  if (name.startsWith("ecdsa") && rec.sec1) {
    const r = await convertKey(rec.openssh, pass, "sec1");
    check(`${name} sec1`, r.pem, rec.sec1);
  }

  // RSA must be rejected with a helpful error.
  if (name.startsWith("rsa")) {
    try {
      await convertKey(rec.openssh, pass, "pkcs8");
      failures++;
      console.error(`FAIL ${name}: expected rejection`);
    } catch (e) {
      console.log(`PASS ${name} rejected: ${(e as Error).message.slice(0, 40)}…`);
    }
  }
}

// Wrong passphrase must be reported clearly.
try {
  await convertKey(keys["ed25519_enc"].openssh, "wrong-pass", "pkcs8");
  failures++;
  console.error("FAIL wrong-passphrase: expected error");
} catch (e) {
  console.log(`PASS wrong-passphrase rejected: ${(e as Error).message.slice(0, 40)}…`);
}

// Missing passphrase on an encrypted key.
try {
  await convertKey(keys["ed25519_enc"].openssh, "", "pkcs8");
  failures++;
  console.error("FAIL missing-passphrase: expected error");
} catch (e) {
  console.log(`PASS missing-passphrase rejected: ${(e as Error).message.slice(0, 40)}…`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
if (failures) process.exit(1);
