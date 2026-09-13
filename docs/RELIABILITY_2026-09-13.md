# Windows reliability pass — 13 September 2026

This is development-install evidence, not release certification. Tests use the existing Atom Hello test composition and local disk. macOS, signed installation and managed storage remain unqualified.

## Environment

- Windows 11 Enterprise, 10.0.26200, 64-bit.
- After Effects 2026, executable product/file version 26.3.
- CookieJar-AE 0.2.2, installed per-user CEP development panel.
- CookieMonster installed desktop runtime; tests run locally without GitHub Actions.

## Defects corrected

Inspection queried spatial tangents on a nonspatial property while discovering render templates. The host now checks explicit spatial property value types before calling spatial APIs. The regression reproduces the original exception; all 45 host tests pass. Native template discovery now completes in Atom Hello with its text animator intact.

Render reviews appeared below the visible settings area and could expire unnoticed. Each new review now scrolls into view once. Polling does not repeatedly move the viewport. Browser checks cover staged reviews, denial and 320/360/700-pixel layouts; the installed CEP panel also brings the template review into view.

The detached render supervisor used the desktop executable without selecting its embedded Node runtime. Launch now sets `ELECTRON_RUN_AS_NODE=1` and clears preload options, matching CookieMonster's existing subprocess pattern. Bundle tests verify these launch options. The detached-supervisor failure-receipt test passes with both standalone Node and the installed CookieMonster executable.

Windows output reveal opened Explorer but reported its handoff exit code as failure. Reveal now passes the selection as one argument and acknowledges successful process launch, while still rejecting missing executables and changed output contents. The regression covers successful handoff, hash mismatch and launch failure.

## Local results

Native dashboard submission completed after the launch fix: job `a66be3bb-8827-4a40-a7d7-f0d4911cdcea`, Atom Hello #16, frames 145–145, Best Settings, H.264 Match Render Settings 5 Mbps. The panel stayed connected, listed completion and exposed the output after Verify outputs succeeded. `aerender` exited 0. Independent `ffprobe` inspection reports one H.264 frame, 1080×1920, duration 0.033333 seconds, 18,260 bytes. SHA256: `93f1a647e4d8b46c68a52d931a50f4f820939e8278d63859b6dfbdba8a49f4ec`.

The pre-fix launch remains a detached unknown job, `acf4d2e7-76c5-4cd8-a1cf-f82d1ea2b477`, with its recovery records retained. It was not automatically retried or reported as completed. The successful retest used a separate destination.

After reopening the installed panel, the completed job was recovered through its scoped review and verified again without resubmission. Show output opened the output folder without the previous false error. The panel returned to its original approximately 360-pixel width with the existing conversation and connected state intact.

- Full suite rerun: 379/379 passed. The first run passed 378/379 with `binding_suspended` in the large-project script/restart test; its nine-test file then passed on focused rerun. The later Explorer regression passed separately after it was added. Preserve the initial failure as intermittent-test evidence.
- Bundle/configuration tests: 4/4 passed.
- Syntax check: 57 scripts passed; V8 JSX parsing is not native AE certification.
- Build: 16 hashed artifacts verified and development panel installed.

Ignored local evidence is under `coverage/reliability-*` and `coverage/native-render-20260913`. The latter preserves the pre-test on-disk project. Native rendering saves the current test project before making its immutable checkpoint; no composition edit was requested or performed by this test.
