/* CEP browser code: ES5 syntax, Node transport only, no CSInterface dependency. */
(function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var client, host, store, api, chat, working = false, checkpoints = [], serviceContext = "", diagnosticURL = null, serviceTimer, restoreOperation = null, restoreResult = "";
    window.addEventListener("keydown",function(e){
        if(e.key==="Escape" && el("advanced").open){el("advanced").open=false;el("settings-toggle").focus();}
    });
    window.addEventListener("click",function(e){
        if(el("advanced").open && !el("advanced").contains(e.target))el("advanced").open=false;
    });
    function serviceStatus(message) {
        // Operation evidence is not current-project metadata; refreshes must not erase backup locations.
        el("services-status").textContent=message+(restoreResult ? "\n\n"+restoreResult : "");
    }
    function clearExport() {
        if(diagnosticURL)window.URL.revokeObjectURL(diagnosticURL);
        diagnosticURL=null;el("diagnostics-download").hidden=true;el("diagnostics-download").removeAttribute("href");
    }
    function selectedCheckpoint() {
        for(var i=0;i<checkpoints.length;i++)if(checkpoints[i].id===el("checkpoint").value)return checkpoints[i];
        return null;
    }
    function checkpointState() {
        var c=selectedCheckpoint(),s=client.state,disabled=working || client.panelPending || s.busy || s.uncertain || !!s.lock || !s.binding || s.binding.state!=="active" || s.connection!=="connected";
        el("checkpoint-details").textContent=c ? new Date(c.createdAt).toLocaleString()+" / "+c.storageMode+" / "+c.size+" bytes / "+(c.pinned ? "Pinned" : "Unpinned") : "";
        el("checkpoint").disabled=working || !!client.panelPending;
        el("checkpoint-pin").textContent=c && c.pinned ? "Unpin" : "Pin";
        ["checkpoint-pin","checkpoint-delete","restore-propose"].forEach(function(id){el(id).disabled=disabled || !c;});
        el("restore-confirm").disabled=disabled || !client.restoreApproval || !restoreOperation;
        el("restore-review").hidden=!client.restoreApproval || !restoreOperation;
        if(!client.restoreApproval){restoreOperation=null;el("restore-operation").textContent="";}
        ["services-refresh","diagnostics"].forEach(function(id){el(id).disabled=working || client.panelPending || s.connection!=="connected";});
    }
    function serviceError(e) {
        serviceStatus((e.code || "panel_error")+": "+(["not_found","unsupported_action","unsupported_method"].indexOf(e.code)>=0 ? "This bridge build does not provide the requested panel service." : (e.message || "Bridge service failed")));
        problem(e);
    }
    function refreshServices() {
        var requested=client.context(),failures=[];
        return client.panel("checkpoints",{}).then(function(list){
            if(requested!==client.context())return;
            var selected=el("checkpoint").value;
            checkpoints=list;el("checkpoint").textContent="";
            if(!list.length){var empty=document.createElement("option");empty.value="";empty.textContent="No checkpoints";el("checkpoint").appendChild(empty);}
            list.forEach(function(c){var option=document.createElement("option");option.value=c.id;option.textContent=new Date(c.createdAt).toLocaleString()+" / "+c.id;el("checkpoint").appendChild(option);});
            if(list.some(function(c){return c.id===selected;}))el("checkpoint").value=selected;
            checkpointState();
        }).catch(function(e){failures.push(e);}).then(function(){
            if(requested!==client.context())return;
            return client.panel("renders",{}).then(function(jobs){
                el("renders").textContent="";
                if(!jobs.length){var empty=document.createElement("li");empty.textContent="No render jobs";el("renders").appendChild(empty);}
                jobs.forEach(function(job){
                    var row=document.createElement("li");
                    // Render only summary fields, never a path, command line or arbitrary HTML.
                    row.textContent=String(job.jobId || job.id || "Job")+" / "+String(job.state || job.status || "unknown")+(job.recoverable ? " / Recover access in chat" : "");
                    el("renders").appendChild(row);
                });
            }).catch(function(e){failures.push(e);});
        }).then(function(){
            if(failures.length){el("services-auto").checked=false;serviceError(failures[0]);}
            else if(requested===client.context())serviceStatus("Checkpoint and render metadata refreshed.");
        });
    }
    function problem(e) { el("error").textContent = (e.code || "panel_error") + ": " + (e.message || "Panel failed");el("connection-notice").hidden=false;el("connection-notice").textContent=e.message || "Connection needs attention. Open Settings & troubleshooting."; }
    function render(s) {
        if(chat)chat.update(s);
        var recovery=!!(s.uncertain || s.lock);
        el("connection-status").className=s.connection==="connected" ? "is-connected" : "is-disconnected";
        el("connection-status").textContent=s.connection==="connected" ? (recovery ? "Connected · Paused" : "Connected") : s.connection==="connecting" ? "Connecting…" : s.connection==="disconnected" ? "Disconnected" : "Not connected";
        el("recovery-notice").hidden=!recovery;
        el("recovery-message").textContent=s.uncertain ? "An action was interrupted. Wait for AE to finish, then check your project and render queue before continuing. The action will not be repeated." : "The connection is back. Ask CookieMonster to review the interrupted action in chat before making more changes.";
        el("reconcile").hidden=!s.uncertain;
        el("connection-notice").hidden=s.connection==="connected" || recovery;
        el("connection-notice").textContent=s.connection==="incompatible" ? "Update the AE panel and CookieMonster plugin to matching versions. See Settings & troubleshooting." : "Open CookieMonster with the AE plugin enabled. This panel connects automatically.";
        el("status").textContent = s.connection + (s.uncertain ? " / OUTCOME UNCERTAIN: DO NOT RETRY" : "");
        var compatibility=null;
        try { if(s.compatibility)compatibility=api.compatibilityMetadata(s.compatibility); } catch(ignore) {}
        el("versions").textContent="Panel "+api.VERSION+" / Bridge Plugin "+(compatibility ? compatibility.pluginVersion : s.bridgeVersion || "unknown")+
            " / CookieMonster Desktop "+(compatibility && compatibility.cookieMonsterVersionStatus==="configured" ? compatibility.cookieMonsterVersion : "not configured")+
            " / AE "+(s.aeVersion || "unknown");
        el("compatibility-status").textContent=s.connection==="incompatible" ? "Incompatible: automation stopped. Install matching versions, then reconnect." :
            compatibility ? "Panel/bridge compatibility: "+compatibility.status : "Waiting for CookieMonster.";
        ["plugin","panel","cookieMonster"].forEach(function(key){
            var link=el("update-"+key),update=compatibility && compatibility.updates[key],configured=update && update.status==="configured";
            link.removeAttribute("href");link.hidden=!configured;
            el("update-"+key+"-status").textContent=configured ? "Configured for "+update.version+" / protocol "+update.protocol : "not configured";
            if(configured)link.href=update.url;
        });
        var source=el("release-source");
        source.removeAttribute("href");source.hidden=!compatibility;
        if(compatibility)source.href=compatibility.releaseSourceUrl;
        el("project").textContent = s.project ? (s.project.saved ? s.project.path : "Unsaved; writes disabled") : "Unknown";
        el("binding").textContent = s.binding ? s.binding.sessionID + " (" + s.binding.state + ")" : "Ready for a conversation; ask CookieMonster to inspect AE";
        el("active-comp").textContent = s.activeCompId === null ? "No active composition" : "Composition ID " + s.activeCompId;
        el("lock").textContent = s.uncertain ? "Local uncertain latch; durable lock requires chat reconciliation" : s.lock ? s.lock.state : "No bridge lock reported";
        el("capture").hidden = !s.capture;
        el("capture").textContent = s.capture ? "CAPTURING COMPOSITION FRAME / Session " + s.capture : "";
        el("preference").textContent = s.capabilities.fileNetwork ? "Enabled. Preference left unchanged." : "Disabled or unreadable. File operations and capture unavailable; inspection remains available.";
        if (s.lastError) el("error").textContent = s.lastError;
        ["pair","connect","disconnect","rotate","unpair","idle"].forEach(function (id) { el(id).disabled = working || s.busy || s.uncertain; });
        el("rotate").disabled = el("rotate").disabled || s.connection==="incompatible" || compatibility && compatibility.status==="incompatible";
        el("recover-credential").disabled = working || client.recovering || client.panelPending || host.pending || s.busy && !s.uncertain || !store.state.credential;
        el("reconcile").disabled = working || client.recovering || !s.uncertain || host.pending || s.connection==="incompatible";
        el("idle").disabled = true;
        var context=client.context();
        if(context!==serviceContext){
            serviceContext=context;checkpoints=[];el("checkpoint").textContent="";
            el("renders").textContent="";serviceStatus("Binding changed. Refresh bridge metadata.");
            clearExport();
        }
        checkpointState();
    }
    function action(fn) {
        if (working) return;
        working = true; el("error").textContent = "";
        Promise.resolve().then(fn).catch(problem).then(function () { working = false; render(client.state); });
    }
    function openProfile(automatic) {
        if (store) return;
        try {
        store = automatic ? api.automaticStore() : new api.Store(undefined,el("profile").value);
        el("profile").disabled=true;el("profile-open").disabled=true;
        el("profile-status").textContent="Local identity: "+store.profile+". Saved automatically for reconnection.";
        host = new api.HostRPC(window.__adobe_cep__,25000,function (method,value) {
            if (method === "capture" && value.result) {
                try { api.cleanupCapture(value.result); } catch (e) { problem(e); }
            }
            render(client.state);
        },120000);
        client = new api.Client({store:store,host:host,changed:render,normalize:function (r) { return api.normalizeCapture(r,document,Image); },beforeCapture:function(){
            return new Promise(function(resolve,reject){
                if(document.hidden){reject({code:"unsafe_state",message:"Show the CookieMonster panel before capture"});return;}
                var timer=setTimeout(function(){reject({code:"unsafe_state",message:"Capture indicator could not paint"});},1000);
                window.requestAnimationFrame(function(){window.requestAnimationFrame(function(){
                    clearTimeout(timer);
                    if(document.hidden || el("capture").hidden)reject({code:"unsafe_state",message:"Capture indicator is not visible"});else resolve();
                });});
            });
        }});
        render(client.state);
        if(window.CookieMonsterChat)chat=window.CookieMonsterChat(client,store,api);
        el("pair-form").addEventListener("submit",function(e){
            e.preventDefault();var code=el("code").value.trim();el("code").value="";
            action(function(){client.stop();return client.pair(code).then(function(){client.start();});});
        });
        el("connect").addEventListener("click",function(){action(function(){client.stop();return client.connect().then(function(){client.start();});});});
        ["disconnect","rotate","unpair"].forEach(function(id){
            el(id).addEventListener("click",function(){action(function(){return client.management("/"+id);});});
        });
        el("recover-credential").addEventListener("click",function(){
            var code=el("code").value.trim();el("code").value="";
            if(working || !window.confirm("Recover the invalid credential for profile "+store.profile+"? This revokes its server credential using the fresh chat code. Panel identity, uncertain latch and durable locks are retained. Automation stays stopped; reconnect and rebind separately."))return;
            action(function(){
                el("credential-recovery-status").textContent="Checking credential recovery. Identity, uncertain latch and durable locks will be retained.";
                return client.recoverCredential(code).then(function(){
                    el("credential-recovery-status").textContent="Credential recovered for this profile. Automation remains stopped. Inspect AE and clear any local latch separately, then reconnect, rebind and review durable locks in chat.";
                },function(e){
                    el("credential-recovery-status").textContent="Credential recovery not confirmed. Preserve this profile and all recovery state. Correct the reported problem; if the credential remains invalid, use a fresh chat code for explicit recovery.";
                    throw e;
                });
            });
        });
        el("reconcile").addEventListener("click",function(){action(function(){return client.reconcile();});});
        el("checkpoint").addEventListener("change",function(){client.restoreApproval=null;checkpointState();});
        el("services-refresh").addEventListener("click",function(){action(refreshServices);});
        el("checkpoint-pin").addEventListener("click",function(){
            var c=selectedCheckpoint();if(!c)return;
            action(function(){client.restoreApproval=null;return client.panel("checkpoint.pin",{id:c.id,pinned:!c.pinned}).then(refreshServices).catch(serviceError);});
        });
        el("checkpoint-delete").addEventListener("click",function(){
            var c=selectedCheckpoint(),context=client.context();if(!c || !window.confirm("Permanently delete checkpoint "+c.id+" from "+new Date(c.createdAt).toLocaleString()+"?"))return;
            action(function(){
                if(client.context()!==context)throw {code:"stale_binding",message:"Binding changed while confirming deletion"};
                client.restoreApproval=null;return client.panel("checkpoint.delete",{id:c.id}).then(refreshServices).catch(serviceError);
            });
        });
        el("restore-propose").addEventListener("click",function(){
            var c=selectedCheckpoint();if(!c)return;
            action(function(){
                client.restoreApproval=null;restoreOperation=null;
                return client.panel("checkpoint.restore.propose",{id:c.id}).then(function(r){
                    if(!client.restoreApproval)throw {code:"invalid_response",message:"Restore review is unavailable"};
                    restoreOperation=r.operation;
                    el("restore-details").textContent="Checkpoint "+c.id+" / source: "+new Date(r.sourceTimestamp).toLocaleString()+" / destination: "+(r.destinationTimestamp === null ? "Not present" : new Date(r.destinationTimestamp).toLocaleString());
                    el("restore-operation").textContent=restoreOperation;
                    el("restore-review").hidden=false;el("restore-cancel").focus();
                }).catch(function(e){client.restoreApproval=null;restoreOperation=null;serviceError(e);});
            });
        });
        el("restore-confirm").addEventListener("click",function(){
            action(function(){
                if(!restoreOperation || !client.restoreApproval)throw {code:"invalid_token",message:"Review the exact restore operation first"};
                var session=client.state.binding.sessionID;
                client.start();
                return client.confirmRestore().then(function(r){
                    restoreResult="Last Restore Result / Session "+session+" / checkpointId: "+r.checkpointId+
                        "\n"+r.warning+"\ncurrentCheckpointId: "+r.currentCheckpointId+"\nemergencyPath: "+r.emergencyPath+
                        "\noriginalPath: "+(r.originalPath || "Not returned; inspect canonicalPath")+
                        "\npath: "+r.path+"\ncanonicalPath: "+r.canonicalPath+
                        "\ncanonicalReplaced: "+r.canonicalReplaced+"\nrebindRequired: "+r.rebindRequired+
                        "\nautomationSuspended: "+r.automationSuspended+(r.cleanup ? "\n"+r.cleanup : "");
                    serviceStatus("Restore completed. Inspect AE and retain the disclosed backups.");
                    checkpoints=[];el("checkpoint").textContent="";
                }).catch(function(e){
                    serviceStatus("Restore not confirmed ("+(e.code || "panel_error")+"). Do not retry; inspect AE and reconcile in chat.");
                    problem(e);
                });
            });
        });
        el("restore-cancel").addEventListener("click",function(){client.restoreApproval=null;checkpointState();el("restore-propose").focus();});
        el("diagnostics").addEventListener("click",function(){
            action(function(){
                clearExport();
                return client.panel("diagnostics",{}).then(function(metadata){
                    diagnosticURL=window.URL.createObjectURL(new Blob([JSON.stringify(metadata,null,2)],{type:"application/json"}));
                    el("diagnostics-download").href=diagnosticURL;el("diagnostics-download").hidden=false;el("diagnostics-download").focus();
                    serviceStatus("Bridge metadata prepared. Click Save Metadata JSON to download.");
                }).catch(serviceError);
            });
        });
        serviceTimer=setInterval(function(){
            if(el("services-auto").checked && !document.hidden && !working && !client.panelPending && !client.restoreApproval && client.state.connection==="connected")action(refreshServices);
        },10000);
        window.addEventListener("beforeunload",function(){
            clearInterval(serviceTimer);clearExport();client.restoreApproval=null;
            client.stop();
            // Unload cannot await HTTP: a late disconnect could suspend a reopened profile.
            // The bridge suspends on heartbeat expiry; use Disconnect for an acknowledged close.
        });
        if (!store.state.uncertain) client.start();
        } catch (e) {
            problem(e);el("status").textContent="Panel unavailable";
            if(automatic && !store && e.code==="ENOENT") {
                el("status").textContent="Waiting for CookieMonster. Open CookieMonster with the AE plugin enabled.";
                setTimeout(function(){openProfile(true);},3000);
            }
            // A failed initialization never selects a different profile or resets its latch.
            if (store) { el("profile-status").textContent="Initialization failed. Close and reopen this panel with the same profile."; }
        }
    }
    try {
        var cep=window.__adobe_cep__;
        if (!cep || typeof cep.evalScript !== "function" || typeof cep.getHostEnvironment !== "function" || typeof cep.getSystemPath !== "function") throw {code:"cep_required",message:"Open this extension inside After Effects 25 or 26."};
        // Adobe CEP 12 CSInterface: HostEnvironment identifies the application, not a persistent launch.
        // https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/CSInterface.js
        var raw=cep.getHostEnvironment();
        if (typeof raw !== "string" || raw.length>65536) throw {code:"invalid_host",message:"Invalid CEP host environment"};
        var environment=JSON.parse(raw);
        if (!environment || environment.appId!=="AEFT" || typeof environment.appVersion!=="string" || !/^(25|26)\./.test(environment.appVersion)) throw {code:"invalid_host",message:"This panel requires After Effects 25 or 26"};
        var nodeRequire=window.cep_node ? window.cep_node.require : require;
        var path=nodeRequire("path"),url=nodeRequire("url"),extension=cep.getSystemPath("extension");
        if (typeof extension!=="string" || extension.length>32768) throw {code:"invalid_host",message:"Invalid CEP extension path"};
        if (/^file:/i.test(extension)) {
            var parsed=new url.URL(extension);
            if (parsed.host || parsed.search || parsed.hash) throw {code:"invalid_host",message:"Extension must be a local installed directory"};
            extension=url.fileURLToPath(extension);
        } else extension=decodeURI(extension);
        if (!path.isAbsolute(extension) || /^[\\/]{2}/.test(extension) || extension.indexOf("\0")>=0 || extension.split(/[\\/]/).indexOf("..")>=0) throw {code:"invalid_host",message:"CEP extension path must be absolute and local, without traversal"};
        api=nodeRequire(path.join(extension,"transport.cjs"));
        if (!el("profile-form") || !el("profile") || !el("profile-open") || !el("profile-status")) throw {code:"profile_ui_required",message:"Install the matching panel HTML with explicit profile selection"};
        ["pair","connect","disconnect","rotate","unpair","idle","reconcile","services-refresh","diagnostics"].forEach(function(id){el(id).disabled=true;});
        el("status").textContent="Connecting to CookieMonster...";
        el("profile-form").addEventListener("submit",function(e){e.preventDefault();el("error").textContent="";openProfile();});
        window.addEventListener("unload",function(){if(store)store.close();});
        openProfile(true);
    } catch (e) { problem(e); el("status").textContent = "Panel unavailable"; }
}());
