import vm from "node:vm"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { RESTORE_PROOF } from "../src/bridge.mjs"

// Proposed parent bridge contract, not production bridge/transport qualification.
export function manualRestoreBridge(dataDir, host) {
  const state = { id: "manual-binding", connectionId: "manual-connection",
    project: host.call("inspect").result.project, lock: null }
  const events = []
  const fail = code => { throw Object.assign(new Error(code), { code }) }
  return {
    canonicalRestore: true, compactRestore: RESTORE_PROOF, dataDir, state, events, onRelease() {},
    binding(sessionID, { allowLocked = false } = {}) {
      if (sessionID !== "session") fail("not_bound")
      if (state.lock && !allowLocked) fail("target_locked")
      return structuredClone(state)
    },
    async lock(sessionID, reason) {
      this.binding(sessionID)
      state.lock = { id: "manual-lock", state: "executing", reason, project: structuredClone(state.project) }
    },
    async unlock() {
      if (state.lock?.recoveryOriginal) fail("recovery_target_mismatch")
      state.lock = null
    },
    async markUncertain() { if (state.lock) state.lock.state = "uncertain" },
    async recordOutcome(sessionID, evidence) {
      this.binding(sessionID, { allowLocked: true })
      if (state.lock?.state !== "executing") fail("lock_required")
      state.lock.evidence = structuredClone(evidence)
    },
    async call(sessionID, method, params = {}) {
      this.binding(sessionID, { allowLocked: true })
      events.push({ method, params: structuredClone(params) })
      if (method === "execute") {
        if (state.lock?.state !== "executing") fail("lock_required")
        if (params.transaction.sessionID !== sessionID || params.transaction.bindingID !== state.id) fail("stale_binding")
      }
      const reply = host.call(method, params)
      if (reply.error) {
        if (reply.error.code === "uncertain_outcome") state.lock.state = "uncertain"
        throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
      }
      if (params.phase === "restore_prepare") state.lock.recoveryOriginal = structuredClone(state.project)
      if (params.phase === "restore_prepare" || params.phase === "restore_finish") {
        state.project = structuredClone(reply.result.project)
        state.lock.project = structuredClone(state.project)
        if (state.lock.recoveryOriginal.path === state.project.path) delete state.lock.recoveryOriginal
      }
      return reply.result
    },
  }
}

