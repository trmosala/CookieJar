import test from "node:test"
import assert from "node:assert/strict"
import { createDiagnostics } from "../src/diagnostics.mjs"

test("diagnostics allowlist discards injected text, objects, versions, hashes and secrets", () => {
  const d = createDiagnostics()
  const secret = "SECRET C:/Users/artist/project.aep password=pairing-code source prompt image"
  d.record("session", "inspect", "ok")
  d.record("session", secret, "ok")
  d.record("session", "execute", secret)
  const input = { sessionID: "session", versions: secret, hash: secret, errors: secret,
    connections: [{ id: secret, aeVersion: secret, version: secret, project: { id: secret, path: secret },
      capabilities: { fileNetwork: secret, extra: secret }, connected: secret, busy: {},
      binding: { state: secret, sessionID: secret }, lock: { state: { toString: () => "executing" }, reason: secret } }],
    jobs: [{ jobId: secret, state: secret, controllable: secret, outputState: secret, source: secret, hash: secret }],
  }
  const result = d.export(input), serialized = JSON.stringify(result)
  for (const word of ["SECRET", "artist", "password", "pairing-code", "prompt", "image", "aep"]) assert.ok(!serialized.includes(word), word)
  assert.deepEqual(result.versions, { plugin: "0.1.0", protocol: 1, zod: "4.1.8" })
  assert.equal(result.connections[0].capabilities.fileNetwork, false)
  assert.equal(result.connections[0].connected, false)
  assert.equal(result.connections[0].bindingState, "unknown")
  assert.equal(result.renders[0].state, "unknown")
  assert.equal(result.renders[0].controllable, false)
  assert.match(result.connections[0].project, /^[a-f0-9]{64}$/)
  assert.equal(d.export(input).session, result.session)
  assert.notEqual(createDiagnostics().export(input).session, result.session)
  assert.notEqual(result.connections[0].project, result.connections[0].connection)
  assert.deepEqual(result.events, [{ operation: "inspect", outcome: "ok" }])
  assert.equal(d.export({ connections: [{}], jobs: [] }).connections[0].project, null)
  assert.equal(d.export({ connections: [{ id: {} }], jobs: [{ jobId: "x".repeat(32769) }] }).renders[0].job, null)
})

test("diagnostics project finite timing, fixed errors and aggregate storage without content", () => {
  const d = createDiagnostics(), secret = "SECRET path source credentials"
  d.record("session", "render_recover", "ok", { durationMs: 12.5 })
  d.record("session", "execute", "failed", { durationMs: 0, errorCode: "stale_fingerprint", message: secret })
  for (const durationMs of [-1, Infinity, NaN, "12", { valueOf: () => 12 }])
    d.record("session", "capture", "failed", { durationMs, errorCode: secret })
  const result = d.export({ sessionID: "session", checkpoints: [
    { storageMode: "project", pinned: true, name: secret, path: secret },
    { storageMode: "fallback", pinned: false }, { storageMode: secret, pinned: secret },
  ] })
  assert.deepEqual(result.events[0], { operation: "render_recover", outcome: "ok", durationMs: 12.5 })
  assert.deepEqual(result.events[1], { operation: "execute", outcome: "failed", durationMs: 0, errorCode: "stale_fingerprint" })
  for (const event of result.events.slice(2)) {
    assert.equal(event.durationMs, undefined)
    assert.equal(event.errorCode, "unknown")
  }
  assert.deepEqual(result.storage, { checkpointCount: 3, pinnedCount: 1,
    modes: [{ storageMode: "project", count: 1 }, { storageMode: "fallback", count: 1 }, { storageMode: "unknown", count: 1 }] })
  assert.ok(!JSON.stringify(result).includes(secret))
})

