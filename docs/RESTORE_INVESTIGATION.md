# Restore investigation, 13 September 2026

The recovery-latch failure has been reproduced and fixed. Final validation is
recorded below. This does not certify the installed CEP/CookieMonster pair.

## Cause and correction

A spontaneous full-suite failure was captured in
`coverage/restore-diagnosis-jO5JNv/1/trace-107016.jsonl`, events 44-51. After the
host reply, a local `EPERM` was followed by reconnection, binding suspension
and a failed restore response. No transport error preceded the reconnect.

`Client.mark(false)` cleared the in-memory recovery flag before calling
`Store.save()`. Windows can reject the atomic replacement of `credential.json`
while another handle holds the file. When publication failed, the old flag on
disk stayed set but the in-memory flag was already clear. The command error
then allowed the next poll to reconnect, revoking the active restore binding.

The regression in `test/recovery-latch.test.mjs` holds the actual credential
file with a Windows handle that denies sharing, after the host command starts.
It produced `EPERM` at publication and the original `aborted` restore result
before the fix. This uses a real filesystem refusal, not an injected transport
error. The spontaneous trace identifies the failing stage; it does not identify
which external process held the file in the earlier run.

The panel now keeps both in-memory recovery flags set when publication fails.
At command boundaries it retries only local metadata publication for Windows
`EPERM`, `EACCES` and `EBUSY`, with asynchronous delays totalling at most 900 ms
across ten attempts. No AE command or reply is resent. Initial publication must
succeed before host dispatch. A persistent failure leaves the panel locked for
recovery, including failures after an acknowledged host command.

Seven regressions cover in-memory consistency, pre-dispatch failure, failure
after acknowledgement, transient and exhausted retries, and production restore
review with a real Windows file lock. The latter also verifies that the review
remains confirmable. A generation check also prevents a delayed clear from
overwriting a newer recovery warning. Before the fix, three relevant assertions
failed, including
the native-filesystem reproduction of `aborted`:
`coverage/latch-regression-red.log`. Focused validation after the fix passed:
`coverage/latch-final-focused-2.log`. The newer-latch race also failed before
its guard was added: `coverage/latch-generation-red.log`.

Native canonical restore with the final latch fix passed on AE 26.3x87 in
42,345 ms, including backups, all 96 layers and return to the original project
with its saved hash unchanged. Evidence:
`coverage/native-restore-wgX5Lu/report.json`.

Final uninstrumented acceptance: **393/393 passed**, zero failures, 392.58
seconds, recorded in `coverage/restore-final-acceptance.log`. The preceding
instrumented run passed 392/392 before the additional newer-latch regression.
`node scripts/check.mjs` parsed 48 scripts, and the rebuilt client package passed
artifact inventory and SHA256 verification for all 14 files.

## Captured failure

The full instrumented suite reported 385/386 passing in 396.11 seconds.
`test/workflow.test.mjs`, "production manual restore traverses bridge transport
host source and real storage for canonical and fallback", failed with
`outcome_uncertain`. Evidence is in `coverage/restore-trace-new.log`.

The trace shows a new `/connect` negotiation suspending a binding with an
`inspect` command pending. The panel request then failed. No transport request
error precedes that suspension in this trace. The subsequent heartbeat
`ECONNRESET` occurs during fixture cleanup, after the panel request failed;
it must not be mistaken for the trigger.

This initial trace showed the interruption but did not explain the reconnect.
The later trace and filesystem regression above identify the latch-publication
failure that causes it.

## Repeatable diagnostics

```powershell
node scripts/debug/restore.mjs --runs=3
node scripts/debug/restore.mjs --full
```

See [the diagnostic command documentation](../scripts/debug/README.md).
It records tick errors, reconnect conditions, socket errors, suspension reasons,
command phases and event-loop stalls. Bridge fixtures are preserved and traces
contain timestamps and process IDs. Instrumentation is applied only in test
processes, without editing or packaging production code.

Two initial diagnostic runs passed the panel and runtime restore tests.
After adding the newly failing manual-restore test, three further diagnostic
runs passed all selected scenarios. Evidence directories:

- `coverage/restore-diagnosis-Iye29a`, two runs.
- `coverage/restore-diagnosis-cASE6R`, three runs.
- `coverage/restore-loaded-focus.log`, focused tests alongside the first full run.

The second full run, with tick/reconnect tracing enabled, passed 386/386 in
393.66 seconds. Its evidence is `coverage/restore-diagnosis-92sHB4/1`.
It did not reproduce the unexpected reconnect. Those green runs alone did not
close the investigation; the later causal trace and regression were required.

`node scripts/check.mjs` parsed 47 scripts. The temporary inline logging was
removed from production sources; only the explicit diagnostic preload remains.

The first two diagnostic runs recorded event-loop stalls up to 1,190 ms.
Those measurements do not establish a five-second transport timeout.

A deliberate dropped poll verified the diagnostic failure path in
`coverage/restore-diagnosis-3HO668`. It captured `ECONNRESET`, `disconnected`,
reconnection, binding suspension and `outcome_uncertain`. The run receipt marks
the injected fault. It is not evidence of spontaneous reproduction.

## Native qualification

The native runner initially rejected its read-only preflight:
"Open project must be clean, saved and idle". See
`coverage/native-restore-investigation.log`. It did not switch projects or run
a restore at that point.

A separate read-only status check confirmed `saved=true dirty=true
rendering=false` in `coverage/native-state.txt`. The user then explicitly
authorized saving the project. It was saved at its existing path,
`D:/Workarea/CookieJar/AE Test Env/checkpoint testing.aep`, and verified clean.
Save acknowledgement is in `coverage/native-save-7dae2o/result.txt`.

The subsequent native CLI qualification **passed** on AE 26.3x87 using
`compact-restore-v2`. Restore took 32,110 ms. The runner verified:

- All 96 layers and the original composition name returned.
- The restored project bytes matched the source checkpoint.
- The current-state backup retained the deliberately unsaved test edit.
- Emergency backup bytes matched the verified current-state checkpoint.
- The previous disk checkpoint matched the original test checkpoint.
- The executing lock cleared after confirmed completion.
- The user's original project reopened, with its post-save hash unchanged.

Evidence: `coverage/native-restore-EWO9Yg/report.json` and
`coverage/native-restore-after-save.log`. Recovery files remain retained.
This exercised production source through the native CLI against a disposable
project. It did not qualify the installed CEP/live CookieMonster pair or
reproduce the intermittent automated interruption. Native fallback restore
was not exercised by this canonical-restore run.

The previously delivered unsigned candidate predates this fix and is superseded.
Its archive remains unchanged. Installed-pair qualification and signing are
still required before deployment of a replacement candidate.
