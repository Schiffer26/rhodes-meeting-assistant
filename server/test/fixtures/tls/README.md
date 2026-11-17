# TEST-ONLY TLS fixtures

> **These certificates and private keys are for the automated test suite only.**
> They are public by construction: the private keys are committed to this repository on
> purpose, so the HTTPS path can be exercised without generating anything at run time.
> Never use them for a real deployment, never install them in a trust store, and never
> copy them to the Windows host. Production certificate provisioning is an operational
> responsibility — see `ARCHITECTURE.md` §3.1.

| File | Purpose |
| --- | --- |
| `rhodes-test-cert.pem` | Self-signed certificate, matched pair A |
| `rhodes-test-key.pem` | Private key for pair A |
| `rhodes-test-other-cert.pem` | Self-signed certificate, pair B — unrelated to pair A |
| `rhodes-test-other-key.pem` | Private key for pair B |

Pair B exists so a **mismatched** certificate/key combination can be built from real PEM
material (`cert` A + `key` B) without hand-editing a key into nonsense.

## Properties

- Type: RSA 2048, SHA-256, self-signed, `CA:TRUE` so the certificate can also serve as the
  trust anchor a test client pins with `ca:`.
- Subject alternative names: `DNS:localhost`, `IP:127.0.0.1`, `IP:::1` — loopback only.
- Subject: `O = RHODES TEST ONLY`, `CN = RHODES test certificate - NOT FOR PRODUCTION`.
- Validity: 2026-11-17 → 2126-10-24 (100 years, so the suite does not rot).
- Fingerprints (SHA-256):
  - A: `57:82:77:17:3C:46:A8:C5:49:24:4A:15:D2:10:86:A5:A7:36:B3:AF:0B:BA:F4:C3:85:DA:9D:BF:07:68:DA:C5`
  - B: `47:5A:CE:DC:71:40:F8:07:19:43:B6:1A:64:23:31:10:8C:DC:6A:BC:27:A5:AB:5E:CE:6D:57:08:D9:FF:C6:5A`

## Regenerating

Only if a fixture is ever lost. The `CN` must stay under 64 characters or `openssl req`
fails with "Error adding subject name attribute".

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout rhodes-test-key.pem -out rhodes-test-cert.pem -days 36500 \
  -subj "/O=RHODES TEST ONLY/CN=RHODES test certificate - NOT FOR PRODUCTION" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" \
  -addext "extendedKeyUsage=serverAuth"
```

The suite itself does not need `openssl` at run time: the PEM files are checked in.
