import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const policyValues = new Set(["allow", "ask", "deny"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const AE_PERMISSIONS = Object.freeze({
  ae_pair: "ask",
  ae_connections: "allow",
  ae_bind: "ask",
  ae_release: "ask",
  ae_inspect: "allow",
  ae_execute: "ask",
  ae_grant: "ask",
  ae_capture: "ask",
  ae_checkpoints: "ask",
  ae_restore: "ask",
  ae_templates: "ask",
  ae_render_list: "allow",
  ae_render_recover: "ask",
  ae_render_submit: "ask",
  ae_render_status: "allow",
  ae_render_cancel: "ask",
  ae_render_retire: "ask",
  ae_render_result: "allow",
  ae_diagnostics: "allow",
  ae_reconcile: "ask",
});

function artifactPath(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Expected an absolute path or file URL");
  const path = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (!isAbsolute(path)) throw new Error("Artifact paths must be absolute");
  return path;
}

async function pluginKey(entry) {
  const value = Array.isArray(entry) ? entry[0] : entry;
  try {
    const path = artifactPath(value);
    // Keep unresolved entries; canonicalize only for duplicate detection.
    return pathToFileURL(await realpath(path).catch(() => path)).href;
  } catch {
    return value;
  }
}

/**
 * Validate local artifacts without executing them, then add defaults before user policy.
 * Required-artifact errors are reported; callers must refuse installation on severity "error".
 */
export async function mergeBundledPlugins(config, artifacts) {
  if (!record(config)) throw new TypeError("Config must be an object");
  if (!Array.isArray(artifacts)) throw new TypeError("Artifacts must be an array");
  if (config.plugin !== undefined && (!Array.isArray(config.plugin) || config.plugin.some((entry) =>
    !(typeof entry === "string" || (Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "string" && record(entry[1])))))) {
    throw new TypeError("Config plugin must contain strings or [specifier, options] tuples");
  }
  if (config.permission !== undefined && !record(config.permission) && !policyValues.has(config.permission)) {
    throw new TypeError("Config permission must be a policy object or allow/ask/deny");
  }

  const plugin = [...(config.plugin ?? [])];
  const existing = new Set(await Promise.all(plugin.map(pluginKey)));
  const ids = new Set();
  const defaults = {};
  const diagnostics = [];
  let accepted = false;

  for (const artifact of artifacts) {
    let code = "INVALID_ARTIFACT";
    try {
      if (!record(artifact) || typeof artifact.id !== "string" || !artifact.id.trim() ||
          (artifact.optional !== undefined && typeof artifact.optional !== "boolean") ||
          !record(artifact.permissions) ||
          Object.entries(artifact.permissions).some(([name, value]) =>
            !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || !policyValues.has(value))) {
        throw new Error("Expected {id, path, permissions, optional?} with named tool policies");
      }
      if (ids.has(artifact.id)) throw new Error("Duplicate artifact id");
      const inputPath = artifactPath(artifact.path);
      if (![".mjs", ".cjs", ".js"].includes(extname(inputPath))) throw new Error("Artifact must be JavaScript");
      code = "ARTIFACT_UNAVAILABLE";
      const path = await realpath(inputPath);
      if (!(await stat(path)).isFile()) throw new Error("Artifact is not a regular file");
      code = "ARTIFACT_SYNTAX";
      // Syntax checking never imports the plugin or runs top-level code.
      await exec(process.execPath, ["--check", path], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const url = pathToFileURL(path).href;
      if (!existing.has(url) && !existing.has(pathToFileURL(inputPath).href)) {
        plugin.push(url);
        existing.add(url);
      }
      ids.add(artifact.id);
      for (const [name, value] of Object.entries(artifact.permissions)) {
        if (!Object.hasOwn(defaults, name)) defaults[name] = value;
      }
      accepted = true;
    } catch (error) {
      diagnostics.push({
        id: typeof artifact?.id === "string" ? artifact.id : null,
        severity: artifact?.optional === true ? "warning" : "error",
        code,
        message: code === "ARTIFACT_SYNTAX"
          ? "Artifact failed node --check (syntax error or check timeout); it was not loaded"
          : error.message,
      });
    }
  }

  if (!accepted) return { config, diagnostics };
  const merged = { ...config, plugin };
  if (config.permission === undefined || record(config.permission)) {
    // User rules come last, including wildcard rules; defaults never widen existing policy.
    merged.permission = {
      ...Object.fromEntries(Object.entries(defaults).filter(([name]) => !Object.hasOwn(config.permission ?? {}, name))),
      ...(config.permission ?? {}),
    };
  }
  return { config: merged, diagnostics };
}