// Real host source, fake AE objects. This is not live-AE qualification.
export function hostDouble(projectPath) {
  const PT = { PROPERTY: 1, INDEXED_GROUP: 2 }
  const VT = { OneD: 1, TwoD: 2, NO_VALUE: 3, CUSTOM_VALUE: 4, MARKER: 5, TEXT_DOCUMENT: 6, SHAPE: 7 }
  const changed = () => { project.revision++; project.dirty = true }
  class Property {
    constructor(name, value, type) {
      Object.assign(this, { name, matchName: name, value, propertyType: PT.PROPERTY, propertyValueType: type,
        canSetExpression: true, canVaryOverTime: true, expressionEnabled: false, expressionError: "",
        _expression: "", keys: [], hasMin: false, hasMax: false, isSpatial: false, isSeparationLeader: false })
    }
    get expression() { return this._expression }
    set expression(value) { this._expression = value; this.expressionEnabled = !!value; this.expressionError = value === "bad(" ? "Syntax error" : ""; changed() }
    get numKeys() { return this.keys.length }
    setValue(value) { this.value = value; changed() }
    valueAtTime() { return this.value }
    setValueAtTime(time, value) {
      const old = this.keys.find(k => k.time === time)
      if (old) old.value = value
      else this.keys.push({ time, value })
      this.keys.sort((a, b) => a.time - b.time)
      changed()
    }
    keyTime(k) { return this.keys[k - 1].time }
    keyValue(k) { return this.keys[k - 1].value }
    keyInInterpolationType(k) { return this.keys[k - 1].interpolation?.[0] || 1 }
    keyOutInterpolationType(k) { return this.keys[k - 1].interpolation?.[1] || 1 }
    keyInTemporalEase(k) { return this.keys[k - 1].inEase || [{ speed: 0, influence: 33 }] }
    keyOutTemporalEase(k) { return this.keys[k - 1].outEase || [{ speed: 0, influence: 33 }] }
    keyTemporalContinuous() { return false }
    keyTemporalAutoBezier() { return false }
    keyLabel() { return 0 }
    isInterpolationTypeValid() { return true }
    setInterpolationTypeAtKey(k, a, b) { this.keys[k - 1].interpolation = [a, b]; changed() }
    setTemporalEaseAtKey(k, a, b) { this.keys[k - 1].inEase = JSON.parse(JSON.stringify(a)); this.keys[k - 1].outEase = JSON.parse(JSON.stringify(b)); changed() }
  }
  class Group {
    constructor(name, children) {
      Object.assign(this, { name, matchName: name, propertyType: PT.INDEXED_GROUP, children })
      children.forEach(p => { p.parentProperty = this })
    }
    get numProperties() { return this.children.length }
    property(key) { return typeof key === "number" ? this.children[key - 1] : this.children.find(p => p.matchName === key) }
  }
  class CompItem {}
  class FolderItem {}
  class TextLayer {}
  class CameraLayer {}
  class LightLayer {}
  class File {
    constructor(name) { this.fsName = name; this.alias = false }
    get exists() { return existsSync(this.fsName) }
  }
  const props = [new Property("ADBE Opacity", 100, VT.OneD), new Property("ADBE Position", [0, 0], VT.TwoD)]
  const transform = new Group("ADBE Transform Group", props.slice())
  const effects = new Group("ADBE Effect Parade", [])
  const layer = { id: 2, name: "Layer", matchName: "ADBE AV Layer", enabled: true, locked: false, shy: false,
    solo: false, startTime: 0, inPoint: 0, outPoint: 5, stretch: 100, parent: null, source: null, selected: false,
    threeDLayer: false, numProperties: 1,
    property: key => key === 1 || key === effects.matchName ? effects : key === transform.matchName ? transform : null }
  const comp = Object.assign(new CompItem(), { id: 1, name: "Comp", width: 640, height: 480, pixelAspect: 1,
    duration: 5, frameRate: 25, time: 0, bgColor: [0, 0, 0], parentFolder: null, selected: false,
    numLayers: 1, layer: () => layer })
  let project = { file: new File(projectPath), numItems: 1, item: () => comp, activeItem: comp,
    revision: 1, dirty: false, renderQueue: { rendering: false },
    save(file) {
      writeFileSync(file.fsName, JSON.stringify({ revision: this.revision,
        comp: { name: comp.name, time: comp.time, bgColor: comp.bgColor },
        props: props.map(p => ({ value: p.value, keys: p.keys, expression: p.expression, enabled: p.expressionEnabled })) }))
      this.file = file
      this.dirty = false
    },
    close(option) {
      if (option !== 1) throw new Error("Expected documented CloseOptions.DO_NOT_SAVE_CHANGES")
      closes++; invalid.add(this); app.project = null; return true
    } }
  let begins = 0, ends = 0, closes = 0
  const invalid = new WeakSet()
  const app = { project, onError: null, version: "26.0", effects: [], preferences: { getPrefAsLong: () => 1 },
    beginUndoGroup() { begins++ }, endUndoGroup() { ends++ },
    open(file) {
      invalid.add(project)
      project = { ...project }
      const data = JSON.parse(readFileSync(file.fsName, "utf8"))
      Object.assign(comp, data.comp)
      data.props.forEach((p, i) => Object.assign(props[i], { value: p.value, keys: p.keys,
        _expression: p.expression, expressionEnabled: p.enabled, expressionError: "" }))
      project.file = file; project.revision = data.revision; project.dirty = false
      app.project = project
      return project
    } }
  const context = vm.createContext({ app, File, CompItem, FolderItem, TextLayer, CameraLayer, LightLayer,
    CloseOptions: { DO_NOT_SAVE_CHANGES: 1 },
    PropertyType: PT, PropertyValueType: VT, KeyframeInterpolationType: { LINEAR: 1, BEZIER: 2, HOLD: 3 },
    KeyframeEase: function(speed, influence) { this.speed = speed; this.influence = influence } })
  context.isValid = value => value != null && !invalid.has(value)
  vm.runInContext(readFileSync(new URL("../panel/host.jsx", import.meta.url), "utf8"), context)
  const call = (method, params = {}) => JSON.parse(context.CookieMonsterAE.dispatch(JSON.stringify({ method, params })))
  project.save(project.file)
  return { call, context, get project() { return project }, props, transform, app, get closes() { return closes }, get begins() { return begins }, get ends() { return ends },
    largeScene() {
      const layers = Array.from({ length: 96 }, (_, index) => {
        const children = Array.from({ length: 300 }, (_, n) => {
          const p = new Property("Animated Control " + n, n, VT.OneD)
          p._expression = "// " + "retained expression body ".repeat(8) + "\nvalue"
          p.expressionEnabled = true
          p.keys = [{ time: 0, value: n }, { time: 2, value: n + 10 }]
          props.push(p)
          return p
        })
        const group = new Group("ADBE Transform Group", children)
        return { ...layer, id: 10 + index, name: "Layer " + index,
          property: key => key === 1 || key === effects.matchName ? effects : key === group.matchName ? group : null }
      })
      comp.numLayers = layers.length
      comp.layer = index => layers[index - 1]
      changed()
      return comp
    },
    actions() {
      const locators = call("inspect").result.items[0].layers[0].properties.find(p => p.matchName === transform.matchName).properties.map(p => p.locator)
      return [
        { type: "keyframe.set", locator: locators[0], time: 0, value: 0 },
        { type: "keyframe.set", locator: locators[1], time: 0, value: [0, 0] },
        { type: "keyframe.set", locator: locators[0], time: 2, value: 100 },
        { type: "keyframe.set", locator: locators[1], time: 2, value: [200, 100] },
        { type: "keyframe.interpolation", locator: locators[0], time: 2, inType: "bezier", outType: "bezier",
          inEase: [{ speed: 5, influence: 60 }], outEase: [{ speed: 0, influence: 40 }] },
        { type: "expression.set", locator: locators[1], source: "value + [10, 20]", enabled: true },
      ]
    } }
}
