import { createHash } from "node:crypto"

export const VERSION = "0.2.3"
export const PROTOCOL = 1
export const UPDATE_URL = "https://github.com/trmosala/CookieJar/releases"
export const PROPOSAL_TTL = 5 * 60 * 1000

export const validVersion = value => typeof value === "string" && value.length <= 64 &&
  /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value)
export const validProtocol = value => Number.isSafeInteger(value) && value >= 1

// Only the embedding runtime supplies release metadata, never a panel or tool argument.
export function releaseMetadata(value = {}) {
  assertObject(value)
  if (Object.keys(value).some(key => !["cookieMonsterVersion", "updates"].includes(key)) ||
      value.cookieMonsterVersion !== undefined && value.cookieMonsterVersion !== null && !validVersion(value.cookieMonsterVersion))
    fail("invalid_payload", "Invalid runtime release metadata")
  const supplied = value.updates === undefined ? {} : assertObject(value.updates)
  if (Object.keys(supplied).some(key => !["plugin", "panel", "cookieMonster"].includes(key)))
    fail("invalid_payload", "Unknown update component")
  const updates = {}
  for (const component of ["plugin", "panel", "cookieMonster"]) {
    const entry = supplied[component]
    if (entry === undefined || entry === null) {
      updates[component] = { status: "not_configured", version: null, protocol: null, url: null }
      continue
    }
    assertObject(entry)
    if (Object.keys(entry).sort().join(",") !== "protocol,url,version" ||
        !validVersion(entry.version) || entry.protocol !== PROTOCOL ||
        component !== "cookieMonster" && entry.version !== VERSION)
      fail("invalid_payload", "Update must target a release compatible with this bridge")
    let url
    try { url = new URL(entry.url) } catch { fail("invalid_payload", "Invalid runtime update URL") }
    if (typeof entry.url !== "string" || entry.url.length > 2048 ||
        !/^https:\/\/[A-Za-z0-9.:[\]-]+(?:\/[A-Za-z0-9._~/-]*)?$/.test(entry.url) ||
        url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash)
      fail("invalid_payload", "Update URL must be HTTPS without credentials, query, fragment or encoded content")
    updates[component] = { status: "configured", version: entry.version, protocol: entry.protocol, url: url.href }
  }
  return {
    cookieMonsterVersion: value.cookieMonsterVersion ?? null,
    cookieMonsterVersionStatus: value.cookieMonsterVersion == null ? "not_configured" : "configured",
    releaseSourceUrl: UPDATE_URL, updates,
  }
}

export class AEError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "AEError"
    this.code = code
    this.details = details
  }
}

export function fail(code, message, details) {
  throw new AEError(code, message, details)
}

export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
  }
  fail("invalid_payload", "Payload must contain only finite JSON values")
}

export function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

export function assertObject(value, name = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_payload", name + " must be an object")
  return value
}

export function assertString(value, name, max = 4096) {
  if (typeof value !== "string" || !value.length || value.length > max) fail("invalid_payload", name + " must be a nonempty bounded string")
  return value
}
