/* CEP-compatible presentation. All chat requests use the authenticated Node transport. */
(function () {
    "use strict";
    window.CookieMonsterChat = function (client, store, api) {
        function el(id) { return document.getElementById(id); }
        var state=client.state, projectKey="", generation=0, polling=false, sending=false, timer,
            messagesKey="", approvalsKey="", compKey="", snapshot=null, takeover=false, serverError="";
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
            var connected=state.connection==="connected", busy=sending || snapshot && snapshot.status!=="idle";
            el("chat-send").disabled=!connected || !!busy || state.uncertain || !el("chat-input").value.trim();
            el("chat-stop").disabled=!connected || !busy;
            el("chat-new").disabled=!connected || sending;
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
        function draw(data) {
            snapshot=data;
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
                        if(part.type==="image" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(part.url)) {
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
            controls();
        }
        function refresh() {
            if(polling || state.connection!=="connected" || !state.project)return Promise.resolve();
            polling=true;var g=generation;
            return request("state").then(function(data){if(g===generation)draw(data);},function(e){if(g===generation)error(e);}).then(function(){polling=false;});
        }
        el("chat-form").addEventListener("submit",function(e){
            e.preventDefault();if(el("chat-send").disabled)return;
            var text=el("chat-input").value.trim(),g=generation;
            sending=true;el("chat-error").textContent="";controls();
            request("send",{text:text,requestId:api.requestId(),compId:selected(),directory:el("chat-workspace").value || undefined,takeover:takeover}).then(function(data){
                if(g!==generation)return;
                if(data.delivery!=="accepted")throw {code:"delivery_unknown",message:"Delivery is uncertain. Check the conversation before resending."};
                el("chat-input").value="";takeover=false;
                return refresh();
            }).catch(function(e){if(g===generation)error(e);}).then(function(){sending=false;controls();});
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
            request("new",{directory:el("chat-workspace").value || undefined}).then(function(){messagesKey="";approvalsKey="";return refresh();},error);
        });
        function update(s) {
            state=s;var key=projectIdentity(s);
            if(s.connection!=="connected")el("chat-progress").textContent="Connecting to CookieMonster…";
            if(key!==projectKey) {
                projectKey=key;generation++;snapshot=null;takeover=false;messagesKey="";approvalsKey="";compKey="";serverError="";
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
