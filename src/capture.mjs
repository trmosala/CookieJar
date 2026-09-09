import { z } from "zod"
import { fail } from "./protocol.mjs"

export const captureArgs = {
  compId: z.number().int().positive(),
  time: z.number().finite().nonnegative(),
  alpha: z.boolean().default(true),
}
const MAX = 5 * 1024 * 1024
// Only errors known to precede temporary queue mutation can release a failed call.
export const safeRefusals = new Set(["unsafe_state", "preference_disabled", "capability_missing",
  "unsaved_project", "invalid_payload", "invalid_method", "unsupported_method", "missing_item", "wrong_item_type"])

export function imageAttachment(result, alpha = true) {
  const parsed = z.object({
    mime: z.enum(["image/png", "image/jpeg"]), data: z.string().min(4).max(4 * Math.ceil(MAX / 3)),
    width: z.number().int().min(1).max(2000), height: z.number().int().min(1).max(2000),
  }).strict().safeParse(result)
  if (!parsed.success) fail("invalid_capture", "Expected bounded PNG/JPEG bytes and dimensions, not a file path")
  const { mime, data, width, height } = parsed.data
  const bytes = Buffer.from(data, "base64")
  if (bytes.length > MAX || bytes.toString("base64") !== data)
    fail("invalid_capture", "Image must be canonical base64 within 5 MiB")
  let w, h
  if (mime === "image/png") {
    if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
      fail("invalid_capture", "Invalid PNG header")
    w = bytes.readUInt32BE(16); h = bytes.readUInt32BE(20)
    if (![0, 2, 3, 4, 6].includes(bytes[25]) || ![1, 2, 4, 8, 16].includes(bytes[24]) ||
        bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1)
      fail("invalid_capture", "Unsupported PNG header")
    let offset = 8, image = false, end = false, transparency = [4, 6].includes(bytes[25])
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8)
      if (size > bytes.length - offset - 12) fail("invalid_capture", "Truncated PNG chunk")
      if (type === "IHDR" && offset !== 8) fail("invalid_capture", "Repeated PNG header")
      if (type === "tRNS") transparency = true
      if (type === "IDAT" && size) image = true
      offset += size + 12
      if (type === "IEND") { end = size === 0 && offset === bytes.length; break }
    }
    if (!image || !end || alpha && !transparency) fail("invalid_capture", "Incomplete PNG or missing requested alpha")
  } else {
    if (alpha) fail("invalid_capture", "Alpha capture requires PNG")
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
      fail("invalid_capture", "Invalid JPEG signature")
    let offset = 2, scan = false
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 0xff) fail("invalid_capture", "Invalid JPEG marker")
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0 || marker === 0xd8 || marker === 0xd9) fail("invalid_capture", "Unexpected JPEG marker")
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (offset + 2 > bytes.length) fail("invalid_capture", "Truncated JPEG segment")
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length - 2) fail("invalid_capture", "Truncated JPEG segment")
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (w !== undefined || length < 8 || bytes[offset + 2] !== 8 ||
            length !== 8 + 3 * bytes[offset + 7]) fail("invalid_capture", "Invalid JPEG frame header")
        h = bytes.readUInt16BE(offset + 3); w = bytes.readUInt16BE(offset + 5)
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        fail("invalid_capture", "Unsupported JPEG frame")
      offset += length
      if (marker === 0xda) { scan = true; break }
    }
    if (!scan || w === undefined) fail("invalid_capture", "JPEG frame or scan missing")
  }
  if (!w || !h || w > 2000 || h > 2000 || w !== width || h !== height)
    fail("invalid_capture", "Image header dimensions disagree with bounds or metadata")
  return { type: "file", mime, url: `data:${mime};base64,${data}`, filename: mime === "image/png" ? "ae-frame.png" : "ae-frame.jpg" }
}

export async function capture({ bridge, workflow }, sessionID, input, ask, check = () => {}) {
  const params = z.object(captureArgs).strict().parse(input)
  check()
  const b = bridge.binding(sessionID, { write: true })
  const current = () => {
    check()
    const active = bridge.binding(sessionID, { write: true, allowLocked: true })
    if (active.id !== b.id || active.connectionId !== b.connectionId ||
        active.project.id !== b.project.id || active.project.path !== b.project.path)
      fail("stale_binding", "Capture binding changed")
  }
  const initial = await workflow.inspect(sessionID)
  current()
  const comp = initial.items.find(item => item.id === params.compId && item.kind === "comp")
  if (!comp || !Number.isFinite(comp.duration) || !Number.isFinite(comp.frameRate) || comp.frameRate <= 0 ||
      params.time > comp.duration - 1 / comp.frameRate + 1e-7)
    fail("invalid_payload", "Choose an inspected composition and a time containing a complete frame")
  if (!initial.capabilities.fileNetwork) fail("capability_missing", "Capture requires file/network scripting permission")
  if (typeof ask !== "function") fail("permission_required", "Explicit capture approval is required")
  if (await ask(`Capture composition ${comp.name} (ID ${comp.id}) at ${params.time}s; alpha ${params.alpha}. Temporarily renders one frame.`, { ...params, binding: b }) === false)
    fail("permission_denied", "Capture denied")
  current()
  if ((await workflow.inspect(sessionID)).fingerprint !== initial.fingerprint) fail("stale_fingerprint", "Composition changed during capture approval")
  current()
  await bridge.lock(sessionID, { kind: "capture" })
  let dispatched = false
  try {
    current()
    if ((await workflow.inspect(sessionID)).fingerprint !== initial.fingerprint) fail("stale_fingerprint", "Composition changed before capture")
    current()
    dispatched = true
    const result = await bridge.call(sessionID, "capture", params, { allowLocked: true })
    current()
    const attachment = imageAttachment(result, params.alpha)
    await bridge.unlock(sessionID)
    return { output: JSON.stringify({ compId: params.compId, time: params.time, width: result.width, height: result.height }),
      attachments: [attachment] }
  } catch (error) {
    if (!dispatched && error.code === "stale_fingerprint" || dispatched && safeRefusals.has(error.code)) {
      current()
      await bridge.unlock(sessionID)
    }
    throw error
  }
}
