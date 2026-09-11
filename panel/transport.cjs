"use strict";
var fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), crypto = require("crypto"), child = require("child_process");
var VERSION = "0.2.2", PROTOCOL = 1, MAX = 4 * 1024 * 1024;
function error(code, message) { var e = new Error(message); e.code = code; return e; }
function record(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function text(v, max) { return typeof v === "string" && v.length > 0 && v.length <= max; }
function validVersion(value) {
    return text(value,64) && !/\s/.test(value) && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value);
}
function compatibilityMetadata(value) {
    function invalid() { throw error("invalid_response","Invalid compatibility metadata"); }
    function protocol(v) { return Number.isSafeInteger(v) && v>=1; }
    function https(v) {
        if(!text(v,2048) || /[\s\\]/.test(v) || !/^https:\/\/[A-Za-z0-9.:[\]-]+(?:\/[A-Za-z0-9._~/-]*)?$/.test(v))invalid();
        var u;try { u=new (require("url").URL)(v); } catch(e) { invalid(); }
        if(u.protocol!=="https:" || !u.hostname || u.username || u.password || u.search || u.hash)invalid();
        return u.href;
    }
    if(!record(value) || Object.keys(value).sort().join(",")!=="cookieMonsterVersion,cookieMonsterVersionStatus,panelProtocol,panelVersion,pluginVersion,protocol,releaseSourceUrl,status,updates" ||
        !validVersion(value.pluginVersion) || !protocol(value.protocol) ||
        !(value.panelVersion === null && value.panelProtocol === null || validVersion(value.panelVersion) && protocol(value.panelProtocol)) ||
        !(value.cookieMonsterVersionStatus==="not_configured" && value.cookieMonsterVersion === null ||
          value.cookieMonsterVersionStatus==="configured" && validVersion(value.cookieMonsterVersion)) ||
        value.releaseSourceUrl!=="https://github.com/trmosala/CookieJar/releases" ||
        !record(value.updates) || Object.keys(value.updates).sort().join(",")!=="cookieMonster,panel,plugin")invalid();
    var expected=value.panelVersion === null ? "unknown" : value.panelVersion===value.pluginVersion && value.panelProtocol===value.protocol ? "compatible" : "incompatible";
    if(value.status!==expected)invalid();
    var updates={};
    ["plugin","panel","cookieMonster"].forEach(function(key){
        var u=value.updates[key];
        if(!record(u) || Object.keys(u).sort().join(",")!=="protocol,status,url,version")invalid();
        if(u.status==="not_configured"){
            if(u.version !== null || u.protocol !== null || u.url !== null)invalid();
            updates[key]={status:"not_configured",version:null,protocol:null,url:null};
        } else {
            if(u.status!=="configured" || !validVersion(u.version) || u.protocol!==value.protocol ||
                key!=="cookieMonster" && u.version!==value.pluginVersion)invalid();
            updates[key]={status:"configured",version:u.version,protocol:u.protocol,url:https(u.url)};
        }
    });
    return {status:value.status,pluginVersion:value.pluginVersion,protocol:value.protocol,panelVersion:value.panelVersion,panelProtocol:value.panelProtocol,
        cookieMonsterVersion:value.cookieMonsterVersion,cookieMonsterVersionStatus:value.cookieMonsterVersionStatus,releaseSourceUrl:value.releaseSourceUrl,updates:updates};
}
function secure(target, directory) {
    var stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw error("unsafe_storage", "Storage must not be a link");
    if (process.platform === "win32") {
        var encodedPath = Buffer.from(target, "utf8").toString("base64");
        var script = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedPath + "'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl." + (directory ? "DirectorySecurity" : "FileSecurity") + ";$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','" + (directory ? "ContainerInherit,ObjectInherit" : "None") + "','None','Allow');$acl.AddAccessRule($rule);[System.IO." + (directory ? "Directory" : "File") + "]::SetAccessControl($p,$acl)";
        child.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {windowsHide:true, timeout:15000, stdio:"pipe"});
    } else {
        if (stat.uid !== process.getuid()) throw error("unsafe_storage", "Storage belongs to another user");
        fs.chmodSync(target, directory ? 448 : 384);
    }
}
function readJSON(file, max) {
    var stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw error("unsafe_storage", "Invalid or oversized local file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
}
function privateDir(dir) {
    var created = false;
    try { fs.mkdirSync(dir, {mode:448}); created = true; } catch (e) { if (e.code !== "EEXIST") throw e; }
    secure(dir, true);
    return created;
}
function panelState(file) {
    secure(file, false);
    var state = readJSON(file, 8192);
    if (!record(state) || !text(state.panelId,128) || !(state.credential === null || (typeof state.credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(state.credential))) || typeof state.uncertain !== "boolean") throw error("unsafe_storage", "Invalid panel state; preserve it for recovery");
    return state;
}
function processStamp(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw error("ownership_unknown","Invalid owner PID");
    try {
        process.kill(pid, 0);
        var stamp;
        if (process.platform === "win32") {
            var script = "$ErrorActionPreference='Stop';(Get-Process -Id " + pid + ").StartTime.ToUniversalTime().Ticks.ToString()";
            stamp = child.execFileSync("powershell.exe", ["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")], {windowsHide:true,timeout:15000,stdio:"pipe"}).toString().trim();
            if (!/^[0-9]{15,20}$/.test(stamp)) throw new Error("Missing process start time");
        } else if (process.platform === "linux") {
            var stat = fs.readFileSync("/proc/" + pid + "/stat","utf8");
            stamp = fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
            if (!/^[a-f0-9-]+:[0-9]+$/.test(stamp)) throw new Error("Missing process start time");
        } else if (process.platform === "darwin") {
            // ps has second resolution: a same-second PID reuse stays blocked, never stolen.
            stamp = child.execFileSync("/bin/ps",["-p",String(pid),"-o","lstart="],{timeout:5000,env:{LC_ALL:"C",TZ:"UTC",PATH:"/usr/bin:/bin"},stdio:"pipe"}).toString().trim();
            if (!/^[A-Za-z]{3} [A-Za-z]{3} +[0-9]{1,2} [0-9:]{8} [0-9]{4}$/.test(stamp)) throw new Error("Missing process start time");
        } else throw new Error("Unsupported process identity runtime");
        return crypto.createHash("sha256").update(stamp).digest("hex");
    } catch (e) {
        try { process.kill(pid,0); } catch (gone) { if (gone.code === "ESRCH") return null; }
        throw error("ownership_unknown","Cannot verify panel owner lifetime; close AE and retry without deleting recovery state");
    }
}
function Store(dataDir, profile) {
    if (typeof profile !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw error("profile_required","Choose a profile: 1-64 lowercase letters, digits, underscores or hyphens. Reuse that exact name after restarting AE.");
    this.profile = profile;
    this.root = path.resolve(dataDir || process.env.CM_AE_DATA_DIR || path.join(os.homedir(), ".cookiemonster-ae"));
    // The bridge owns the shared directory. Do not create or change permissions on it.
    var rootStat = fs.lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error("unsafe_storage","Start the bridge with a real data directory first");
    var base = path.join(this.root,"panel-private"), legacy = path.join(base,"credential.json");
    privateDir(base);
    if (profile === "legacy") {
        try { panelState(legacy); }
        catch (e) {
            if (e.code === "ENOENT") throw error("legacy_missing","No legacy state file exists. If previously paired, recover it; otherwise choose a named profile.");
            throw e;
        }
    }
    if (profile !== "legacy") {
        try {
            if (panelState(legacy).uncertain) throw error("legacy_uncertain","Select legacy and reconcile its unscoped uncertain outcome before opening another profile");
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
            if (fs.existsSync(path.join(base,"owner.json")) || fs.existsSync(path.join(base,"owners"))) throw error("profile_state_missing","Legacy ownership exists without its state; recover the original file before selecting another profile");
        }
    }
    // ponytail: explicit legacy selection keeps the original file and latch in place, no copying/adoption.
    this.dir = profile === "legacy" ? base : path.join(base,"profile-" + profile);
    var created = profile !== "legacy" && privateDir(this.dir);
    this.file = path.join(this.dir,"credential.json");
    var owners = path.join(this.dir,"owners"), stamp = processStamp(process.pid), self = this;
    if (!stamp) throw error("ownership_unknown","Cannot verify this panel process");
    privateDir(owners);
    this.lock = path.join(owners,process.pid + "-" + stamp + "-" + crypto.randomBytes(24).toString("hex") + ".lock");
    fs.closeSync(fs.openSync(this.lock,"wx",384));
    try {
        // Publish BEFORE scanning. Concurrent claimants see each other and may both refuse;
        // no claimant removes a live claim. Unique filenames avoid stale-unlink/ABA races.
        fs.readdirSync(owners).forEach(function(name) {
            var file = path.join(owners,name);
            if (file === self.lock) return;
            var match = /^([1-9][0-9]*)-([a-f0-9]{64})-([a-f0-9]{48})\.lock$/.exec(name);
            if (!match) throw error("ownership_unknown","Unrecognized owner record; preserve it for recovery");
            var current = processStamp(Number(match[1]));
            if (current === match[2]) throw error("panel_in_use","This profile is already open. Choose a different profile for another AE instance.");
            // Only a proven dead/reused process can be reaped; never guess from elapsed time.
            try { fs.unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
        });
        if (profile === "legacy") {
            this.legacyLock = path.join(base,"owner.json");
            try {
                var old = readJSON(this.legacyLock,4096);
                if (!record(old) || !Number.isSafeInteger(old.pid) || old.pid < 1 || old.pid > 2147483647) throw error("ownership_unknown","Invalid legacy owner; preserve it for recovery");
                // Old records lack a birth stamp: even a reused live PID must remain blocked.
                try { process.kill(old.pid,0); throw error("panel_in_use","Close the legacy panel/AE process before using its pairing"); }
                catch (e) { if (e.code !== "ESRCH") throw e; }
                fs.unlinkSync(this.legacyLock);
            } catch (e) { if (e.code !== "ENOENT") throw e; }
            this.legacyToken = crypto.randomBytes(24).toString("hex");
            fs.writeFileSync(this.legacyLock,JSON.stringify({pid:process.pid,token:this.legacyToken}),{flag:"wx",mode:384});
        }
        try { this.state = panelState(this.file); }
        catch (e) {
            if (e.code !== "ENOENT") throw e;
            if (profile === "legacy") throw error("legacy_missing","No legacy pairing exists. Choose a named profile instead.");
            if (!created) throw error("profile_state_missing","Existing profile has no state file; preserve its files and recover the original state instead of creating a new identity");
            this.state = {panelId:crypto.randomBytes(24).toString("hex"),credential:null,uncertain:false};
            this.panelId = this.state.panelId;
            this.save();
        }
        this.panelId = this.state.panelId;
    } catch (e) { this.close(); throw e; }
}
Store.prototype.save = function () {
    if (!this.lock || !fs.existsSync(this.lock)) throw error("ownership_lost","This panel no longer owns its profile");
    if (this.state.panelId !== this.panelId || typeof this.state.uncertain !== "boolean" || !(this.state.credential === null || (typeof this.state.credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(this.state.credential)))) throw error("unsafe_storage","Refusing to overwrite panel identity or invalid state");
    var tmp = path.join(this.dir, "state-" + crypto.randomBytes(12).toString("hex") + ".tmp"), fd;
    try {
        fd = fs.openSync(tmp, "wx", 384);
        fs.writeFileSync(fd, JSON.stringify(this.state), "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, this.file);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
};
Store.prototype.descriptor = function () {
    var d = readJSON(path.join(this.root, "descriptor.json"), 8192);
    if (!record(d) || Object.keys(d).sort().join(",") !== "instanceId,port,protocol,updateUrl,version" || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || !text(d.instanceId,256) || !text(d.version,128) || !text(d.updateUrl,2048)) throw error("invalid_descriptor", "Invalid loopback descriptor");
    return d;
};
Store.prototype.automaticCode = function (descriptor) {
    var value=readJSON(path.join(this.root,"automatic-connection.json"),8192);
    if(!record(value) || value.instanceId!==descriptor.instanceId || !/^[A-Za-z0-9_-]{43}$/.test(value.code))
        throw error("invalid_descriptor","Waiting for matching CookieMonster connection metadata");
    return value.code;
};
function automaticStore(dataDir) {
    var root=path.resolve(dataDir || process.env.CM_AE_DATA_DIR || path.join(os.homedir(),".cookiemonster-ae"));
    var base=path.join(root,"panel-private"),names=[];
    if(fs.existsSync(base)) {
        var stat=fs.lstatSync(base);
        if(!stat.isDirectory() || stat.isSymbolicLink())throw error("unsafe_storage","Invalid panel storage");
        names=fs.readdirSync(base).filter(function(n){return /^profile-/.test(n);}).map(function(n){return n.slice(8);}).sort();
        if(fs.existsSync(path.join(base,"credential.json")))names.unshift("legacy");
    }
    // Recover an interrupted identity first, otherwise resume the most recently used one.
    var latched={},recent={};
    names.forEach(function(name){
        var file=path.join(name==="legacy" ? base : path.join(base,"profile-"+name),"credential.json");
        try { latched[name]=panelState(file).uncertain ? 1 : 0;recent[name]=fs.statSync(file).mtimeMs; }
        catch(e) { if(e.code!=="ENOENT")throw e;latched[name]=0;recent[name]=0; }
    });
    names.sort(function(a,b){return latched[b]-latched[a] || recent[b]-recent[a] || (a<b ? -1 : a>b ? 1 : 0);});
    // Keep existing identities and latches. A live owner is the only reason to try another slot.
    for(var i=0;i<names.length;i++) {
        try { var store=new Store(root,names[i]);try { store.save();return store; }catch(e){store.close();throw e;} }
        catch(e) { if(e.code!=="panel_in_use")throw e; }
    }
    var slot=1;while(names.indexOf("automatic-"+slot)>=0)slot++;
    return new Store(root,"automatic-"+slot);
}
Store.prototype.close = function () {
    if (this.legacyLock && this.legacyToken) {
        try {
            if (readJSON(this.legacyLock,4096).token === this.legacyToken) fs.unlinkSync(this.legacyLock);
        } catch (e) { if (e.code !== "ENOENT") throw e; }
        this.legacyToken = null;
    }
    if (this.lock) {
        try { fs.unlinkSync(this.lock); } catch (e) { if (e.code !== "ENOENT") throw e; }
        this.lock = null;
    }
};
function request(descriptor, credential, endpoint, body, timeout) {
    return new Promise(function (resolve, reject) {
        var data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8"), finished = false, timer;
        if (data && data.length > MAX) { reject(error("payload_too_large", "Reply exceeds bridge JSON limit")); return; }
        var headers = {"Content-Type":"application/json"};
        if (credential) headers.Authorization = "Bearer " + credential;
        if (data) headers["Content-Length"] = data.length;
        function done(err, result) { if (finished) return; finished = true; clearTimeout(timer); if (err) reject(err); else resolve(result); }
        var req = http.request({hostname:"127.0.0.1", port:descriptor.port, path:endpoint, method:endpoint === "/poll" ? "GET" : "POST", headers:headers, agent:false}, function (res) {
            var chunks = [], size = 0;
            res.on("data", function (chunk) { size += chunk.length; if (size > (endpoint==="/chat" ? 8*1024*1024 : MAX)) { req.destroy(); done(error("invalid_response", "Oversized bridge response")); } else chunks.push(chunk); });
            res.on("error", function () { done(error("disconnected", "Bridge response interrupted")); });
            res.on("end", function () {
                try {
                    if (!/^application\/json(?:;|$)/i.test(res.headers["content-type"] || "")) throw error("invalid_response", "Expected JSON from bridge");
                    var value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (!record(value)) throw error("invalid_response", "Expected response object");
                    if (res.statusCode !== 200 || value.error) {
                        var code = value.error && value.error.code;
                        var rejected=error(typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "bridge_error", endpoint==="/chat" && typeof value.error.message==="string" ? value.error.message.slice(0,8192) : "Bridge rejected request");
                        if(["/pair","/connect","/compatibility"].indexOf(endpoint)>=0 && ["incompatible","incompatible_version"].indexOf(code)>=0 &&
                            record(value.error.details) && Object.prototype.hasOwnProperty.call(value.error.details,"compatibility"))
                            rejected.details={compatibility:compatibilityMetadata(value.error.details.compatibility)};
                        throw rejected;
                    }
                    done(null, value);
                } catch (e) { done(e.code ? e : error("invalid_response", "Malformed bridge JSON")); }
            });
        });
        req.on("error", function () { done(error("disconnected", "Loopback bridge unavailable")); });
        timer = setTimeout(function () { req.destroy(); done(error("disconnected", "Loopback request timed out")); }, timeout || 5000);
        if (data) req.write(data); req.end();
    });
}
function HostRPC(cep, timeout, onLate, restoreTimeout) { this.cep = cep; this.timeout = timeout || 25000; this.restoreTimeout = restoreTimeout || this.timeout; this.pending = false; this.uncertain = false; this.onLate = onLate || function () {}; }
HostRPC.prototype.call = function (method, params, expectedProject) {
    var self = this;
    if (self.pending || self.uncertain) return Promise.reject(error("outcome_uncertain", "Host is locked pending explicit reconciliation"));
    self.pending = true;
    return new Promise(function (resolve, reject) {
        var expired = false, finished = false;
        var timer = setTimeout(function () {
            expired = true;
            // AE modal dialogs defer status callbacks. Keep the request pending until
            // its callback returns, without treating this read as an uncertain edit.
            if(method==="status") { reject(error("host_busy", "Close the AE dialog to reconnect")); return; }
            self.uncertain = true;
            reject(error("outcome_uncertain", "evalScript timed out; it was not cancelled and must not be retried"));
        }, method==="execute" && params && (params.phase==="restore_prepare" || params.phase==="restore_finish") ? self.restoreTimeout : self.timeout);
        var envelope={method:method,params:params};
        if(expectedProject)envelope.expectedProject=expectedProject;
        var payload = JSON.stringify(JSON.stringify(envelope)).replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
        try {
            self.cep.evalScript("CookieMonsterAE.dispatch(" + payload + ")", function (raw) {
                if (finished) return; finished = true; clearTimeout(timer); self.pending = false;
                var value;
                try {
                    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX) throw error("invalid_host_result", "Invalid host response size");
                    value = JSON.parse(raw);
                    if (!record(value) || Object.keys(value).length !== 1 || (!Object.prototype.hasOwnProperty.call(value,"result") && !record(value.error))) throw error("invalid_host_result", "Malformed host envelope");
                    if (expired) { self.onLate(method, value); return; }
                    if (value.error) throw error(text(value.error.code,128) ? value.error.code : "host_error", text(value.error.message,2048) ? value.error.message : "Host failed");
                    resolve(value.result);
                } catch (e) {
                    if (expired) return;
                    if (!e.code) e = error("invalid_host_result", "Malformed host JSON");
                    if (e.code === "invalid_host_result") self.uncertain = true;
                    reject(e);
                }
            });
        } catch (e) { clearTimeout(timer); self.pending = false; self.uncertain = true; reject(error("outcome_uncertain", "evalScript dispatch failed; outcome unknown")); }
    });
};
function captureFile(result, allowMissing) {
    if (!record(result) || !text(result.tempDir,32768) || !text(result.path,32768)) throw error("invalid_capture", "Capture must identify its temporary directory");
    var dir = path.resolve(result.tempDir), file = path.resolve(result.path);
    if (!/^cookiemonster-ae-[0-9]+-[0-9]+$/.test(path.basename(dir)) || path.dirname(dir) !== path.resolve(os.tmpdir()) || path.dirname(file) !== dir || !/^frame_.*\.png$/i.test(path.basename(file))) throw error("invalid_capture", "Capture path is outside integration-owned temporary storage");
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw error("invalid_capture", "Capture directory must not be a link");
    try {
        if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw error("invalid_capture", "Capture path must not be a link");
    } catch(e) { if (!allowMissing || e.code!=="ENOENT") throw e; }
    return {dir:dir,file:file};
}
function completePNG(bytes) {
    if(bytes.length<33 || bytes.slice(0,8).toString("hex")!=="89504e470d0a1a0a" || bytes.readUInt32BE(8)!==13 || bytes.toString("ascii",12,16)!=="IHDR")return false;
    var offset=8, data=false;
    while(offset+12<=bytes.length){
        var size=bytes.readUInt32BE(offset),type=bytes.toString("ascii",offset+4,offset+8);
        if(size>bytes.length-offset-12)return false;
        offset+=size+12;
        if(type==="IDAT" && size)data=true;
        if(type==="IEND")return data && size===0 && offset===bytes.length;
    }
    return false;
}
function cleanupCapture(result) {
    var owned = captureFile(result, result.pending===true), entries = fs.readdirSync(owned.dir);
    if(result.pending===true){
        if(!fs.existsSync(owned.file) || fs.statSync(owned.file).size>64*1024*1024 || !completePNG(fs.readFileSync(owned.file)))
            throw error("capture_pending","Native capture may still be writing; destination preserved");
    }
    entries.forEach(function (name) {
        var f = path.join(owned.dir,name);
        if (!/^frame_.*\.png$/i.test(name) || !fs.lstatSync(f).isFile() || fs.lstatSync(f).isSymbolicLink()) throw error("capture_cleanup_failed","Unexpected file in capture directory; preserved for manual inspection");
    });
    entries.forEach(function (name) { fs.unlinkSync(path.join(owned.dir,name)); });
    fs.rmdirSync(owned.dir);
}
function normalizeCapture(result, document, ImageType) {
    return new Promise(function (resolve,reject) {
        var owned, image, timer, poll, finished=false, ready=result && result.pending!==true;
        function finish(err,value) {
            if(finished)return;finished=true;clearTimeout(timer);clearTimeout(poll);
            if (image) { image.onload = null; image.onerror = null; }
            try { if (owned && ready) cleanupCapture(result); } catch (e) { err = error("capture_cleanup_failed","Temporary capture cleanup failed"); }
            if (err) reject(err); else resolve(value);
        }
        try {
            owned = captureFile(result,result.pending===true);
            var maxWidth=result.maxWidth===undefined ? 2000 : result.maxWidth;
            if(!Number.isInteger(maxWidth) || maxWidth<1 || maxWidth>2000)throw error("invalid_capture","maxWidth must be an integer from 1 to 2000");
            if(result.alpha===undefined)result.alpha=true;
            if(typeof result.alpha!=="boolean")throw error("invalid_capture","alpha must be boolean");
            function readComplete() {
                if(finished)return;
                try {
                    captureFile(result,result.pending===true);
                    if(!fs.existsSync(owned.file)){poll=setTimeout(readComplete,100);return;}
                    if(fs.statSync(owned.file).size>64*1024*1024)throw error("capture_too_large","Source PNG exceeds decode budget");
                    var bytes=fs.readFileSync(owned.file);
                    if(result.pending===true && !completePNG(bytes)){poll=setTimeout(readComplete,100);return;}
                    ready=true;clearTimeout(timer);decode(bytes);
                }catch(e){finish(e);}
            }
            function decode(bytes) {
            if (bytes.length < 24 || bytes.slice(0,8).toString("hex") !== "89504e470d0a1a0a") throw error("invalid_capture","Expected PNG signature");
            var w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
            if (!w || !h || w > 30000 || h > 30000 || w*h > 64000000) throw error("capture_too_large","PNG exceeds pixel decode budget");
            image = new ImageType();
            image.onerror = function () { finish(error("invalid_capture","PNG decode failed")); };
            image.onload = function () {
                try {
                    var scale = Math.min(1,maxWidth/w,2000/h), canvas = document.createElement("canvas"), mime = result.alpha ? "image/png" : "image/jpeg", data, count=0;
                    canvas.width = Math.max(1,Math.floor(w*scale)); canvas.height = Math.max(1,Math.floor(h*scale));
                    do {
                        var ctx = canvas.getContext("2d");
                        if (!ctx) throw error("invalid_capture","Canvas unavailable");
                        if (!result.alpha) { ctx.fillStyle="#000000";ctx.fillRect(0,0,canvas.width,canvas.height); }
                        ctx.drawImage(image,0,0,canvas.width,canvas.height);
                        data=canvas.toDataURL(mime,0.92);
                        if (data.indexOf("data:"+mime+";base64,") !== 0) throw error("invalid_capture","Canvas returned wrong image format");
                        data=data.split(",")[1];
                        // Bridge JSON is 4 MiB; base64 must fit too, not merely the requested 5 MiB binary ceiling.
                        if (Buffer.from(data,"base64").length <= 2800000) break;
                        canvas.width=Math.max(1,Math.floor(canvas.width*0.8));canvas.height=Math.max(1,Math.floor(canvas.height*0.8));
                    } while (++count < 20);
                    if (Buffer.from(data,"base64").length > 2800000) throw error("capture_too_large","Cannot fit capture into transport budget");
                    finish(null,{mime:mime,data:data,width:canvas.width,height:canvas.height});
                } catch(e) { finish(e); }
            };
            timer=setTimeout(function(){finish(error("invalid_capture","Image decode timed out"));},10000);
            image.src="data:image/png;base64,"+bytes.toString("base64");
            }
            timer=setTimeout(function(){finish(error("capture_timeout","Native PNG did not complete within 10 seconds; destination preserved; do not retry automatically"));},10000);
            readComplete();
        } catch(e) { finish(e); }
    });
}
function Client(options) {
    this.store=options.store;this.host=options.host;this.normalize=options.normalize;this.changed=options.changed || function(){};
    this.beforeCapture=options.beforeCapture || function(){return Promise.reject(error("unsafe_state","Visible capture indicator could not be confirmed"));};
    this.request=options.request || request;this.descriptor=null;this.running=false;this.timer=null;this.inFlight=false;
    this.connectionGeneration=0;this.connectionId=null;this.connectionEpoch=null;
    this.state={connection:this.store.state.credential ? "paired" : "unpaired",project:null,activeCompId:null,capabilities:{fileNetwork:false},binding:null,lock:null,busy:false,capture:null,uncertain:this.store.state.uncertain,aeVersion:"",bridgeVersion:"",compatibility:null,lastError:""};
}
Client.prototype.scope=function(){
    var b=this.state.binding,d=this.descriptor;
    return JSON.stringify([this.state.connection,d && d.instanceId,d && d.port,this.connectionGeneration,this.connectionId,this.connectionEpoch,
        b && b.id,b && b.sessionID,b && b.connectionId,b && b.state]);
};
Client.prototype.context=function(){
    var b=this.state.binding,p=this.state.project,bp=b && b.project;
    return JSON.stringify([this.scope(),p && p.id,p && p.path,p && p.saved,bp && bp.id,bp && bp.path,bp && bp.saved]);
};
Client.prototype.emit=function(){
    if(this.panelGuard && (this.panelGuard.scope!==this.scope() || this.panelGuard.credential!==this.store.state.credential))this.panelGuard.stale=true;
    if(this.restoreApproval && (this.restoreApproval.context!==this.context() || this.restoreApproval.credential!==this.store.state.credential || this.state.busy || this.state.uncertain || this.state.lock))this.restoreApproval=null;
    this.changed(this.state);
};
Client.prototype.panel=function(action,args){
    var self=this,allowed={
        "checkpoints":[],"checkpoint.pin":["id","pinned"],"checkpoint.delete":["id"],
        "checkpoint.restore.propose":["id"],"checkpoint.restore.confirm":["token"],"diagnostics":[],"renders":[]
    },payload={action:action},context=self.context(),mutating=typeof action==="string" && action.indexOf("checkpoint.")===0;
    args=args || {};
    if(!Object.prototype.hasOwnProperty.call(allowed,action) || !record(args) || Object.keys(args).sort().join(",")!==allowed[action].slice().sort().join(","))return Promise.reject(error("invalid_payload","Unknown panel action or fields"));
    if(self.panelPending)return Promise.reject(error("panel_busy","Panel request already outstanding"));
    if(self.state.connection!=="connected" || !self.store.state.credential)return Promise.reject(error("disconnected","Connect before requesting bridge services"));
    if(mutating && (self.state.busy || self.state.uncertain || self.state.lock || !self.state.binding || self.state.binding.state!=="active"))return Promise.reject(error("target_locked","Checkpoint changes require an active unlocked binding"));
    if(Object.prototype.hasOwnProperty.call(args,"id") && !text(args.id,256))return Promise.reject(error("invalid_payload","Invalid checkpoint ID"));
    if(action==="checkpoint.pin" && typeof args.pinned!=="boolean")return Promise.reject(error("invalid_payload","pinned must be boolean"));
    var confirming=action==="checkpoint.restore.confirm",proposing=action==="checkpoint.restore.propose",approval=self.restoreApproval;
    if(confirming){
        self.restoreApproval=null;
        if(!approval || approval.context!==context || approval.credential!==self.store.state.credential || args.token!==approval.token)return Promise.reject(error("invalid_token","Review this restore again; approval is missing or stale"));
    }
    var source=self.state.project,sourceProject=source && {id:source.id,path:source.path,saved:source.saved};
    if(proposing && (!record(source) || !text(source.id,256) || !text(source.path,32768) || source.saved!==true ||
        !self.state.binding.project || self.state.binding.project.id!==source.id || self.state.binding.project.path!==source.path || self.state.binding.project.saved!==true))
        return Promise.reject(error("stale_binding","Restore review requires the current saved bound project"));
    if(proposing)self.restoreApproval=null;
    var guard={scope:self.scope(),credential:self.store.state.credential,stale:false};
    var descriptor=Object.assign({},self.descriptor);
    Object.keys(args).forEach(function(k){payload[k]=args[k];});
    self.panelGuard=guard;self.panelPending=true;self.emit();
    // Do not stop host polling: restore.confirm can wait for a host command delivered by /poll.
    return Promise.resolve().then(function(){
        if(guard.stale || guard.scope!==self.scope() || guard.credential!==self.store.state.credential || context!==self.context())
            throw error("stale_binding","Panel scope changed before dispatch");
        return self.request(descriptor,guard.credential,"/panel",payload,(confirming || proposing) ? 300000 : 15000);
    }).then(function(response){
        if(!record(response) || Object.keys(response).length!==1 || !Object.prototype.hasOwnProperty.call(response,"result"))throw error("invalid_response","Panel service must return {result}");
        if(guard.stale || guard.scope!==self.scope() || guard.credential!==self.store.state.credential)throw error("stale_binding","Connection or binding changed during panel request");
        var r=response.result;
        if(confirming){
            var validPath=function(value){
                return text(value,32768) && !/[\x00-\x1f]/.test(value) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
            };
            if(!record(r) || !text(r.checkpointId,256) || !text(r.currentCheckpointId,256) || r.currentCheckpointId===r.checkpointId ||
                typeof r.recoveryCopy!=="boolean" || r.canonicalReplaced!==!r.recoveryCopy || r.rebindRequired!==r.recoveryCopy || r.automationSuspended!==r.recoveryCopy ||
                !text(r.fingerprint,64) || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !text(r.warning,65536) || !r.warning.trim() ||
                !(r.cleanup=== null || (text(r.cleanup,65536) && r.cleanup.trim())) ||
                ["path","canonicalPath","emergencyPath"].some(function(k){return !validPath(r[k]);}) ||
                !(r.originalPath===undefined || r.originalPath=== null || validPath(r.originalPath)) ||
                (r.recoveryCopy ? r.path===r.canonicalPath : r.path!==r.canonicalPath) || r.emergencyPath===r.path || r.emergencyPath===r.canonicalPath ||
                (r.originalPath && [r.path,r.canonicalPath,r.emergencyPath].indexOf(r.originalPath)>=0))
                throw error("invalid_response","Invalid restore completion or backup disclosure");
            if(r.checkpointId!==approval.checkpointId || r.canonicalPath!==approval.source.path)throw error("stale_binding","Restore completed for a different source");
        }
        if(self.context()!==context){
            var p=self.state.project,bp=self.state.binding && self.state.binding.project;
            // Only the authenticated backend's guarded fallback may change this request's project.
            // Canonical completion must return to the original identity; ordinary services stay strict.
            if(!confirming || !r.recoveryCopy || !record(p) || !record(bp) || !text(p.id,256) ||
                p.path!==r.path || bp.path!==r.path || p.id!==bp.id || p.saved!==true || bp.saved!==true)
                throw error("stale_binding","Project changed during panel request");
        }
        if(confirming){
            r={checkpointId:r.checkpointId,currentCheckpointId:r.currentCheckpointId,path:r.path,canonicalPath:r.canonicalPath,
                emergencyPath:r.emergencyPath,originalPath:r.originalPath || null,recoveryCopy:r.recoveryCopy,canonicalReplaced:r.canonicalReplaced,
                rebindRequired:r.rebindRequired,automationSuspended:r.automationSuspended,fingerprint:r.fingerprint,cleanup:r.cleanup,warning:r.warning};
        }
        if(action==="checkpoints"){
            if(!Array.isArray(r) || r.length>10000)throw error("invalid_response","Expected bounded checkpoint list");
            r=r.map(function(c){
                if(!record(c) || !text(c.id,256) || !Number.isFinite(c.createdAt) || typeof c.pinned!=="boolean" || !text(c.storageMode,64) || !Number.isFinite(c.size) || c.size<0)throw error("invalid_response","Invalid checkpoint metadata");
                return {id:c.id,createdAt:c.createdAt,pinned:c.pinned,storageMode:c.storageMode,size:c.size};
            });
        } else if(action==="renders"){
            if(!Array.isArray(r) || r.length>10000 || r.some(function(job){return !record(job);}))throw error("invalid_response","Expected bounded render summaries");
        } else if(action==="diagnostics"){
            if(!record(r))throw error("invalid_response","Expected sanitized diagnostic metadata");
        } else if(action==="checkpoint.restore.propose"){
            if(!record(r) || !text(r.token,4096) || !Number.isFinite(r.sourceTimestamp) || Math.abs(r.sourceTimestamp)>8640000000000000 ||
                !(r.destinationTimestamp=== null || (Number.isFinite(r.destinationTimestamp) && Math.abs(r.destinationTimestamp)<=8640000000000000)) ||
                !text(r.operation,65536) || !r.operation.trim())throw error("invalid_response","Invalid restore proposal or missing bounded operation");
            self.restoreApproval={token:r.token,context:context,credential:guard.credential,checkpointId:payload.id,source:sourceProject,operation:r.operation};
            r={sourceTimestamp:r.sourceTimestamp,destinationTimestamp:r.destinationTimestamp,operation:r.operation};
        }
        return r;
    }).then(function(r){self.panelPending=false;self.panelGuard=null;self.emit();return r;},function(e){
        self.panelPending=false;self.panelGuard=null;
        if(proposing)self.restoreApproval=null;
        if(action==="checkpoint.restore.confirm" && ["disconnected","invalid_response","stale_binding","outcome_uncertain","uncertain_outcome"].indexOf(e.code)>=0){
            self.state.busy=true;self.mark(true);
        }
        self.emit();throw e;
    });
};
Client.prototype.confirmRestore=function(){
    if(!this.restoreApproval)return Promise.reject(error("invalid_token","Review a checkpoint restore first"));
    return this.panel("checkpoint.restore.confirm",{token:this.restoreApproval.token});
};
Client.prototype.mark=function(value){this.store.state.uncertain=value;this.store.save();this.state.uncertain=value;};
Client.prototype.discover=function(){
    var d=this.store.descriptor(),prior=this.descriptor;
    if(!prior || prior.instanceId!==d.instanceId || prior.port!==d.port || prior.version!==d.version || prior.protocol!==d.protocol)this.state.compatibility=null;
    this.state.bridgeVersion=validVersion(d.version) ? d.version : "";
    this.descriptor=d;return d;
};
Client.prototype.negotiate=function(endpoint,body){
    var self=this,d=Object.assign({},self.descriptor),credential=self.store.state.credential,generation=self.connectionGeneration,panelId=self.store.state.panelId;
    function current(){
        return self.descriptor && self.descriptor.instanceId===d.instanceId && self.descriptor.port===d.port &&
            self.descriptor.version===d.version && self.descriptor.protocol===d.protocol &&
            self.store.state.credential===credential && self.connectionGeneration===generation && self.store.state.panelId===panelId;
    }
    function metadata(value){
        var m=compatibilityMetadata(value);
        if(endpoint!=="/rotate" && (m.panelVersion!==VERSION || m.panelProtocol!==PROTOCOL))
            throw error("invalid_response","Compatibility report belongs to a different panel version");
        return m;
    }
    self.state.compatibility=null;self.emit();
    return Promise.resolve().then(function(){
        if(!current())throw error("stale_binding","Negotiation scope changed");
        return self.request(d,endpoint==="/pair" ? null : credential,endpoint,body);
    }).then(function(r){
        if(!current())throw error("stale_binding","Negotiation scope changed");
        if(!record(r) || !text(r.connectionId,256))throw error("invalid_response","Missing negotiation identity");
        var m=metadata(r.compatibility);
        if(r.protocol!==m.protocol || r.version!==m.pluginVersion || r.updateUrl!==m.releaseSourceUrl)
            throw error("invalid_response","Inconsistent negotiation metadata");
        self.state.compatibility=m;self.state.bridgeVersion=m.pluginVersion;
        if(m.status==="incompatible" || r.protocol!==PROTOCOL || r.version!==VERSION)throw error("incompatible_version","Install matching panel and bridge versions");
        return r;
    }).catch(function(e){
        if(!current())throw error("stale_binding","Negotiation scope changed");
        if(["incompatible","incompatible_version"].indexOf(e.code)>=0){
            if(e.details && Object.prototype.hasOwnProperty.call(e.details,"compatibility")){
                try { self.state.compatibility=metadata(e.details.compatibility);self.state.bridgeVersion=self.state.compatibility.pluginVersion; }
                catch(invalid){self.state.compatibility=null;e=invalid;}
            }
            self.state.connection="incompatible";
        } else {self.state.compatibility=null;if(self.state.connection!=="incompatible")self.state.connection="disconnected";}
        self.state.binding=null;if(e.code!=="disconnected")self.stop();self.emit();throw e;
    });
};
Client.prototype.send=function(endpoint,body){return this.request(this.descriptor,this.store.state.credential,endpoint,body);};
Client.prototype.pair=function(code){
    var self=this;
    if(self.inFlight || self.state.busy || self.state.uncertain)return Promise.reject(error("outcome_uncertain","Reconcile before pairing"));
    if(self.store.state.credential)return Promise.reject(error("already_paired","This profile already has a credential. Explicitly unpair or rotate it instead."));
    if(!text(code,64))return Promise.reject(error("invalid_pairing_code","Enter the pairing code generated in chat"));
    self.discover();
    return self.negotiate("/pair",{code:code,protocol:PROTOCOL,version:VERSION,panelId:self.store.state.panelId}).then(function(r){self.acceptCredential(r);self.state.connection="paired";self.emit();});
};
Client.prototype.acceptCredential=function(r){
    if(!record(r) || r.protocol!==PROTOCOL || r.version!==VERSION || !/^[A-Za-z0-9_-]{43}$/.test(r.credential) || !text(r.connectionId,256))throw error("invalid_response","Malformed pairing/rotation response");
    var previous=this.store.state.credential;
    this.store.state.credential=r.credential;
    try { this.store.save(); } catch(e) { this.store.state.credential=previous;throw e; }
    this.connectionGeneration++;this.connectionId=r.connectionId;this.connectionEpoch=null;
    this.state.binding=null;this.state.lock=null;
};
Client.prototype.recoverCredential=function(code){
    var self=this;
    if(self.inFlight || self.panelPending || self.host.pending || self.state.busy && !self.state.uncertain)
        return Promise.reject(error("host_busy","Wait for outstanding host and panel work before credential recovery"));
    if(!self.store.state.credential)return Promise.reject(error("not_paired","Use Pair for a profile without a credential"));
    if(!text(code,64) || !code.trim())return Promise.reject(error("invalid_pairing_code","Enter a fresh single-use code from chat"));
    self.stop();
    var d=Object.assign({},self.discover());
    if(d.protocol!==PROTOCOL || d.version!==VERSION)return Promise.reject(error("incompatible_version","Install matching versions before credential recovery"));
    self.connectionGeneration++;
    var generation=self.connectionGeneration,credential=self.store.state.credential,panelId=self.store.state.panelId,connectionId=self.connectionId;
    function current(){
        var latest=self.store.descriptor();
        if(self.connectionGeneration!==generation || self.store.state.credential!==credential || self.store.state.panelId!==panelId ||
            self.descriptor.instanceId!==d.instanceId || self.descriptor.port!==d.port ||
            latest.instanceId!==d.instanceId || latest.port!==d.port || latest.protocol!==d.protocol || latest.version!==d.version)
            throw error("stale_binding","Credential recovery scope changed");
        if(self.host.pending || self.panelPending)throw error("host_busy","Work started during credential recovery");
    }
    self.inFlight=true;self.recovering=true;self.state.connection="disconnected";self.state.binding=null;self.emit();
    // ponytail: existing code-authenticated /pair revokes the server secret in place; no local reset or new endpoint.
    return Promise.resolve().then(function(){
        if(self.state.uncertain || self.host.uncertain)self.mark(true);
        current();
        return self.negotiate("/compatibility",{panelId:panelId,protocol:PROTOCOL,version:VERSION}).then(function(){
            throw error("credential_valid","Credential still works; use Reconnect or Rotate instead");
        },function(e){
            if(e.code!=="unauthorized")throw e;
            current();
            return self.negotiate("/pair",{code:code,protocol:PROTOCOL,version:VERSION,panelId:panelId});
        });
    }).then(function(r){
        current();
        if(connectionId && r.connectionId!==connectionId)throw error("invalid_response","Recovery changed connection identity");
        var lock=self.state.lock;
        self.acceptCredential(r);self.state.lock=lock;
        self.state.connection="paired";self.state.lastError="";
    }).then(function(){
        self.inFlight=false;self.recovering=false;self.stop();self.emit();
    },function(e){
        self.inFlight=false;self.recovering=false;self.stop();self.emit();throw e;
    });
};
Client.prototype.management=function(endpoint){
    var self=this;
    if(["/disconnect","/unpair","/rotate"].indexOf(endpoint)<0)return Promise.reject(error("invalid_method","Invalid management action"));
    if(self.inFlight || self.panelPending || self.host.pending || self.state.busy || self.state.uncertain)return Promise.reject(error("outcome_uncertain","Wait for host completion and reconcile before changing pairing"));
    if(endpoint==="/rotate"){
        var incompatible=self.state.connection==="incompatible" || self.state.compatibility && self.state.compatibility.status==="incompatible",d=self.discover();
        if(incompatible || d.protocol!==PROTOCOL || d.version!==VERSION){
            self.state.connection="incompatible";self.state.binding=null;self.stop();self.emit();
            return Promise.reject(error("incompatible_version","Install matching versions and reconnect before rotating"));
        }
    }
    self.connectionGeneration++;self.stop();
    var generation=self.connectionGeneration,credential=self.store.state.credential;
    var pending=endpoint==="/rotate" ? self.negotiate("/compatibility",{panelId:self.store.state.panelId,protocol:PROTOCOL,version:VERSION}).then(function(){
        var latest=self.store.descriptor();
        if(generation!==self.connectionGeneration || credential!==self.store.state.credential || latest.instanceId!==d.instanceId ||
            latest.port!==d.port || latest.protocol!==d.protocol || latest.version!==d.version)
            throw error("stale_binding","Rotation scope changed");
        return self.negotiate(endpoint,{});
    }) : self.send(endpoint,{});
    return pending.then(function(r){
        if(endpoint==="/rotate")self.acceptCredential(r);
        if(endpoint==="/unpair"){self.store.state.credential=null;self.store.save();self.state.compatibility=null;}
        self.state.connection=self.store.state.credential ? "paired" : "unpaired";self.state.binding=null;self.state.lock=null;self.emit();
    });
};
Client.prototype.status=function(){
    var self=this;
    if(self.recovering)return Promise.reject(error("host_busy","Credential recovery is outstanding"));
    if(self.state.connection==="incompatible")return Promise.reject(error("incompatible_version","Host access is stopped until versions match"));
    return self.host.call("status",{}).then(function(s){
        if(!record(s) || !record(s.project) || !record(s.capabilities) || typeof s.capabilities.fileNetwork!=="boolean" || !text(s.aeVersion,128) ||
            !(s.activeCompId === null || (Number.isSafeInteger(s.activeCompId) && s.activeCompId>0)))throw error("invalid_host_result","Host status incomplete");
        self.state.project=s.project;self.state.activeCompId=s.activeCompId;self.state.capabilities=s.capabilities;self.state.aeVersion=s.aeVersion;
        if(s.compositions!==undefined && (!Array.isArray(s.compositions) || s.compositions.length>2000 || s.compositions.some(function(c){return !record(c) || !Number.isSafeInteger(c.id) || c.id<1 || typeof c.name!=="string" || c.name.length>32768;})))
            throw error("invalid_host_result","Invalid composition list");
        self.state.compositions=s.compositions || [];
        if(s.uncertain) { self.mark(true); throw error("outcome_uncertain","Host requires recovery"); }
        self.emit();return s;
    });
};
Client.prototype.heartbeat=function(){
    var self=this;
    return self.send("/heartbeat",{project:self.state.project,activeCompId:self.state.activeCompId,capabilities:self.state.capabilities,busy:self.state.busy || self.state.uncertain}).then(function(r){
        if(!record(r) || !Object.prototype.hasOwnProperty.call(r,"binding") || !Object.prototype.hasOwnProperty.call(r,"lock") || !(r.binding=== null || record(r.binding)) || !(r.lock=== null || record(r.lock)))throw error("invalid_response","Malformed heartbeat");
        self.state.binding=r.binding;self.state.lock=r.lock;self.emit();return r;
    });
};
Client.prototype.connect=function(){
    var self=this;
    if(self.recovering)return Promise.reject(error("host_busy","Credential recovery is outstanding"));
    if(self.state.uncertain)return Promise.reject(error("outcome_uncertain","Reconcile before connecting"));
    if(!self.store.state.credential) {
        self.discover();
        return self.negotiate("/pair",{code:self.store.automaticCode(self.descriptor),protocol:PROTOCOL,version:VERSION,panelId:self.store.state.panelId}).then(function(r){
            self.acceptCredential(r);return self.connect();
        });
    }
    self.connectionGeneration++;
    var d=self.discover(),mismatch=d.protocol!==PROTOCOL || d.version!==VERSION;
    return Promise.resolve().then(function(){
        if(!mismatch)return;
        self.state.connection="incompatible";self.state.binding=null;self.stop();self.emit();
        return self.negotiate("/compatibility",{panelId:self.store.state.panelId,protocol:PROTOCOL,version:VERSION}).then(function(){
            self.state.connection="incompatible";self.stop();self.emit();
            throw error("incompatible_version","Descriptor differs from this panel; install matching versions");
        });
    }).then(function(){
        self.state.connection="paired";
        return self.status();
    }).then(function(s){
        return self.negotiate("/connect",{protocol:PROTOCOL,version:VERSION,panelId:self.store.state.panelId,project:s.project,activeCompId:s.activeCompId,aeVersion:s.aeVersion,capabilities:s.capabilities});
    }).then(function(r){
        if(!record(r) || r.protocol!==PROTOCOL || r.version!==VERSION)throw error("incompatible_version","Bridge negotiation mismatch");
        if(!text(r.connectionId,256) || !(r.epoch===undefined || text(r.epoch,256)))throw error("invalid_response","Missing connection identity");
        self.connectionId=r.connectionId;self.connectionEpoch=r.epoch || null;
        self.state.connection="connected";self.state.binding=null;self.state.lock=null;self.emit();
    });
};
Client.prototype.command=function(cmd){
    var self=this, reply, beatTimer, beat=Promise.resolve(), beatError, finished=false, dispatched=false;
    if(self.state.connection==="incompatible")return Promise.reject(error("incompatible_version","Host automation is stopped until versions match"));
    if(!record(cmd) || Object.keys(cmd).sort().join(",")!=="id,method,params,sessionID" || !text(cmd.id,256) || !text(cmd.sessionID,256) || !record(cmd.params) || ["inspect","preflight","save","execute","open","raw","capture","templates"].indexOf(cmd.method)<0) return Promise.reject(error("invalid_command","Malformed or unsupported command"));
    var b=self.state.binding, writes=["save","execute","open","raw","capture"].indexOf(cmd.method)>=0;
    function bound(){
        var current=self.state.binding;
        return current && current.id===b.id && current.state==="active" && current.sessionID===cmd.sessionID && current.project && current.project.id===self.state.project.id && current.project.path===self.state.project.path;
    }
    if(!b || !self.state.project || !bound()) return self.send("/reply",{id:cmd.id,error:{code:"binding_suspended",message:"Rebind to the current project"}});
    if(writes && (!self.state.project.saved || !self.state.lock || self.state.lock.state!=="executing")) return self.send("/reply",{id:cmd.id,error:{code:"lock_required",message:"Saved project and executing lock required"}});
    if(self.state.uncertain)return Promise.reject(error("outcome_uncertain","Panel requires reconciliation"));
    self.mark(true);self.state.busy=true;self.state.capture=cmd.method==="capture" ? cmd.sessionID : null;self.emit();
    function keepAlive(){
        beatTimer=setTimeout(function(){
            beat=self.heartbeat().then(function(){if(!bound())throw error("binding_suspended","Binding changed during host call");},function(e){throw e;}).catch(function(e){beatError=e;});
            beat.then(function(){if(!finished && !beatError)keepAlive();});
        },2000);
    }
    // UI supplies a two-frame paint barrier. A hidden panel must refuse capture, not produce invisible pixels.
    var painted=cmd.method==="capture" ? self.beforeCapture() : Promise.resolve();
    return painted.then(function(){return self.heartbeat();}).then(function(){
        if(!bound())throw error("binding_suspended","Binding changed before host dispatch");
        if(writes && (!self.state.lock || self.state.lock.state!=="executing"))throw error("lock_required","Execution lock changed before dispatch");
        keepAlive();dispatched=true;
        return self.host.call(cmd.method,cmd.params,b.project);
    }).then(function(result){return cmd.method==="capture" ? self.normalize(result) : result;}).then(function(result){reply={id:cmd.id,result:result};},function(e){
        reply={id:cmd.id,error:{code:e.code || "host_error",message:e.message || "Host failed"}};
    }).then(function(){
        finished=true;clearTimeout(beatTimer);return beat;
    }).then(function(){
        var code=reply.error && reply.error.code;
        self.state.uncertain=!!beatError || self.host.uncertain || ["outcome_uncertain","uncertain_outcome","execution_failed","invalid_host_result","capture_cleanup_failed","capture_timeout"].indexOf(code)>=0 || (dispatched && writes && code==="host_error");
        self.state.busy=self.state.uncertain;
        if(beatError)throw error("outcome_uncertain","Connection changed during host call; no retry");
        // Server must observe idle before it resolves reply and attempts unlock.
        return self.heartbeat();
    }).then(function(){return self.send("/reply",reply);}).then(function(){
        if(!self.state.uncertain)self.mark(false);
        if(!self.host.pending)self.state.capture=null;
        self.emit();
        if(self.state.uncertain)throw error("outcome_uncertain","Host outcome requires explicit reconciliation");
    }).catch(function(e){
        finished=true;clearTimeout(beatTimer);
        if(self.store.state.uncertain){self.state.uncertain=true;self.state.busy=true;self.emit();}
        throw e;
    });
};
Client.prototype.tick=function(){
    var self=this;
    if(self.inFlight || self.host.pending || self.state.uncertain || self.state.connection==="incompatible")return Promise.resolve();
    self.inFlight=true;
    return Promise.resolve().then(function(){
        var d=self.store.descriptor();
        if(d.protocol!==PROTOCOL || d.version!==VERSION || !self.descriptor || d.instanceId!==self.descriptor.instanceId || d.port!==self.descriptor.port || self.state.connection!=="connected")return self.connect();
        return self.status();
    }).then(function(){return self.heartbeat();}).then(function(){return self.send("/poll");}).then(function(r){
        self.state.lastError="";
        if(!record(r) || !Object.prototype.hasOwnProperty.call(r,"command"))throw error("invalid_response","Malformed poll");
        // A chat may bind between our heartbeat and poll. Refresh ownership before dispatch.
        if(r.command !== null)return self.heartbeat().then(function(){return self.command(r.command);});
    }).catch(function(e){
        self.state.lastError=e.code || "panel_error";self.state.connection=self.state.connection==="incompatible" || e.code==="incompatible_version" || e.code==="incompatible" ? "incompatible" : "disconnected";self.state.binding=null;
        if(self.store.state.uncertain || self.host.uncertain){self.state.uncertain=true;self.state.busy=true;try{self.mark(true);}catch(ignore){}}
        if(e.code==="unauthorized")self.running=false;
        self.emit();
    }).then(function(){self.inFlight=false;});
};
Client.prototype.start=function(){
    var self=this;if(self.running || self.state.connection==="incompatible")return;self.running=true;
    function loop(){if(!self.running)return;self.tick().then(function(){if(self.running)self.timer=setTimeout(loop,1000);});}loop();
};
Client.prototype.stop=function(){this.running=false;clearTimeout(this.timer);};
Client.prototype.reconcile=function(){
    var self=this;self.stop();
    if(self.state.connection==="incompatible")return Promise.reject(error("incompatible_version","Install matching versions before host reconciliation"));
    if(self.inFlight || self.host.pending)return Promise.reject(error("host_busy","evalScript is still outstanding; wait for it to return or restart AE and inspect recovery state"));
    // Local confirmation clears only the panel/host latch, never the bridge's durable lock.
    self.host.uncertain=false;
    return self.host.call("reconcile",{}).then(function(){self.mark(false);self.state.busy=false;self.state.capture=null;self.state.binding=null;self.state.connection="paired";self.emit();self.start();},function(e){self.host.uncertain=true;throw e;});
};
module.exports={Store:Store,automaticStore:automaticStore,Client:Client,HostRPC:HostRPC,request:request,requestId:function(){return crypto.randomBytes(20).toString("hex");},compatibilityMetadata:compatibilityMetadata,normalizeCapture:normalizeCapture,cleanupCapture:cleanupCapture,secure:secure,VERSION:VERSION,PROTOCOL:PROTOCOL};
