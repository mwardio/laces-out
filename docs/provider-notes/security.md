# Provider credential security

Verified: 2026-08-05

`@fantasy/security` provides a deliberately small server-side boundary:

- exactly 32-byte keys parsed from explicit `base64:`, `base64url:`, or `hex:` encodings;
- version 1 AES-256-GCM envelopes with a fresh 96-bit IV;
- authenticated version, algorithm, key ID, purpose, and creation timestamp metadata;
- a 64 KiB credential plaintext limit;
- keyring decryption by key ID to support staged rotation;
- indistinguishable bad-key/tag/ciphertext decryption failures;
- recursive and text redaction for OAuth tokens, client secrets, Authorization headers, cookies,
  `SWID`, and `espn_s2`.

The envelope `purpose` must include its security context, for example `provider:yahoo`. Passing a
different expected purpose fails before plaintext is returned, which prevents moving a valid
encrypted value into another credential field. The envelope is safe to store in the application
database, but the encryption key is not: keep keys outside the database and backups that contain
the envelopes.

Logging policy still matters. Pass errors and structured metadata through `redactSecrets` before
logging, never log request/response bodies from token endpoints, and configure the production
logger's own path-based redaction as a second layer. Redaction is not encryption and does not make
arbitrary debug dumps acceptable.

Rotation procedure:

1. Add a new key with a new key ID to the decryption keyring.
2. Make it primary for all newly written envelopes.
3. Re-encrypt existing envelopes in bounded transactions, retaining credential row versions.
4. Verify no envelopes reference the old key ID.
5. Back up the new key through the approved secret channel, then retire the old key.

Lost keys cannot be recovered from envelopes. The operational recovery is provider reconnection
and issuance of new credentials.
