# key-converter tests

These are development checks for the private-key conversion logic. They are not
wired into `npm run build`; run them by hand when touching the crypto.

`vectors.json` (git-ignored — it contains generated private keys) holds OpenSSH
keys alongside the expected PKCS#8 / SEC1 output from a reference library, so the
converter is validated byte-for-byte.

## Regenerate the vectors

Needs Python with `cryptography` and `bcrypt` (a venv is easiest):

```bash
python3 -m venv /tmp/kcvenv && /tmp/kcvenv/bin/pip install cryptography bcrypt
/tmp/kcvenv/bin/python gen-vectors.py > key-converter/test/vectors.json
```

## Run

Bundle with the repo's esbuild and run under Node (has WebCrypto):

```bash
# unit: bcrypt-pbkdf against a known vector
node_modules/.bin/esbuild key-converter/test/bcrypt.test.ts \
  --bundle --format=esm --platform=node --outfile=/tmp/bcrypt.mjs && node /tmp/bcrypt.mjs

# end-to-end: OpenSSH -> PKCS#8 / SEC1 byte-exact, plus error paths
node_modules/.bin/esbuild key-converter/test/convert.test.ts \
  --bundle --format=esm --platform=node --loader:.json=json \
  --outfile=/tmp/convert.mjs && node /tmp/convert.mjs
```
