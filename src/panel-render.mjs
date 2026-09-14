import { randomBytes } from "node:crypto"
import { fail } from "./protocol.mjs"

// Keep the existing tool call suspended at its permission boundary. Approval
// continues that exact call rather than replaying discovery or submission.
export function createPanelRender({ execute, now = Date.now }) {
  const tasks = new Map()
  const allowed = new Set(["ae_templates", "ae_grant", "ae_render_submit", "ae_render_recover", "ae_render_status", "ae_render_cancel", "ae_render_result"])
  function owned(sessionID, bindingID, token) {
    const task = tasks.get(sessionID)
    if (!task || task.bindingID !== bindingID || task.token !== token) fail("invalid_token", "Render operation expired or belongs to another binding")
    return task
  }
  function state(task) {
    return { token: task.token, status: task.status, approval: task.approval || null,
      result: task.result ?? null, error: task.error || null }
  }
  return {
    busy(sessionID) { return ["running", "approval"].includes(tasks.get(sessionID)?.status) },
    start(sessionID, bindingID, tool, args, check) {
      if (!allowed.has(tool)) fail("invalid_payload", "Unsupported render operation")
      if (this.busy(sessionID)) fail("panel_busy", "Finish the current render review first")
      const task = { token: randomBytes(24).toString("hex"), bindingID, status: "running" }
      tasks.set(sessionID, task)
      const controller = new AbortController()
      task.cancel = () => { controller.abort(); task.reject?.(Object.assign(new Error("Render review cancelled"), { code: "aborted" })) }
      Promise.resolve().then(() => execute(tool, args, { sessionID, abort: controller.signal,
        ask: async request => {
          check()
          task.status = "approval"
          const id = randomBytes(24).toString("hex")
          task.approval = { id, permission: request.permission, summary: request.patterns.join("\n"), expiresAt: now() + 120000 }
          try {
            await new Promise((resolve, reject) => {
              task.resolve = resolve; task.reject = reject
              task.timer = setTimeout(() => reject(Object.assign(new Error("Render review expired"), { code: "invalid_token" })), 120000)
              task.timer.unref?.()
            })
            check()
          } finally { clearTimeout(task.timer); task.approval = null; task.reject = null; task.resolve = null; task.status = "running" }
        },
      })).then(result => { check(); task.result = JSON.parse(result); task.status = "completed" }, error => {
        task.error = { code: error.code || "render_failed", message: error.message || "Render operation failed" }; task.status = "failed"
      }).catch(error => { task.error = { code: error.code || "stale_binding", message: error.message }; task.status = "failed" })
      return state(task)
    },
    poll(sessionID, bindingID, token) { return state(owned(sessionID, bindingID, token)) },
    reply(sessionID, bindingID, token, approvalID, allow) {
      const task = owned(sessionID, bindingID, token)
      if (!task.approval || task.approval.id !== approvalID || now() >= task.approval.expiresAt || !task.resolve)
        fail("invalid_token", "Render review expired or was already answered")
      const resolve = task.resolve, reject = task.reject
      task.resolve = null
      if (allow) resolve(); else reject(Object.assign(new Error("Render operation denied"), { code: "permission_denied" }))
      return { answered: true }
    },
    release(sessionID) { tasks.get(sessionID)?.cancel?.(); tasks.delete(sessionID) },
  }
}
