import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || "playwright")
const root = fileURLToPath(new URL("../", import.meta.url))
const browser = await chromium.launch({ headless: true, channel: process.env.CM_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) })
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 500 } })
  await page.route("**/ui.js", route => route.fulfill({ body: "", contentType: "application/javascript" }))
  async function load() {
    await page.goto(pathToFileURL(path.join(root, "panel/index.html")).href)
    await page.evaluate(() => {
      const sessions = JSON.parse(localStorage.getItem("test-conversations") || "null") || Array.from({ length: 12 }, (_, i) => ({
        sessionID: "session-" + i, title: "Motion " + i, directory: "D:\\Brand", updatedAt: 1700000000000 + i, targetCompId: i % 2 ? 7 : 3,
      }))
      let active = sessions[0]
      const state = { connection: "connected", project: { id: "brand", path: "D:\\Brand\\title.aep", saved: true }, activeCompId: 3, compositions: [{ id: 3, name: "Logo" }, { id: 7, name: "Title" }] }
      const client = { state, descriptor: {}, panel: async () => ({}), heartbeat: async () => {} }
      const snapshot = () => ({ sessionID: active.sessionID, title: active.title, targetCompId: active.targetCompId, directory: active.directory, workspaceConfirmed: true, status: "idle", messages: [{ id: active.sessionID, role: "assistant", completed: true, parts: [{ type: "text", text: "History of " + active.title }] }] })
      const api = { requestId: () => "a".repeat(40), request: async (d, c, route, body) => {
        if (body.action === "conversations") {
          const matches = sessions.filter(s => s.title.toLowerCase().includes(body.search.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt)
          return { result: { conversations: matches.slice(body.offset, body.offset + 10), total: matches.length, nextOffset: body.offset + 10 < matches.length ? body.offset + 10 : null } }
        }
        if (body.action === "rename") { sessions.find(s => s.sessionID === body.sessionID).title = body.title; localStorage.setItem("test-conversations", JSON.stringify(sessions)); return { result: {} } }
        if (body.action === "reopen") { active = sessions.find(s => s.sessionID === body.sessionID); return { result: active } }
        if (body.action === "new") { active = { sessionID: "new", title: "New conversation", directory: "D:\\Brand", targetCompId: null }; return { result: active } }
        if (body.action === "models") return { result: { models: [] } }
        if (body.action === "checkpoints") return { result: { checkpoints: [] } }
        const result = snapshot()
        if (body.action === "state" && window.holdOld) { window.holdOld = false; await new Promise(resolve => { window.releaseOld = resolve }) }
        return { result }
      } }
      window.chatTest = window.CookieMonsterChat(client, { state: { credential: "test" }, save() {} }, api)
      window.chatState = state
    })
  }
  await load()
  await page.getByRole("button", { name: "Conversations", exact: true }).click()
  await page.getByText("1–10 of 12", { exact: true }).waitFor()
  await page.evaluate(() => window.chatTest.update({ ...window.chatState, busy: true }))
  assert.equal(await page.getByRole("button", { name: "Open", exact: true }).first().isDisabled(), true)
  assert.equal(await page.getByRole("button", { name: "New chat", exact: true }).isDisabled(), true)
  await page.evaluate(() => window.chatTest.update(window.chatState))
  await page.getByRole("button", { name: "Next", exact: true }).click()
  await page.getByText("11–12 of 12", { exact: true }).waitFor()
  await page.getByLabel("Search conversations").fill("Motion 1")
  await page.getByLabel("Search conversations").press("Enter")
  await page.getByText("1–3 of 3", { exact: true }).waitFor()
  const row = page.locator(".chat-conversation-row").filter({ has: page.getByText("Motion 1", { exact: true }) })
  await row.getByRole("button", { name: "Rename", exact: true }).click()
  await page.getByLabel("Conversation title", { exact: true }).fill("Brand timing")
  await page.getByRole("button", { name: "Save title", exact: true }).click()
  await page.getByText("1–2 of 2", { exact: true }).waitFor()
  await page.getByLabel("Search conversations").fill("Brand timing")
  await page.getByLabel("Search conversations").press("Enter")
  await page.getByText("1–1 of 1", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await page.getByText("History of Brand timing", { exact: true }).waitFor()
  assert.equal(await page.locator("#chat-comp").inputValue(), "7")
  await load()
  await page.getByRole("button", { name: "Conversations", exact: true }).click()
  await page.getByLabel("Search conversations").fill("Brand timing")
  await page.getByLabel("Search conversations").press("Enter")
  await page.getByText("1–1 of 1", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await page.getByText("History of Brand timing", { exact: true }).waitFor()
  // A poll started before switching must not restore the old messages afterwards.
  await page.evaluate(() => { window.holdOld = true })
  await page.waitForFunction(() => typeof window.releaseOld === "function")
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await page.getByText("History of New conversation", { exact: true }).waitFor()
  await page.evaluate(() => window.releaseOld())
  assert.equal(await page.getByText("History of Brand timing", { exact: true }).count(), 0)
  await page.getByRole("button", { name: "Conversations", exact: true }).click()
  await page.getByLabel("Search conversations").fill("absent")
  await page.getByLabel("Search conversations").press("Enter")
  await page.getByText("No conversations found for this project.", { exact: true }).waitFor()
  const dialog = await page.locator("#chat-conversations").boundingBox()
  assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= 500)
  await page.getByRole("button", { name: "Close conversations", exact: true }).focus()
  await page.keyboard.press("Shift+Tab")
  assert.equal(await page.locator("#chat-conversations-search-button").evaluate(el => el === document.activeElement), true)
  await page.keyboard.press("Escape")
  assert.equal(await page.locator("#chat-conversations").isVisible(), false)
  await page.getByRole("button", { name: "Conversations", exact: true }).click()
  await page.getByLabel("Search conversations").fill("")
  await page.getByLabel("Search conversations").press("Enter")
  await page.getByText("1–10 of 12", { exact: true }).waitFor()
  await mkdir(path.join(root, "coverage"), { recursive: true })
  await page.screenshot({ path: path.join(root, "coverage/issue22-conversations.png") })
  await page.evaluate(() => window.chatTest.update({ ...window.chatState, connection: "disconnected" }))
  await page.getByText("Connect to CookieMonster to browse conversations.", { exact: true }).waitFor()
  console.log("Conversation browser passed: search, paging, rename, reload, reopen, fixed target, stale poll, empty/disconnected states and keyboard controls")
} finally { await browser.close() }
