/* CEP browser code: ES5 syntax, Node transport only, no CSInterface dependency. */
(function () {
    "use strict";
    function el(id) { return document.getElementById(id); }
    var client, host, store, api, working = false, checkpoints = [], serviceContext = "", diagnosticURL = null, serviceTimer, restoreOperation = null;
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
        el("services-status").textContent=(e.code || "panel_error")+": "+(["not_found","unsupported_action","unsupported_method"].indexOf(e.code)>=0 ? "This bridge build does not provide the requested panel service." : (e.message || "Bridge service failed"));
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
            else if(requested===client.context())el("services-status").textContent="Checkpoint and render metadata refreshed.";
        });
    }
    function problem(e) { el("error").textContent = (e.code || "panel_error") + ": " + (e.message || "Panel failed"); }
    function render(s) {
        el("status").textContent = s.connection + (s.uncertain ? " / OUTCOME UNCERTAIN: DO NOT RETRY" : "");
        el("versions").textContent = "Panel 0.1.0 / Bridge " + (s.bridgeVersion || "unknown") + " / AE " + (s.aeVersion || "unknown");
        el("project").textContent = s.project ? (s.project.saved ? s.project.path : "Unsaved; writes disabled") : "Unknown";
        el("binding").textContent = s.binding ? s.binding.sessionID + " (" + s.binding.state + ")" : "Unbound; bind in chat";
        el("lock").textContent = s.uncertain ? "Local uncertain latch; durable lock requires chat reconciliation" : s.lock ? s.lock.state : "No bridge lock reported";
        el("capture").hidden = !s.capture;
        el("capture").textContent = s.capture ? "CAPTURING COMPOSITION FRAME / Session " + s.capture : "";
        el("preference").textContent = s.capabilities.fileNetwork ? "Enabled. Preference left unchanged." : "Disabled or unreadable. File operations and capture unavailable; inspection remains available.";
        if (s.lastError) el("error").textContent = s.lastError;
        ["pair","connect","disconnect","rotate","unpair","idle"].forEach(function (id) { el(id).disabled = working || s.busy || s.uncertain; });
        el("reconcile").disabled = working || !s.uncertain || host.pending;
        el("idle").disabled = true;
        var context=client.context();
        if(context!==serviceContext){
            serviceContext=context;checkpoints=[];el("checkpoint").textContent="";
            el("renders").textContent="";el("services-status").textContent="Binding changed. Refresh bridge metadata.";
            clearExport();
        }
        checkpointState();
    }
    function action(fn) {
        if (working) return;
        working = true; el("error").textContent = "";
        Promise.resolve().then(fn).catch(problem).then(function () { working = false; render(client.state); });
    }
    try {
        if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") throw {code:"cep_required",message:"Open this extension inside After Effects 25 or 26."};
        var nodeRequire = window.cep_node ? window.cep_node.require : require;
        var path = nodeRequire("path"), url = nodeRequire("url");
        var filename = decodeURIComponent(url.parse(window.location.href).pathname);
        if (/^\/[A-Za-z]:/.test(filename)) filename = filename.slice(1);
        api = nodeRequire(path.join(path.dirname(filename),"transport.cjs"));
        store = new api.Store();
        host = new api.HostRPC(window.__adobe_cep__,25000,function (method,value) {
            if (method === "capture" && value.result) {
                try { api.cleanupCapture(value.result); } catch (e) { problem(e); }
            }
            render(client.state);
        });
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
        // Preserve the exact review text before transport projects the response to timestamps.
        // Transport still owns authentication, binding checks and the single-use token.
        var request=client.request;
        client.request=function(descriptor,credential,endpoint,body,timeout){
            return request(descriptor,credential,endpoint,body,timeout).then(function(response){
                if(endpoint==="/panel" && body.action==="checkpoint.restore.propose"){
                    var operation=response && response.result && response.result.operation;
                    if(typeof operation!=="string" || !operation.trim() || operation.length>65536)
                        throw {code:"invalid_response",message:"Bridge did not provide a bounded restore operation to review"};
                    restoreOperation=operation;
                }
                return response;
            });
        };
        render(client.state);
        el("pair-form").addEventListener("submit",function(e){
            e.preventDefault();var code=el("code").value.trim();el("code").value="";
            action(function(){client.stop();return client.pair(code).then(function(){client.start();});});
        });
        el("connect").addEventListener("click",function(){action(function(){client.start();});});
        ["disconnect","rotate","unpair"].forEach(function(id){
            el(id).addEventListener("click",function(){action(function(){return client.management("/"+id);});});
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
                    if(!restoreOperation || !client.restoreApproval)throw {code:"invalid_response",message:"Restore review is unavailable"};
                    el("restore-details").textContent="Checkpoint "+c.id+" / source: "+new Date(r.sourceTimestamp).toLocaleString()+" / destination: "+(r.destinationTimestamp === null ? "Not present" : new Date(r.destinationTimestamp).toLocaleString());
                    el("restore-operation").textContent=restoreOperation;
                    el("restore-review").hidden=false;el("restore-cancel").focus();
                }).catch(function(e){client.restoreApproval=null;restoreOperation=null;serviceError(e);});
            });
        });
        el("restore-confirm").addEventListener("click",function(){
            action(function(){
                if(!restoreOperation || !client.restoreApproval)throw {code:"invalid_token",message:"Review the exact restore operation first"};
                client.start();
                return client.confirmRestore().then(function(){
                    el("services-status").textContent="Restore confirmed. Inspect AE; if a recovery copy opened, Save As to the intended path. Explicitly rebind and review reconciliation in chat before further automation.";
                    checkpoints=[];el("checkpoint").textContent="";
                }).catch(function(e){
                    el("services-status").textContent="Restore not confirmed ("+(e.code || "panel_error")+"). Do not retry; inspect AE and reconcile in chat.";
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
                    el("services-status").textContent="Bridge metadata prepared. Click Save Metadata JSON to download.";
                }).catch(serviceError);
            });
        });
        serviceTimer=setInterval(function(){
            if(el("services-auto").checked && !document.hidden && !working && !client.panelPending && !client.restoreApproval && client.state.connection==="connected")action(refreshServices);
        },10000);
        window.addEventListener("beforeunload",function(){
            clearInterval(serviceTimer);clearExport();client.restoreApproval=null;
            client.stop();
            if (client.descriptor && store.state.credential) client.send("/disconnect",{}).catch(function(){});
            store.close();
        });
        if (store.state.credential && !store.state.uncertain) client.start();
        else if (!store.state.uncertain) client.status().catch(problem);
    } catch (e) { problem(e); el("status").textContent = "Panel unavailable"; }
}());
