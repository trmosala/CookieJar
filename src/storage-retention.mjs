import { fail } from "./protocol.mjs"

export const MAX_BYTES = 5 * 1024 ** 3

export function retention(entries, incoming) {
  let unpinned = entries.filter(entry => !entry.pinned).length + (incoming && !incoming.pinned ? 1 : 0)
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0) + (incoming?.size || 0)
  const victims = []
  for (const entry of [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (unpinned <= 10 && bytes <= MAX_BYTES) break
    if (entry.pinned || entry.inUse) continue
    victims.push(entry)
    unpinned--
    bytes -= entry.size
  }
  if (unpinned > 10 || bytes > MAX_BYTES) fail("checkpoint_capacity", "Pinned or in-use checkpoints prevent retention; free space explicitly")
  return victims
}
