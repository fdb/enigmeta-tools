#!/usr/bin/env python3
"""Generate OpenSSH key test vectors with reference PKCS#8 / SEC1 output.

Writes JSON to stdout. Requires the `cryptography` and `bcrypt` packages.
See README.md.
"""
import json
import sys

from cryptography.hazmat.primitives import serialization as ser
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa

PASS = b"correct horse battery staple"


def dump(out, name, priv, encrypted):
    enc = ser.BestAvailableEncryption(PASS) if encrypted else ser.NoEncryption()
    ossh = priv.private_bytes(ser.Encoding.PEM, ser.PrivateFormat.OpenSSH, enc)
    pk8 = priv.private_bytes(
        ser.Encoding.PEM, ser.PrivateFormat.PKCS8, ser.NoEncryption()
    )
    rec = {"openssh": ossh.decode(), "pkcs8": pk8.decode(), "encrypted": encrypted}
    try:
        sec1 = priv.private_bytes(
            ser.Encoding.PEM, ser.PrivateFormat.TraditionalOpenSSL, ser.NoEncryption()
        )
        rec["sec1"] = sec1.decode()
    except Exception:
        pass
    out[name] = rec


def main():
    out = {}
    dump(out, "ed25519_enc", ed25519.Ed25519PrivateKey.generate(), True)
    dump(out, "ed25519_plain", ed25519.Ed25519PrivateKey.generate(), False)
    dump(out, "ecdsa_p256_enc", ec.generate_private_key(ec.SECP256R1()), True)
    dump(out, "ecdsa_p384_enc", ec.generate_private_key(ec.SECP384R1()), True)
    dump(out, "ecdsa_p521_enc", ec.generate_private_key(ec.SECP521R1()), True)
    dump(out, "ecdsa_p256_plain", ec.generate_private_key(ec.SECP256R1()), False)
    dump(out, "rsa_enc", rsa.generate_private_key(65537, 2048), True)
    json.dump({"passphrase": PASS.decode(), "keys": out}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
