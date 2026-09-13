# Render dashboard

Open Settings > Bridge services. Choose an explicit composition and discover its installed templates. Discovery briefly creates and removes a queue item and has its own review. Choose the inclusive first/last frame, templates and an absolute output filename matching the output module.

Review render first asks for an output-directory grant, then runs the existing checkpoint-backed submission workflow. The review names the project, composition, range, templates and destination. Each approval is single-use, expires after two minutes, and resumes the exact suspended operation. Denying, releasing the binding or changing projects cannot authorize a later render. No model prompt is generated. Configured tool denial remains effective.

Refresh jobs lists only the bound project/session and recoverable detached jobs. Recover access requires review. Status shows renderer-reported state and progress; it does not estimate percentages. Cancellation uses the existing process-identity checks. Verify outputs exposes only completed, hash-verified deliverables; Show output rechecks size/hash and reveals the file in the operating system. Partial files are never presented as completed outputs. Published outputs are not deleted.

On reconnect, refresh jobs rather than submitting again. Pending reviews expire when abandoned. If a submission result is uncertain, keep the recovery records and inspect the job list; do not assume that retrying is safe.

The CookieMonster runtime must have `CM_AE_AERENDER` or the plugin's `aerenderPath` option set to its trusted installed aerender executable before launch. This is deployment configuration, never a user-supplied executable in a render request. The local CookieJar workspace is configured for its installed AE 2026 executable. Existing filesystem grants and permission policy still apply.

## Validation

`node --test test/panel-render.test.mjs` exercises real authenticated panel endpoints with a simulated host, configured denial, exact staged approval, duplicate/cross-binding replies, expiry, release and project drift. `node scripts/verify-render-ui.mjs` exercises template selection, staged grant/submission, denial without retry and layouts at 320, 360 and 700 pixels. Existing renderer/workflow tests cover checkpoint submission, collisions, cancellation, detached recovery and partial outputs.

On 13 September 2026, the installed AE 2026 `aerender.exe` separately rendered frame 145 of Atom Hello from a disposable copy of the saved test project. It exited successfully and produced a 20,468-byte MP4 using the installed default output module. Evidence is retained under ignored `coverage/aerender-*`. This checks real aerender separately; it does not claim a native end-to-end dashboard submission or model run.