test("corrupt render diagnostics use fixed reasons and aggregate unscopable counts only", () => {
  const d = createDiagnostics(), secret = "SECRET C:/private/project.aep credentials"
  const result = d.export({ unscopableRenderCount: 2, jobs: [
    { jobId: "known", state: "unknown", reason: "corrupt_manifest", detail: secret,
      controllable: true, outputState: "verified_completed", outputs: [secret] },
    { jobId: "other", state: "unknown", reason: secret, detail: secret },
  ] })
  assert.deepEqual(result.recovery, { unscopableCount: 2, remediation: "manual_manifest_recovery_required" })
  assert.equal(result.renders[0].reason, "corrupt_manifest")
  assert.equal(result.renders[0].verified, false)
  assert.equal(result.renders[0].controllable, false)
  assert.equal(result.renders[1].reason, "unknown")
  assert.ok(!JSON.stringify(result).includes(secret))
  for (const unscopableRenderCount of [-1, 1.5, Infinity, NaN, secret, {}, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(d.export({ unscopableRenderCount }).recovery.unscopableCount, 0)
})

test("retirement diagnostics retain only fixed errors, never inventory paths or approval digests", () => {
  const d = createDiagnostics(), secret = "SECRET C:/private/project.aep approval inventory"
  const codes = ["render_retire_refused", "render_retire_partial", "render_busy", "render_job", "render_closed"]
  for (const errorCode of [...codes, secret]) d.record("session", "render_retire", "failed", {
    errorCode, message: secret, jobId: secret, approval: secret, remove: [secret], removed: [secret],
    preserve: [secret], cause: secret,
  })
  const result = d.export({ sessionID: "session" })
  assert.deepEqual(result.events.map(event => event.errorCode), [...codes, "unknown"])
  assert.ok(result.events.every(event => event.operation === "render_retire"))
  assert.ok(!JSON.stringify(result).includes(secret))
  d.release("session")
  assert.deepEqual(d.export({ sessionID: "session" }).events, [])
})

test("compatibility diagnostics strip URLs, build labels and injected metadata but retain numeric negotiation evidence", () => {
  const d = createDiagnostics(), secret = "SECRET"
  const metadata = { status: "incompatible", panelVersion: "0.2.0-SECRET+artist", panelProtocol: 2,
    cookieMonsterVersion: "2.4.1+SECRET", cookieMonsterVersionStatus: "configured",
    releaseSourceUrl: "https://SECRET.test", updates: { panel: { url: "https://SECRET.test/token" } },
    credential: secret, project: secret }
  d.record("session", "bind", "failed", { errorCode: "incompatible_version", details: metadata })
  const result = d.export({ sessionID: "session", compatibility: { ...metadata, pendingPanels: [metadata] },
    connections: [{ compatibility: metadata }] })
  const expected = { status: "incompatible", panelVersion: "0.2.0", panelProtocol: 2,
    cookieMonsterVersion: "2.4.1", cookieMonsterVersionStatus: "configured" }
  assert.deepEqual(result.connections[0].compatibility, expected)
  assert.deepEqual(result.compatibility, { ...expected, pendingPanels: [expected] })
  assert.equal(result.events[0].errorCode, "incompatible_version")
  assert.ok(!/SECRET|artist|https|credential|updates/.test(JSON.stringify(result)))
  for (const bad of [secret, {}, "C:/Users/artist/secret", "1.0\\n", "1".repeat(65),
    ...["\n", "\r", "\t", "\0", "\u2028", "\u2029"].map(suffix => "1.0" + suffix)]) {
    const output = d.export({ compatibility: { ...metadata, panelVersion: bad, cookieMonsterVersion: bad, panelProtocol: bad } })
    assert.equal(output.compatibility.panelVersion, null)
    assert.equal(output.compatibility.panelProtocol, null)
    assert.equal(output.compatibility.cookieMonsterVersion, null)
    assert.equal(output.compatibility.cookieMonsterVersionStatus, "not_configured")
  }
})

test("session metadata is bounded, separate, volatile, and removed on release", () => {
  const d = createDiagnostics()
  for (let i = 0; i < 150; i++) d.record("one", "inspect", "ok")
  assert.equal(d.export({ sessionID: "one" }).events.length, 100)
  assert.equal(d.export({ sessionID: "two" }).events.length, 0)
  d.release("one")
  assert.equal(d.export({ sessionID: "one" }).events.length, 0)
  d.record("two", "capture", "failed"); d.clear()
  assert.equal(d.export({ sessionID: "two" }).events.length, 0)
})
