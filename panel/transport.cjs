"use strict";
var fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), crypto = require("crypto"), child = require("child_process");
var VERSION = "0.1.0", PROTOCOL = 1, MAX = 4 * 1024 * 1024;
function error(code, message) { var e = new Error(message); e.code = code; return e; }
function record(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function text(v, max) { return typeof v === "string" && v.length > 0 && v.length <= max; }
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
function Store(dataDir) {
    this.root = path.resolve(dataDir || process.env.CM_AE_DATA_DIR || path.join(os.homedir(), ".cookiemonster-ae"));
    // The bridge owns the shared directory. Do not create or change permissions on it.
    var rootStat=fs.lstatSync(this.root);
    if(!rootStat.isDirectory() || rootStat.isSymbolicLink())throw error("unsafe_storage","Start the bridge with a real data directory first");
    this.dir = path.join(this.root, "panel-private");
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, {mode:448});
    secure(this.dir, true);
    this.file = path.join(this.dir, "credential.json");
    this.lock = path.join(this.dir, "owner.json");
    try {
        var old = readJSON(this.lock, 4096), alive = false;
        try { process.kill(old.pid, 0); alive = true; } catch (e) { if (e.code !== "ESRCH") alive = true; }
        if (alive) throw error("panel_in_use", "Another panel owns this pairing. Close it before opening this panel.");
        fs.unlinkSync(this.lock);
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    fs.writeFileSync(this.lock, JSON.stringify({pid:process.pid}), {flag:"wx", mode:384});
    try {
        try {
            secure(this.file, false);
            this.state = readJSON(this.file, 8192);
            if (!record(this.state) || !text(this.state.panelId, 128) || !(this.state.credential === null || /^[A-Za-z0-9_-]{43}$/.test(this.state.credential)) || typeof this.state.uncertain !== "boolean") throw error("unsafe_storage", "Invalid panel state");
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
            this.state = {panelId:crypto.randomBytes(24).toString("hex"), credential:null, uncertain:false};
            this.save();
        }
    } catch (e) { this.close(); throw e; }
}
Store.prototype.save = function () {
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
Store.prototype.close = function () { if (this.lock && fs.existsSync(this.lock)) fs.unlinkSync(this.lock); this.lock = null; };
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
            res.on("data", function (chunk) { size += chunk.length; if (size > MAX) { req.destroy(); done(error("invalid_response", "Oversized bridge response")); } else chunks.push(chunk); });
            res.on("error", function () { done(error("disconnected", "Bridge response interrupted")); });
            res.on("end", function () {
                try {
                    if (!/^application\/json(?:;|$)/i.test(res.headers["content-type"] || "")) throw error("invalid_response", "Expected JSON from bridge");
                    var value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (!record(value)) throw error("invalid_response", "Expected response object");
                    if (res.statusCode !== 200 || value.error) {
                        var code = value.error && value.error.code;
                        throw error(typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "bridge_error", "Bridge rejected request");
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
function HostRPC(cep, timeout, onLate) { this.cep = cep; this.timeout = timeout || 25000; this.pending = false; this.uncertain = false; this.onLate = onLate || function () {}; }
HostRPC.prototype.call = function (method, params, expectedProject) {
    var self = this;
    if (self.pending || self.uncertain) return Promise.reject(error("outcome_uncertain", "Host is locked pending explicit reconciliation"));
    self.pending = true;
    return new Promise(function (resolve, reject) {
        var expired = false, finished = false;
        var timer = setTimeout(function () { expired = true; self.uncertain = true; reject(error("outcome_uncertain", "evalScript timed out; it was not cancelled and must not be retried")); }, self.timeout);
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
function captureFile(result) {
    if (!record(result) || !text(result.tempDir,32768) || !text(result.path,32768)) throw error("invalid_capture", "Capture must identify its temporary directory");
    var dir = path.resolve(result.tempDir), file = path.resolve(result.path);
    if (!/^cookiemonster-ae-[0-9]+-[0-9]+$/.test(path.basename(dir)) || path.dirname(dir) !== path.resolve(os.tmpdir()) || path.dirname(file) !== dir || !/^frame_.*\.png$/i.test(path.basename(file))) throw error("invalid_capture", "Capture path is outside integration-owned temporary storage");
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw error("invalid_capture", "Capture path must not be a link");
    return {dir:dir,file:file};
}
function cleanupCapture(result) {
    var owned = captureFile(result), entries = fs.readdirSync(owned.dir);
    entries.forEach(function (name) {
        var f = path.join(owned.dir,name);
        if (!/^frame_.*\.png$/i.test(name) || !fs.lstatSync(f).isFile() || fs.lstatSync(f).isSymbolicLink()) throw error("capture_cleanup_failed","Unexpected file in capture directory; preserved for manual inspection");
    });
    entries.forEach(function (name) { fs.unlinkSync(path.join(owned.dir,name)); });
    fs.rmdirSync(owned.dir);
}
function normalizeCapture(result, document, ImageType) {
    return new Promise(function (resolve,reject) {
        var owned, image, timer;
        function finish(err,value) {
            clearTimeout(timer);
            if (image) { image.onload = null; image.onerror = null; }
            try { if (owned) cleanupCapture(result); } catch (e) { err = error("capture_cleanup_failed","Temporary capture cleanup failed"); }
            if (err) reject(err); else resolve(value);
        }
        try {
            owned = captureFile(result);
            if (fs.statSync(owned.file).size > 64*1024*1024) throw error("capture_too_large","Source PNG exceeds decode budget");
            var bytes = fs.readFileSync(owned.file);
            if (bytes.length < 24 || bytes.slice(0,8).toString("hex") !== "89504e470d0a1a0a") throw error("invalid_capture","Expected PNG signature");
            var w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
            if (!w || !h || w > 30000 || h > 30000 || w*h > 64000000) throw error("capture_too_large","PNG exceeds pixel decode budget");
            image = new ImageType();
            image.onerror = function () { finish(error("invalid_capture","PNG decode failed")); };
            image.onload = function () {
                try {
                    var scale = Math.min(1,2000/w,2000/h), canvas = document.createElement("canvas"), mime = result.alpha ? "image/png" : "image/jpeg", data, count=0;
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
        } catch(e) { finish(e); }
    });
}
function Client(options) {
    this.store=options.store;this.host=options.host;this.normalize=options.normalize;this.changed=options.changed || function(){};
    this.beforeCapture=options.beforeCapture || function(){return Promise.reject(error("unsafe_state","Visible capture indicator could not be confirmed"));};
    this.request=options.request || request;this.descriptor=null;this.running=false;this.timer=null;this.inFlight=false;
    this.state={connection:this.store.state.credential ? "paired" : "unpaired",project:null,activeCompId:null,capabilities:{fileNetwork:false},binding:null,lock:null,busy:false,capture:null,uncertain:this.store.state.uncertain,aeVersion:"",bridgeVersion:"",lastError:""};
}
Client.prototype.context=function(){
    var b=this.state.binding,p=this.state.project,d=this.descriptor;
    return JSON.stringify([this.state.connection,d && d.instanceId,b && b.id,b && b.sessionID,b && b.state,p && p.id,p && p.path]);
};
Client.prototype.emit=function(){
    if(this.restoreApproval && (this.restoreApproval.context!==this.context() || this.state.busy || this.state.uncertain || this.state.lock))this.restoreApproval=null;
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
    if(action==="checkpoint.restore.confirm"){
        var approval=self.restoreApproval;
        self.restoreApproval=null;
        if(!approval || approval.context!==context || args.token!==approval.token)return Promise.reject(error("invalid_token","Review this restore again; approval is missing or stale"));
    }
    Object.keys(args).forEach(function(k){payload[k]=args[k];});
    self.panelPending=true;self.emit();
    // Do not stop host polling: restore.confirm can wait for a host command delivered by /poll.
    return self.request(self.descriptor,self.store.state.credential,"/panel",payload,action==="checkpoint.restore.confirm" ? 300000 : 15000).then(function(response){
        if(!record(response) || Object.keys(response).length!==1 || !Object.prototype.hasOwnProperty.call(response,"result"))throw error("invalid_response","Panel service must return {result}");
        if(self.context()!==context)throw error("stale_binding","Connection or binding changed during panel request");
        var r=response.result;
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
            if(!record(r) || !text(r.token,4096) || !Number.isFinite(r.sourceTimestamp) || !(r.destinationTimestamp === null || Number.isFinite(r.destinationTimestamp)))throw error("invalid_response","Invalid restore proposal");
            self.restoreApproval={token:r.token,context:context};
            r={sourceTimestamp:r.sourceTimestamp,destinationTimestamp:r.destinationTimestamp};
        }
        return r;
    }).then(function(r){self.panelPending=false;self.emit();return r;},function(e){
        self.panelPending=false;
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
    var d=this.store.descriptor();this.state.bridgeVersion=d.version;
    if(d.protocol!==PROTOCOL || d.version!==VERSION){this.state.connection="incompatible";this.emit();throw error("incompatible_version","Panel "+VERSION+" requires matching bridge; installed "+d.version);}
    this.descriptor=d;return d;
};
Client.prototype.send=function(endpoint,body){return this.request(this.descriptor,this.store.state.credential,endpoint,body);};
Client.prototype.pair=function(code){
    var self=this;
    if(self.inFlight || self.state.busy || self.state.uncertain)return Promise.reject(error("outcome_uncertain","Reconcile before pairing"));
    self.discover();
    if(!text(code,64))return Promise.reject(error("invalid_pairing_code","Enter the pairing code generated in chat"));
    return self.request(self.descriptor,null,"/pair",{code:code,protocol:PROTOCOL,version:VERSION,panelId:self.store.state.panelId}).then(function(r){self.acceptCredential(r);self.state.connection="paired";self.emit();});
};
Client.prototype.acceptCredential=function(r){
    if(!record(r) || r.protocol!==PROTOCOL || r.version!==VERSION || !/^[A-Za-z0-9_-]{43}$/.test(r.credential) || !text(r.connectionId,256))throw error("invalid_response","Malformed pairing/rotation response");
    this.store.state.credential=r.credential;this.store.save();this.state.binding=null;this.state.lock=null;
};
Client.prototype.management=function(endpoint){
    var self=this;
    if(["/disconnect","/unpair","/rotate"].indexOf(endpoint)<0)return Promise.reject(error("invalid_method","Invalid management action"));
    if(self.inFlight || self.state.busy || self.state.uncertain)return Promise.reject(error("outcome_uncertain","Wait for host completion and reconcile before changing pairing"));
    self.stop();
    return self.send(endpoint,{}).then(function(r){
        if(endpoint==="/rotate")self.acceptCredential(r);
        if(endpoint==="/unpair"){self.store.state.credential=null;self.store.save();}
        self.state.connection=self.store.state.credential ? "paired" : "unpaired";self.state.binding=null;self.state.lock=null;self.emit();
    });
};
Client.prototype.status=function(){
    var self=this;
    return self.host.call("status",{}).then(function(s){
        if(!record(s) || !record(s.project) || !record(s.capabilities) || typeof s.capabilities.fileNetwork!=="boolean" || !text(s.aeVersion,128) ||
            !(s.activeCompId === null || (Number.isSafeInteger(s.activeCompId) && s.activeCompId>0)))throw error("invalid_host_result","Host status incomplete");
        self.state.project=s.project;self.state.activeCompId=s.activeCompId;self.state.capabilities=s.capabilities;self.state.aeVersion=s.aeVersion;
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
    self.discover();
    return self.status().then(function(s){
        return self.send("/connect",{protocol:PROTOCOL,version:VERSION,panelId:self.store.state.panelId,project:s.project,activeCompId:s.activeCompId,aeVersion:s.aeVersion,capabilities:s.capabilities});
    }).then(function(r){
        if(r.protocol!==PROTOCOL || r.version!==VERSION)throw error("incompatible_version","Bridge negotiation mismatch");
        self.state.connection="connected";self.state.binding=null;self.state.lock=null;self.emit();
    });
};
Client.prototype.command=function(cmd){
    var self=this, reply, beatTimer, beat=Promise.resolve(), beatError, finished=false, dispatched=false;
    if(!record(cmd) || Object.keys(cmd).sort().join(",")!=="id,method,params,sessionID" || !text(cmd.id,256) || !text(cmd.sessionID,256) || !record(cmd.params) || ["inspect","preflight","save","execute","open","raw","capture","templates"].indexOf(cmd.method)<0) return Promise.reject(error("invalid_command","Malformed or unsupported command"));
    var b=self.state.binding, writes=["save","execute","open","raw"].indexOf(cmd.method)>=0;
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
        self.state.uncertain=!!beatError || self.host.uncertain || ["outcome_uncertain","uncertain_outcome","execution_failed","invalid_host_result","capture_cleanup_failed"].indexOf(code)>=0 || (dispatched && writes && code==="host_error");
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
    if(self.inFlight || self.state.uncertain)return Promise.resolve();
    self.inFlight=true;
    return Promise.resolve().then(function(){
        var d=self.store.descriptor();
        if(d.protocol!==PROTOCOL || d.version!==VERSION || !self.descriptor || d.instanceId!==self.descriptor.instanceId || d.port!==self.descriptor.port || self.state.connection!=="connected")return self.connect();
        return self.status();
    }).then(function(){return self.heartbeat();}).then(function(){return self.send("/poll");}).then(function(r){
        if(!record(r) || !Object.prototype.hasOwnProperty.call(r,"command"))throw error("invalid_response","Malformed poll");
        if(r.command !== null)return self.command(r.command);
    }).catch(function(e){
        self.state.lastError=e.code || "panel_error";self.state.connection=e.code==="incompatible_version" || e.code==="incompatible" ? "incompatible" : "disconnected";self.state.binding=null;
        if(self.store.state.uncertain || self.host.uncertain){self.state.uncertain=true;self.state.busy=true;try{self.mark(true);}catch(ignore){}}
        if(e.code==="unauthorized")self.running=false;
        self.emit();
    }).then(function(){self.inFlight=false;});
};
Client.prototype.start=function(){
    var self=this;if(self.running)return;self.running=true;
    function loop(){if(!self.running)return;self.tick().then(function(){if(self.running)self.timer=setTimeout(loop,1000);});}loop();
};
Client.prototype.stop=function(){this.running=false;clearTimeout(this.timer);};
Client.prototype.reconcile=function(){
    var self=this;self.stop();
    if(self.inFlight || self.host.pending)return Promise.reject(error("host_busy","evalScript is still outstanding; wait for it to return or restart AE and inspect recovery state"));
    // Local confirmation clears only the panel/host latch, never the bridge's durable lock.
    self.host.uncertain=false;
    return self.host.call("reconcile",{}).then(function(){self.mark(false);self.state.busy=false;self.state.capture=null;self.state.binding=null;self.state.connection="paired";self.emit();self.start();},function(e){self.host.uncertain=true;throw e;});
};
module.exports={Store:Store,Client:Client,HostRPC:HostRPC,request:request,normalizeCapture:normalizeCapture,cleanupCapture:cleanupCapture,secure:secure,VERSION:VERSION,PROTOCOL:PROTOCOL};
