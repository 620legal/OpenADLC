# 0069. A release manifest is four lines, signed with a key imported on the host

- **Status:** accepted
- **Date:** 2026-11-15

Builds on [0068](0068-a-release-is-built-in-its-own-account-and-signed-from-fields-hostd-computes.md),
and amends it where it says a repository picks which fields are signed.

## Context

A managed repository's auto-update trusts an ed25519 signature over a
release's version, sha256 and download URL. Its clients already ship with
the public key pinned, and they check one exact message. OpenADLC therefore
has to produce those bytes, and once a client ships the layout can't change
without a new client release (#342). A person chose this on the issue: match
what the shipped clients verify, and drop the per-repository choice of
fields.

The key signs whatever every client installs, and OpenADLC never rotates it,
so a leaked key can't be recovered the way a leaked App key can.

## Decision

**The signed message** is exactly:

```
<tag> LF <version> LF <sha256> LF <url> LF
```

It is UTF-8 with no BOM, every line ends in one `0x0A` (the last included),
and nothing else is in it. All three fields are always present, in that
order. Each value is checked before any bytes are built
(`releaseMessage`, `packages/shared/src/release-manifest.ts`):

| Field | Rule |
|---|---|
| tag | 1–256 UTF-8 bytes of valid Unicode (no lone surrogate), no control character (C0, DEL, C1), no leading or trailing space. Default `openadlc-release-manifest-1` |
| version | `^[0-9A-Za-z.+-]{1,64}$` |
| sha256 | `^[0-9a-f]{64}$`. Uppercase is refused, not lowercased |
| url | Up to 2048 characters with no whitespace or control character. It must parse as `https:` with no user name or password, and its `href` must equal the input, so a URL the parser would rewrite is refused |

**The signature** is ed25519 (RFC 8032, pure) over those bytes, written as
standard base64 with padding: 88 characters.

**The published asset** is `{"version","url","sha256","sig"}`, in that
order, all strings, followed by one LF (`releaseManifestAsset`). Its JSON
formatting is not signed. A client reads the three values, rebuilds the
message with its own pinned tag, and checks `sig`.

**The tag is filed with the key**, not on the repository's row. The ref is
`release-signing-key:<sha256 hex of the lowercased owner/name>`
(`releaseSigningKeyRef`, `packages/github/src/secrets.ts`). It holds one JSON
record, `{"v":1,"repo","tag","key"}`, with the key as a PKCS#8 PEM. The name
is hashed because Secret Manager allows no `.` in an id, and the name spelled
out could pass its length limit.

**Imported from a file, on the host.** `openadlc release-key import --repo
OWNER/NAME --file PATH [--tag TAG] [--replace]` takes a PKCS#8 PEM, as
`openssl genpkey -algorithm ed25519` writes it, or a base64 32-byte seed.
Anything else is refused with what to do, and nothing the file holds is
printed. A different key or tag over the one filed is refused without
`--replace`. The same key and tag again is "already imported". There is no
route in the bridge, hostd or the console that takes a key, and OpenADLC
never generates, rotates or deletes one.

**Only the signing step reads it.** `signRelease`
(`apps/hostd/src/release-sign.ts`) checks the fields, reads the record, signs,
verifies the signature against the derived public key, and returns the
signature, the asset and the public key. It never writes `process.env`, logs,
or returns or throws the key. The tag comes only from the record and is never
a parameter. A test holds `releaseSigningKeyRef` to the three files that file
or read the key.

**Encrypted backups only.** The ref is in the install group of a backup.
`writePlain` drops every release key ref itself, so no unencrypted archive
can carry one whoever writes it. Its warning says so, and `openadlc backup
--unencrypted` names the repositories it left out.

**A restore never overwrites one.** A release key the live install already
holds goes to the plan's `kept`, never to `overwrite`, and the CLI says it
was kept. One the install lacks is created. Replacing a key is
`release-key import --replace`, asked for by name.

## What this rules out

- **A per-repository choice of fields.** No client needs a subset, and each
  subset is one more layout to keep forever. This amends ADR 0068.
- **Canonical JSON (RFC 8785), or any signed JSON.** Every client would have
  to re-canonicalise or keep the raw bytes, and verifiers tend to go wrong
  there. The shipped clients don't check it either.
- **A `repos.release_tag` column set from the console.** It needs a migration
  and a browser route. It would also let a console admin silently break every
  client while the key stayed the same.
- **Normalising a value** (lowercasing a hash, rewriting a URL). The bytes
  signed must be the bytes a client reads.
- **Replacing a key from a backup.** The archive may hold an older key, or
  another install's.
- **Rotation by OpenADLC.** The public key is pinned in clients.

## What would make this worth revisiting

- **Clients that verify another layout.** That means a new tag and a new
  message, never a change to this one.
- **A key kept in hardware** (an HSM, or the Secure Enclave). Then signing
  would leave the secret store.
- **A need to rotate.** That needs clients that pin more than one key.
