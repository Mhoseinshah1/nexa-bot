# Recovery Kit file format — version 1

The contract a Recovery Kit (`.nxkit`) is held to. Decisions and reasons are in
[ADR-0032](adr/0032-recovery-kit.md); the schemas are in
`packages/contracts/src/recovery-kit.ts`; the one reader and writer is
`apps/api/src/infrastructure/crypto/recovery-kit.ts`. A change to anything below
is a new format version, never an edit.

## Layout

| Offset   | Length         | Content                                                       |
| -------- | -------------- | ------------------------------------------------------------- |
| 0        | 8              | ASCII `NEXAKIT1`                                              |
| 8        | 4              | `headerLength`, uint32 big-endian, `1 ≤ headerLength ≤ 16384` |
| 12       | `headerLength` | header, UTF-8 JSON                                            |
| 12 + h   | to end − 16    | ciphertext: AES-256-GCM over the UTF-8 JSON payload           |
| end − 16 | 16             | GCM authentication tag                                        |

Total size ≤ 256 KiB.

## Header (cleartext, authenticated)

```json
{
  "format": 1,
  "kitId": "<uuid>",
  "createdAt": "<ISO-8601 UTC>",
  "kdf": { "algorithm": "scrypt", "log2N": 17, "r": 8, "p": 4, "salt": "<base64url, 16–64 bytes>" },
  "cipher": "aes-256-gcm",
  "iv": "<base64url, 12 bytes>"
}
```

Strict: an unknown field anywhere is malformed. Accepted bounds: `log2N` 10–18,
`r` = 8, `p` 1–4. The writer uses `log2N = 17, r = 8, p = 4` (a test profile
`log2N = 10, p = 1` exists and is refused in production by the same switch that
selects the password hasher's cost).

## Key derivation and encryption

- `passphraseBytes = UTF-8(NFC(passphrase))`
- `key = scrypt(passphraseBytes, salt, 32, N = 2^log2N, r, p)`
- `ciphertext ‖ tag = AES-256-GCM(key, iv, plaintext = payload, AAD = bytes[0 … 12 + headerLength))`

The associated data is the magic, the length prefix and the header bytes exactly
as stored.

## Payload (inside the ciphertext)

```json
{
  "format": 1,
  "kitId": "<the header's kitId>",
  "keys": [
    {
      "keyId": "<[A-Za-z0-9._-]{1,64}>",
      "material": "<base64url, 32 bytes>",
      "fingerprint": "<32 hex>"
    }
  ]
}
```

Strict, 1–64 keys. `fingerprint = hex(SHA-256("nexa.kek.fingerprint.v1\n" ‖ material))[0..32)`.
There is deliberately no field for a key's role: whether a key encrypts is decided
by the installation's configuration alone.

## Reader order, and what each refusal is

1. Size, magic, plausible `headerLength`, file long enough for header and tag → else `recovery_kit.malformed`.
2. Header is JSON with a numeric `format` → else malformed. `format ≠ 1` → `recovery_kit.unsupported_version`.
3. Header matches the strict schema, including the KDF bounds → else malformed. **No derivation happens before this point.**
4. Derive, decrypt, verify the tag → else `recovery_kit.auth_failed` (wrong passphrase and damage are one answer).
5. Payload is JSON matching the strict schema, `kitId` equals the header's, key ids unique, each key 32 non-zero bytes matching its fingerprint → else malformed.

Plaintext and derived keys are zeroed after use. Nothing in a refusal carries the
passphrase, the key bytes or OpenSSL's message.

## Importing

An imported key is DECRYPT-ONLY. It is stored in `installation_keys`, wrapped as
`ik1.<wrappingKeyId>.<iv>.<ciphertext>.<tag>` (base64url) under the active
configured key with AAD `nexa.installation_key.v1|<keyId>|<wrappingKeyId>`. An
id equal to a held key's with different bytes refuses the whole import.
