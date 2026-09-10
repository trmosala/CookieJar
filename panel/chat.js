/* CEP-compatible presentation. All chat requests use the authenticated Node transport. */
(function () {
    "use strict";
    window.CookieMonsterChat = function (client, store, api) {
        function el(id) { return document.getElementById(id); }
        var state=client.state, projectKey="", generation=0, polling=false, sending=false, timer,
            messagesKey="", approvalsKey="", compKey="", snapshot=null, takeover=false, serverError="", attachments=[], deliveryUnknown=false, refreshError="",
            catalog=[], catalogKey="", catalogAt=0, catalogLoading=false, modelSaving=false, modelError="", modelRevision=0;
        function projectIdentity(s) { return s.project ? JSON.stringify(s.project) : ""; }
        function pins() { if(!store.state.chatPins)store.state.chatPins={};return store.state.chatPins; }
        function pinKey() { return "project:"+(state.project && state.project.id); }
        function selected() { return el("chat-comp").value==="follow" ? state.activeCompId : Number(el("chat-comp").value); }
        function label() {
            var id=selected(),comps=state.compositions || [];
            for(var i=0;i<comps.length;i++)if(comps[i].id===id)return comps[i].name+" (#"+id+")";
            return id ? "Missing composition #"+id : "Project context";
        }
        function error(e) { el("chat-error").textContent=(e.code ? e.code+": " : "")+(e.message || String(e)); }
        function controls() {
            var connected=state.connection==="connected", busy=sending || modelSaving || snapshot && snapshot.status!=="idle";
            el("chat-model").disabled=!connected || !!busy || deliveryUnknown || !catalog.length;
            el("chat-reasoning").disabled=el("chat-model").disabled || !el("chat-model").value || el("chat-reasoning").children.length<=1;
            el("chat-model-status").textContent=!connected ? "Connect to CookieMonster to choose a model" : modelSaving ? "Saving model…" : modelError;
            el("chat-send").disabled=!connected || !!busy || state.uncertain || deliveryUnknown || attachments.some(function(a){return !a.url;}) || !el("chat-input").value.trim();
            el("chat-attach").disabled=!!busy || deliveryUnknown;
            el("chat-input").disabled=!!sending || deliveryUnknown;
            el("chat-stop").disabled=!connected || !busy;
            el("chat-new").disabled=!connected || sending || modelSaving;
            el("chat-takeover").hidden=!(snapshot && snapshot.owned);
            el("chat-takeover").textContent=takeover ? "Take control on next message ✓" : "Take control for this chat";
            el("chat-target").textContent=(el("chat-comp").value==="follow" ? "Following: " : "Pinned: ")+label();
        }
        function request(action, extra) {
            var g=generation, project=JSON.parse(projectIdentity(state)),descriptor=client.descriptor, credential=store.state.credential;
            return api.request(descriptor,credential,"/chat",Object.assign({action:action,project:project},extra || {}),30000).then(function(r){
                if(g!==generation || descriptor!==client.descriptor || credential!==store.state.credential)throw {code:"stale_project",message:"Project changed; response belongs to the previous conversation"};
                if(!r || !r.result || typeof r.result!=="object")throw {code:"invalid_response",message:"Invalid chat response"};
                return r.result;
            });
        }
        function node(tag, text, className) {
            var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;
        }
        function modelKey(m) { return JSON.stringify([m.providerID,m.id]); }
        function drawModels() {
            if(modelSaving)return;
            var current=snapshot && snapshot.model,key=JSON.stringify([catalog,current]);
            if(key===catalogKey)return;catalogKey=key;
            var picker=el("chat-model");picker.textContent="";
            var blank=node("option","CookieMonster default");blank.value="";blank.disabled=true;picker.appendChild(blank);
            catalog.forEach(function(m){var option=node("option",m.name+" · "+m.provider);option.value=modelKey(m);picker.appendChild(option);});
            if(current && !catalog.some(function(m){return modelKey(m)===modelKey(current);})){var missing=node("option",current.id+" · Unavailable");missing.value=modelKey(current);missing.disabled=true;picker.appendChild(missing);}
            picker.value=current ? modelKey(current) : "";
            drawReasoning(current && current.variant || "default");
        }
        function drawReasoning(value) {
            var picker=el("chat-reasoning"),model=catalog.filter(function(m){return modelKey(m)===el("chat-model").value;})[0];
            picker.textContent="";var standard=node("option",model && !model.variants.length ? "Model default" : "Default");standard.value="default";picker.appendChild(standard);
            (model && model.variants || []).filter(function(v){return v!=="default";}).forEach(function(v){var option=node("option",v);option.value=v;picker.appendChild(option);});
            if(value!=="default" && (!model || model.variants.indexOf(value)<0)){var missing=node("option",value+" · Unavailable");missing.value=value;missing.disabled=true;picker.appendChild(missing);}
            picker.value=value;
        }
        function refreshModels() {
            if(catalogLoading || state.connection!=="connected" || !state.project)return Promise.resolve();
            catalogLoading=true;var g=generation;controls();
            return request("models",{directory:el("chat-workspace").value || undefined}).then(function(data){
                if(g!==generation)return;catalog=data.models || [];catalogAt=Date.now();modelError=data.needsWorkspace ? "Choose a CM workspace to load models" : catalog.length ? "" : "No connected models. Configure a provider in CookieMonster.";drawModels();
            },function(e){if(g===generation){modelError=e.message || "Models unavailable";catalog=[];catalogKey="";drawModels();catalogAt=Date.now();}}).then(function(){catalogLoading=false;controls();});
        }
        function saveModel() {
            var model=catalog.filter(function(m){return modelKey(m)===el("chat-model").value;})[0];
            if(!model || modelSaving)return;
            var g=generation;modelRevision++;modelSaving=true;modelError="";controls();
            request("model",{directory:el("chat-workspace").value || undefined,model:{id:model.id,providerID:model.providerID,variant:el("chat-reasoning").value}}).then(function(data){
                if(g===generation){if(!snapshot)snapshot={status:"idle"};snapshot.model=data.model;}
            },function(e){if(g===generation)modelError=e.message || "Could not save model; refresh to confirm the current selection";}).then(function(){
                modelSaving=false;catalogKey="";drawModels();controls();refresh();
            });
        }
        el("chat-model").addEventListener("change",function(){drawReasoning("default");saveModel();});
        el("chat-reasoning").addEventListener("change",saveModel);
        el("chat-workspace").addEventListener("change",function(){catalogAt=0;refreshModels();});
        function drawAttachments() {
            var box=el("chat-attachments");box.textContent="";
            attachments.forEach(function(a){
                var row=node("div",undefined,"chat-reference");
                if(a.url && a.mime.indexOf("image/")===0){var img=node("img");img.src=a.url;img.alt=a.filename;row.appendChild(img);}
                row.appendChild(node("span",a.filename+(a.url ? "" : " · Reading…")));
                var remove=node("button","×");remove.type="button";remove.setAttribute("aria-label","Remove "+a.filename);remove.disabled=sending || deliveryUnknown;
                remove.addEventListener("click",function(){attachments=attachments.filter(function(item){return item!==a;});drawAttachments();controls();});
                row.appendChild(remove);box.appendChild(row);
            });
        }
        function addFiles(files) {
            if(sending || deliveryUnknown || !state.project)return;
            var g=generation;
            Array.prototype.forEach.call(files,function(file){
                var extension=file.name.split(".").pop().toLowerCase(),mime={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",pdf:"application/pdf",txt:"text/plain",md:"text/plain"}[extension];
                if(!mime){error({message:"Use PNG, JPEG, WebP, PDF, TXT or Markdown references."});return;}
                if(attachments.length>=4 || !file.size || file.size+attachments.reduce(function(n,a){return n+a.size;},0)>2*1024*1024){error({message:"Attach up to four non-empty files, 2 MB total."});return;}
                var a={filename:file.name,mime:mime,size:file.size},reader=new FileReader();attachments.push(a);
                reader.onload=function(){if(g!==generation || attachments.indexOf(a)<0)return;a.url="data:"+mime+";base64,"+String(reader.result).split(",")[1];drawAttachments();controls();};
                reader.onerror=function(){if(g!==generation || attachments.indexOf(a)<0)return;attachments=attachments.filter(function(item){return item!==a;});error({message:"Could not read "+file.name});drawAttachments();controls();};
                reader.readAsDataURL(file);
            });
            drawAttachments();controls();
        }
        el("chat-attach").addEventListener("click",function(){el("chat-files").click();});
        el("chat-files").addEventListener("change",function(){addFiles(this.files);this.value="";});
        el("chat-form").addEventListener("dragover",function(e){e.preventDefault();});
        el("chat-form").addEventListener("drop",function(e){e.preventDefault();if(e.dataTransfer)addFiles(e.dataTransfer.files);});
        el("chat-input").addEventListener("paste",function(e){
            var files=e.clipboardData && e.clipboardData.files;
            if(files && files.length){e.preventDefault();addFiles(files);}
        });
        function draw(data) {
            snapshot=data;
            if(!sending && (data.delivery==="unknown" || data.delivery==="sending"))deliveryUnknown=true;
            el("chat-progress").textContent=data.status==="idle" ? "Ready" : "CookieMonster is working…";
            if(data.error || el("chat-error").textContent===serverError)el("chat-error").textContent=data.error || "";
            serverError=data.error || "";
            var key=JSON.stringify(data.messages || []);
            if(key!==messagesKey) {
                messagesKey=key;var box=el("chat-messages"),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
                box.textContent="";
                (data.messages || []).forEach(function(message){
                    var row=node("article",undefined,"chat-message "+(message.role==="user" ? "from-user" : "from-assistant"));
                    row.appendChild(node("h3",message.role==="user" ? "You" : "CookieMonster"));
                    (message.parts || []).forEach(function(part){
                        if(part.type==="image" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.url)) {
                            var img=node("img");img.src=part.url;img.alt=part.filename || "Composition frame";row.appendChild(img);
                        } else if(part.type==="text" || part.type==="tool")row.appendChild(node("div",part.text,part.type==="tool" ? "chat-tool" : "chat-text"));
                    });
                    if(message.error)row.appendChild(node("p",message.error,"chat-failure"));
                    box.appendChild(row);
                });
                if(!data.messages || !data.messages.length)box.appendChild(node("p","Ask about this composition, or choose another comp above. Your conversation stays with the project.","chat-empty"));
                if(nearBottom)box.scrollTop=box.scrollHeight;
            }
            var approvals=JSON.stringify(data.permissions || []);
            if(approvals!==approvalsKey) {
                approvalsKey=approvals;el("chat-approvals").textContent="";
                (data.permissions || []).forEach(function(permission){
                    var row=node("section",undefined,"chat-approval");row.appendChild(node("h3",permission.title));
                    row.appendChild(node("pre",permission.details));
                    ["once","reject"].forEach(function(response){
                        var button=node("button",response==="once" ? "Approve once" : "Reject");button.type="button";
                        if(response==="once" && permission.reviewable===false)button.disabled=true;
                        button.addEventListener("click",function(){
                            button.disabled=true;
                            request("permission",{permissionId:permission.id,response:response}).then(refresh,error).then(function(){button.disabled=false;});
                        });row.appendChild(button);
                    });el("chat-approvals").appendChild(row);
                });
            }
            var dirs=data.workspaces || [],select=el("chat-workspace"),old=select.value;
            if(JSON.stringify(dirs)!==select.workspaceKey) {
                select.workspaceKey=JSON.stringify(dirs);select.textContent="";
                if(dirs.length>1){var blank=node("option","Choose a CM workspace");blank.value="";select.appendChild(blank);}
                dirs.forEach(function(dir){var option=node("option",dir);option.value=dir;select.appendChild(option);});
                if(data.directory || dirs.indexOf(old)>=0)select.value=data.directory || old;
            }
            select.hidden=!!data.sessionID || dirs.length<=1;
            drawModels();
            controls();
        }
        function refresh() {
            if(polling || modelSaving || state.connection!=="connected" || !state.project)return Promise.resolve();
            polling=true;var g=generation, revision=modelRevision;
            return request("state").then(function(data){if(g===generation && revision===modelRevision){if(el("chat-error").textContent===refreshError)el("chat-error").textContent="";refreshError="";draw(data);if(Date.now()-catalogAt>15000)return refreshModels();}},function(e){if(g===generation){error(e);refreshError=el("chat-error").textContent;}}).then(function(){polling=false;});
        }
        el("chat-form").addEventListener("submit",function(e){
            e.preventDefault();if(el("chat-send").disabled)return;
            var text=el("chat-input").value.trim(),g=generation;
            sending=true;drawAttachments();el("chat-error").textContent="";controls();
            request("send",{text:text,attachments:attachments.map(function(a){return {filename:a.filename,mime:a.mime,url:a.url};}),requestId:api.requestId(),compId:selected(),directory:el("chat-workspace").value || undefined,takeover:takeover}).then(function(data){
                if(g!==generation)return;
                if(data.delivery!=="accepted"){deliveryUnknown=true;throw {code:"delivery_unknown",message:"Delivery is uncertain. Check the conversation before resending."};}
                el("chat-input").value="";attachments=[];drawAttachments();takeover=false;
                return refresh();
            }).catch(function(e){if(g===generation){if(!e.code || ["timeout","disconnected","invalid_response","ECONNRESET","ETIMEDOUT"].indexOf(e.code)>=0){deliveryUnknown=true;error({message:"Delivery is uncertain. Check this conversation in CookieMonster before starting a new chat."});}else error(e);}}).then(function(){sending=false;drawAttachments();controls();});
        });
        el("chat-input").addEventListener("input",controls);
        el("chat-input").addEventListener("keydown",function(e){if(e.key==="Enter" && !e.shiftKey){e.preventDefault();if(!el("chat-send").disabled)el("chat-send").click();}});
        el("chat-comp").addEventListener("change",function(){
            var saved=pins(),key=pinKey();
            if(key.length<=256){delete saved[key];saved[key]=el("chat-comp").value;Object.keys(saved).slice(0,-20).forEach(function(k){delete saved[k];});store.save();}
            controls();
        });
        el("chat-mention").addEventListener("click",function(){if(selected()){el("chat-input").value+="@"+label()+" ";el("chat-input").focus();controls();}});
        el("chat-takeover").addEventListener("click",function(){takeover=!takeover;controls();});
        el("chat-stop").addEventListener("click",function(){request("stop").then(refresh,error);});
        el("chat-new").addEventListener("click",function(){
            request("new",{directory:el("chat-workspace").value || undefined}).then(function(){messagesKey="";approvalsKey="";deliveryUnknown=false;attachments=[];drawAttachments();el("chat-input").value="";return refresh();},error);
        });
        function update(s) {
            state=s;var key=projectIdentity(s);
            if(s.connection!=="connected")el("chat-progress").textContent="Connecting to CookieMonster…";
            if(key!==projectKey) {
                projectKey=key;generation++;attachments=[];deliveryUnknown=false;drawAttachments();snapshot=null;takeover=false;messagesKey="";approvalsKey="";compKey="";serverError="";
                catalog=[];catalogKey="";catalogAt=0;modelError="";drawModels();
                el("chat-messages").textContent="";el("chat-approvals").textContent="";el("chat-error").textContent="";el("chat-input").value="";
                el("chat-project-name").textContent=s.project && s.project.path ? s.project.path.split(/[\\/]/).pop() : "Unsaved project";
            }
            var list=JSON.stringify(s.compositions || []);
            if(list!==compKey) {
                compKey=list;var picker=el("chat-comp"),value=pins()[pinKey()] || "follow";picker.textContent="";
                var follow=node("option","Follow active composition");follow.value="follow";picker.appendChild(follow);
                (s.compositions || []).forEach(function(c){var option=node("option",c.name+" (#"+c.id+")");option.value=String(c.id);picker.appendChild(option);});
                if(value!=="follow" && !(s.compositions || []).some(function(c){return String(c.id)===value;})) {
                    var missing=node("option","Missing composition #"+value);missing.value=value;picker.appendChild(missing);
                }
                picker.value=value;
            }
            controls();
        }
        timer=setInterval(refresh,1000);
        window.addEventListener("beforeunload",function(){clearInterval(timer);});
        update(state);refresh();return {update:update};
    };
}());
