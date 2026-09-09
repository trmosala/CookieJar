import { createHash } from "node:crypto"

export const VERSION = "0.1.0"
export const PROTOCOL = 1
export const UPDATE_URL = "https://github.com/trmosala/CookieJar/releases"
export const PROPOSAL_TTL = 5 * 60 * 1000

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
