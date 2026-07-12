import { bcryptPbkdf } from "../bcrypt-pbkdf";

function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Reference vector from Python `bcrypt.kdf(password=b"password",
// salt=b"\x00"*16, desired_key_bytes=48, rounds=16)`.
const pass = new TextEncoder().encode("password");
const salt = new Uint8Array(16); // 16 zero bytes
const rounds = 16;
const keylen = 48;
const expected = "d5a5cbccc68dd2599ba9f56817d414c00d7ef81f37ebc44d5d626e82937aa1223c94b683f3ec30383f8de79dd023e059";

const got = hex(await bcryptPbkdf(pass, salt, rounds, keylen));
console.log("got     ", got);
console.log("expected", expected);
if (got !== expected) {
  console.error("FAIL: bcrypt-pbkdf mismatch");
  process.exit(1);
}
console.log("PASS: bcrypt-pbkdf matches reference vector");
