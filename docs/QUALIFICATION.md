# Compatibility Qualification

**No environments are certified.** `compatibility.json` deliberately contains `certifiedEntries: []` and `signed: false`. AE 25 and 26 are only candidate families; a manifest major-version range is not certification. CI Windows/macOS runners and V8 host-script parsing do not substitute for real AE qualification.

## Matrix Template

Every field below needs exact values and linked evidence before moving an entry into `certifiedEntries`. TBD is a blocker, not a wildcard. Create one row per tested environment/storage combination, including native versus emulated execution.

| Candidate | OS edition/version/build | CPU/architecture and execution mode | AE exact point/build | CEP exact version | Local disk filesystem/volume mode | SMB server/version/dialect/auth/mount | Managed sync provider/client/version/hydration | Extension manager/version/install scope | Evidence/owner/status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows, AE 25 | TBD | TBD | TBD | TBD | TBD | TBD, not qualified | TBD, not qualified | TBD | Blocked; owner unassigned |
| Windows, AE 26 | TBD | TBD | TBD | TBD | TBD | TBD, not qualified | TBD, not qualified | TBD | Blocked; owner unassigned |
| macOS, AE 25 | TBD | TBD | TBD | TBD | TBD | TBD, not qualified | TBD, not qualified | TBD | Blocked; owner unassigned |
| macOS, AE 26 | TBD | TBD | TBD | TBD | TBD | TBD, not qualified | TBD, not qualified | TBD | Blocked; owner unassigned |

Record separately: CookieMonster build and SHA256; plugin/panel/protocol versions; signed ZXP SHA256 and trusted publisher; Node/Bun versions; effect/plugin versions and license state; scripting preference; rendering templates; GPU/driver where rendering depends on it; antivirus/enterprise restrictions; evidence date, tester and independent approver. For storage, include case sensitivity, permissions, offline state and rename/write/read verification. Record explicit exclusion rather than implying every SMB/sync service is supported.

## Required Scenarios

All rows need automated results plus manual end-to-end evidence on the exact environment. Status of every scenario below: **blocked until evidence**.

| Area / issues | Required positive and negative evidence |
| --- | --- |
| Packaging / #1, #16 | Development and packaged desktop start browser plus AE; browser permissions unchanged; invalid/missing optional artifact diagnosis; clean signed install/remove; compatible upgrade preserves functional state; hashes and trusted signatures; no credentials in archive. |
| Pairing / #2 | Loopback-only listener; restrictive descriptor/credential permissions on the OS; expiry, single use, replay, malformed requests, invalid credential, rotation/unpair; reconnect without binding; incompatible versions hard-stop and mutual update links. |
| Binding / #3 | Saved/unsaved inspection; exclusive ownership, takeover and release; Session deletion; disconnect/restart; Save As/project switch suspends writes; explicit rebind. |
| Inspection / #4 | Project/items/layers/properties/effects/selections/time; duplicate match names, reordered groups, missing effects, save/reopen identity, stale locators, changed fingerprints and bounded large results. |
| Transactions / #5 | Text creation; readable generic approval; denial, tampered/expired token, wrong Session/connection, stale fingerprint; verified pre-save/checkpoint; chunk rechecks; full rollback and exact failed action; timeout locks with no retry. |
| Imports/storage / #6 | Exact/recursive grants, release expiry, traversal/symlink/alias escape, case behavior, duplicate import, source immutability; qualified SMB and hydrated/unhydrated/offline sync roots; unavailable and read-only destinations; typed errors. |
| Capture / #7 | Explicit comp/time; PNG alpha and JPEG, scaling to 2000x2000 and 5 MiB; render-queue restoration, cleanup, preview/render/modal busy refusal; visible Session indicator; image attachment reaches approved model; no UI/desktop capture. |
| Raw scripts / #8 | Disabled by default, explicit Session enablement, expiry; full source/purpose/risk/hash visible; separate one-time approval; tamper and wrong-target rejection; preference denied; no transactional guarantee; timeout uncertain/no retry; release disables. |
| Checkpoints / #9 | Project-side folder; per-user fallback warning; verification, size and manifest; pin/list/delete, 10 unpinned/5 GB retention; manual restore first checkpoints current state; timestamps/confirmation; canonical failure opens recovery copy without replacing original; uncertain reconciliation. |
| Effects / #10 | Installed stable match-name inventory; built-in and representative third-party effects with exact versions; add/remove/reorder/enable/configure; live property validation and reacquisition; preserve missing effects; side-effect warning; licensing/modal timeout and rollback. |
| Composition / #11 | Create/rename/resize/retime/reorder/delete comps; supported text/shape/solid/footage/camera/light/null/precomp layers; pinned targets; long-plan warning/chunking; destructive approval, stale state and full rollback. |
| Animation / #12 | Static values; keyframe add/update/move/delete; temporal/spatial interpolation, easing/roving; markers; complete expression source, eligibility/errors, type/unit/time validation; multi-property example and rollback. |
| Rendering / #13 | Immutable checkpoint, live project remains editable; installed templates preflight; granted destination, file/sequence collisions; isolated aerender without reuse; honest progress; cancel/failure; verified outputs and quarantine. |
| Render recovery / #14 | Restart during render, completion offline, cancellation after reconnect; durable manifests; PID reuse/exact command identity, missing logs/corruption; partial output quarantine; unknown state, no fabricated percentage. |
| Diagnostics / #15 | Panel state and scripting-preference remediation; metadata-only export; redact usernames/local/network paths/credentials/codes/scripts/images/prompts/assets; release/deletion retention tests and minimal functional recovery exceptions. |
| Compatibility / #15, #16 | Exact certified points versus unsupported points/majors; plugin/panel protocol mismatch; visible installed versions and working approved mutual update links; preference unchanged; safe update rollback. |

Evidence must identify issue links, input fixture identity (synthetic or approved), commands, expected/actual result, artifact hashes and known limits without uploading client content. Every failure gets severity, a real owner, a linked defect and a retest on all affected rows. No waiver converts missing security, rollback or data-loss evidence into a pass.
