# Release Gates

Status: **blocked, unsigned, no certified environments or approved artifacts**. Build success is not release approval. [#16](https://github.com/trmosala/CookieJar/issues/16) requires desktop packaging, a signed ZXP, host qualification and operational evidence. No signing or publication was performed by this implementation task.

The coordinating parent's verified snapshot passed 152/152 tests with no skips in approximately 223 seconds, 32 script checks, an actual 11-artifact build, and `verify-build.mjs --rebuild`. The previous missing-plugin/metadata blockers are resolved. Rollback/chunking and adapter recovery/grant review fixes still need the parent's final integrated verification; this snapshot is not approval of subsequent edits.

## Reproducible Build

Run the README checks on a clean checkout with a valid package.json and committed lockfile, Node 22+ and Bun 1.3.14. `npm ci --ignore-scripts` installs only declared dependencies. Build uses Bun with target=node, ESM and bundled packages; there is no source-only fallback when Bun is absent. The root Zod version must be 4.1.8.

The panel is copied from `panel/` including CSXS manifest and host scripts. Unexpected asset extensions, symlinks, dotfiles and known credential/temp names fail closed rather than silently producing an incomplete panel. Keep all pairing state, credentials, captures, project files, checkpoints and logs outside source directories. Review source/assets for embedded secrets before release; filenames and hashes alone are not a secret scanner.

The build copies `release/AGENTS.md` to `dist/AGENTS.md` and includes it in `dist/manifest.json`. Put that file at the top level of the outer team-release ZIP beside its README, signed ZXP, `cm-ae` directory, build manifest and checksums. Do not place it in `dist/panel` or alter a signed ZXP to add it. Generate the outer archive's `SHA256SUMS.txt` only after staging `AGENTS.md`. Run `node scripts/verify-team-release.mjs RELEASE_DIRECTORY` before creating the ZIP. The check requires an exact checksum inventory, validates every hash, compares the shipped build files with `build-manifest.json`, and matches the single ZXP to its signing receipt.

Create the deliverable with `node scripts/package-team-release.mjs RELEASE_DIRECTORY OUTPUT.zip`. This requires libarchive's bsdtar, available as `tar` on Windows, or installed as `tar` on other platforms. The command refuses an existing output, verifies the release directory, creates the ZIP, reopens it, and compares every archived file byte-for-byte with the verified inputs before publishing. The verifier also checks exact backend and embedded ZXP panel inventories, panel hashes, and the CEP version against the build version. Only the signing-generated `META-INF/signatures.xml` is excluded from the unsigned panel inventory.

These commands verify checksums and receipt consistency, not signature authenticity. `signature-verification.txt` is retained as evidence only; its presence is not treated as success. Run `scripts/sign-zxp.mjs verify` on the staged ZXP and complete the publisher trust review below before distribution. The regression fixture uses an unsigned ZIP as a ZXP container and does not constitute signature validation.

`dist/manifest.json` lists sorted relative paths, byte counts and SHA256 hashes without timestamps or absolute build paths. `node scripts/verify-build.mjs --rebuild` checks inventory/hashes and a second build's exact manifest equality. This is a same-toolchain reproducibility check, not proof of cross-toolchain or cross-OS identity. Run builds serially. Build replaces its named output files; do not keep unrelated files under dist.

The detached render supervisor is bundled separately as `dist/cm-ae/render-worker.mjs` and remains a relative import from `plugin.mjs`, preserving its executable file URL for process launch. Ship the whole `cm-ae` directory. The owned packaging regression verifies this path by intercepting spawn, loads bundled Zod in isolation, and checks repeat-build hashes using a synthetic plugin entry with the real worker source. The actual plugin entry now exists and its build/rebuild passed parent verification. For release evidence, also smoke-load the final trusted package in isolation without repo node_modules, then exercise the actual desktop loader. Fully quit and restart CookieMonster/OpenCode after explicitly installing the final plugin/config. Desktop startup and real host rendering remain separate qualification gates.

## Explicit Signing

An authorized release engineer must provision the approved executable and certificate outside the checkout, with secrets injected by the secure signing environment:

- `ZXPSIGNCMD`: absolute approved ZXPSignCmd executable path.
- `ZXP_CERTIFICATE`: absolute signing certificate path.
- `ZXP_CERT_PASSWORD`: certificate password; never commit or log it.
- Install `7z` or `unzip` for archive integrity checking.

Commands, for an existing release-output directory and a new file:

```sh
node scripts/sign-zxp.mjs sign /approved/output/cm-ae.zxp
node scripts/sign-zxp.mjs verify /approved/output/cm-ae.zxp
```

Use an appropriate absolute Windows path on Windows. Missing credentials/tools fail closed, existing output is refused, failed newly-created output is removed, and raw signer output is suppressed. The wrapper invokes ZIP integrity testing and ZXPSignCmd signature verification. ZXPSignCmd receives the password in its argument vector: use an isolated signing runner because other privileged local processes may inspect argv. Do not use shared developer sessions for real signing.

Tool success does not establish publisher trust, certificate suitability, timestamp policy or approval to distribute. The release owner must record the signing tool version/hash, trusted publisher identity, validity/revocation evidence, timestamp decision, signed ZXP SHA256, and extension-manager install/remove results. The build manifest stays `signed:false`; never relabel unsigned inputs as signed. Record approved signed artifacts separately through review.

## Approval Checklist

- Desktop team supplies tested compatible CookieMonster installer plus browser/AE bundled startup evidence.
- QA supplies exact matrix entries and every scenario in QUALIFICATION.md; no null/TBD certification fields.
- Panel owner verifies manifest and runtime hard-stop behavior for exact supported AE points, unsupported hosts and plugin/panel protocol mismatch.
- Security/release owners verify archive, trusted signatures, artifact inventory, absence of secrets and package contents.
- Upgrade tests preserve required per-user pairing, checkpoints and active-job recovery data; no installer includes those files.
- Replace null CookieMonster build/update link in compatibility.json with approved internal values; verify mutual update links in both installed apps.
- Publish only approved mapping and signed hashes through the authorized internal channel, with support owner and rollback instructions.
- Start the closed pilot only after certification and approval. Production release requires PILOT.md sign-off.

CI runs Windows/macOS Node checks and builds only. It has read-only repository permissions and no signing, upload, release or deployment step.
