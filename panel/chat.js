/* CEP-compatible presentation. All chat requests use the authenticated Node transport. */
(function () {
    "use strict";
    window.CookieMonsterChat = function (client, store, api) {
        function el(id) { return document.getElementById(id); }
        var state=client.state, projectKey="", generation=0, polling=false, sending=false, timer,
            messagesKey="", approvalsKey="", compKey="", snapshot=null, takeover=false, serverError="", attachments=[], deliveryUnknown=false, refreshError="",
            catalog=[], catalogKey="", catalogAt=0, catalogLoading=false, modelSaving=false, modelError="", modelRevision=0,
            checkpointList=[], checkpointButtons=[], checkpointAt=0, checkpointLoading=false, restoreWorking=false, restoreReview=null,
            collapseState={}, collapseSession="", historyMessages=[], historyCursor=null, historyLoaded=false, historyLoading=false;
        var skills=[], skillChoice=null, skillContext=null, skillLoading=false, skillEpoch=0,
            technique=null, techniqueReview=null, techniqueBusy=false;
        var conversationLoading=false, conversationSwitching=false, conversationEpoch=0, conversationOffset=0,
            conversationNext=null, conversationRows=[], renameConversation=null;
        function switchBlocked() {
            return state.connection!=="connected" || sending || modelSaving || techniqueBusy || !!technique || restoreWorking || !!restoreReview ||
                conversationSwitching || deliveryUnknown || !!client.panelPending || state.busy || state.uncertain || !!state.lock ||
                !!(snapshot && (snapshot.status!=="idle" || snapshot.owned || snapshot.restore && ["pending","unconfirmed"].indexOf(snapshot.restore.status)>=0));
        }
        function conversationControls() {
            var blocked=switchBlocked();
            conversationRows.forEach(function(row){row.open.disabled=blocked || conversationLoading || row.unavailable;row.rename.disabled=row.open.disabled;});
            el("chat-conversations-prev").disabled=conversationLoading || conversationSwitching || conversationOffset===0 || state.connection!=="connected";
            el("chat-conversations-next").disabled=conversationLoading || conversationSwitching || conversationNext===null || state.connection!=="connected";
            el("chat-conversation-save").disabled=blocked || conversationLoading;
            el("chat-conversations-search-button").disabled=conversationSwitching || state.connection!=="connected";
            el("chat-conversations-close").disabled=conversationSwitching;
            if(state.connection!=="connected" && !el("chat-conversations").hidden)el("chat-conversations-status").textContent="Connect to CookieMonster to browse conversations.";
        }
        function loadConversations(offset) {
            var epoch=++conversationEpoch,g=generation;
            conversationOffset=offset;conversationLoading=true;renameConversation=null;el("chat-conversation-rename").hidden=true;
            el("chat-conversations-status").textContent="Loading conversations...";conversationControls();
            request("conversations",{search:el("chat-conversations-search").value,offset:offset}).then(function(data){
                if(g!==generation || epoch!==conversationEpoch)return;
                if(data.total && offset>=data.total){loadConversations(Math.floor((data.total-1)/10)*10);return;}
                conversationNext=data.nextOffset===undefined ? null : data.nextOffset;conversationRows=[];
                var list=el("chat-conversations-list");list.textContent="";
                (data.conversations || []).forEach(function(item){
                    var row=node("div",undefined,"chat-conversation-row"),buttons=node("div",undefined,"buttons"),open=node("button","Open"),rename=node("button","Rename");
                    open.type=rename.type="button";row.appendChild(node("strong",item.title));
                    row.appendChild(node("p",item.missing ? "Deleted in CookieMonster" : item.unavailable ? item.unavailableReason || "Open this workspace in CookieMonster" : "Last activity: "+new Date(item.updatedAt).toLocaleString()));
                    row.appendChild(node("p",item.directory));
                    if(snapshot && snapshot.sessionID===item.sessionID)row.appendChild(node("p","Current conversation"));
                    open.addEventListener("click",function(){if(!open.disabled)changeConversation("reopen",item);});
                    rename.addEventListener("click",function(){if(rename.disabled)return;renameConversation=item;el("chat-conversation-title").value=item.title;el("chat-conversation-rename").hidden=false;el("chat-conversation-title").focus();});
                    buttons.appendChild(open);buttons.appendChild(rename);row.appendChild(buttons);list.appendChild(row);
                    conversationRows.push({open:open,rename:rename,unavailable:item.missing || item.unavailable});
                });
                el("chat-conversations-status").textContent=data.total ? (offset+1)+"–"+Math.min(offset+10,data.total)+" of "+data.total+(switchBlocked() ? ". Finish work or recovery before switching." : "") : "No conversations found for this project.";
            },function(e){if(g===generation && epoch===conversationEpoch){el("chat-conversations-list").textContent="";conversationRows=[];conversationNext=null;el("chat-conversations-status").textContent=e.message || "Conversations unavailable";}}).then(function(){if(epoch===conversationEpoch){conversationLoading=false;conversationControls();}});
        }
        function closeConversations() { if(conversationSwitching)return;conversationEpoch++;conversationLoading=false;el("chat-conversations").hidden=true;el("chat-conversations-open").focus(); }
        function applyTarget(id) {
            var picker=el("chat-comp"),value=id===null ? "follow" : String(id);
            if(value!=="follow" && !(state.compositions || []).some(function(c){return String(c.id)===value;})){
                var option=node("option","Missing composition #"+value);option.value=value;picker.appendChild(option);
            }
            picker.value=value;pins()[pinKey()]=value;store.save();
        }
        function changeConversation(action,item) {
            if(switchBlocked())return;
            conversationSwitching=true;generation++;conversationEpoch++;polling=false;controls();
            var g=generation;
            request(action,item ? {sessionID:item.sessionID,directory:item.directory} : {directory:el("chat-workspace").value || undefined}).then(function(data){
                if(g!==generation)return;
                clearSkills();snapshot={sessionID:data.sessionID,status:"loading"};messagesKey="";approvalsKey="";collapseSession="";historyMessages=[];historyLoaded=false;historyCursor=null;
                historyLoading=false;catalogLoading=false;checkpointLoading=false;checkpointAt=0;catalogAt=0;checkpointList=[];
                deliveryUnknown=false;attachments=[];drawAttachments();el("chat-input").value="";el("chat-messages").textContent="";el("chat-approvals").textContent="";
                el("chat-error").textContent="";el("chat-conversations").hidden=true;applyTarget(data.targetCompId===undefined ? null : data.targetCompId);
            },function(e){if(g===generation){error(e);el("chat-conversations-status").textContent=e.message || "Could not open conversation";}}).then(function(){
                if(g!==generation)return;conversationSwitching=false;controls();refresh();
            });
        }
        el("chat-conversations-open").addEventListener("click",function(){el("chat-conversations").hidden=false;el("chat-conversations-search").focus();loadConversations(0);});
        el("chat-conversations-close").addEventListener("click",closeConversations);
        el("chat-conversations-search-button").addEventListener("click",function(){loadConversations(0);});
        el("chat-conversations-search").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();loadConversations(0);}});
        el("chat-conversations-prev").addEventListener("click",function(){loadConversations(Math.max(0,conversationOffset-10));});
        el("chat-conversations-next").addEventListener("click",function(){if(conversationNext!==null)loadConversations(conversationNext);});
        el("chat-conversation-cancel").addEventListener("click",function(){renameConversation=null;el("chat-conversation-rename").hidden=true;el("chat-conversations-search").focus();});
        el("chat-conversation-rename").addEventListener("submit",function(e){
            e.preventDefault();if(!renameConversation || switchBlocked() || conversationLoading)return;
            var item=renameConversation,g=generation;conversationSwitching=true;controls();
            request("rename",{sessionID:item.sessionID,directory:item.directory,title:el("chat-conversation-title").value}).then(function(){
                if(g===generation){renameConversation=null;el("chat-conversation-rename").hidden=true;el("chat-conversations-search").focus();}
            },function(e){if(g===generation)el("chat-conversations-status").textContent=(e.message || "Rename not confirmed")+". Refresh the list before trying again.";}).then(function(){
                if(g===generation){conversationSwitching=false;controls();if(!renameConversation)loadConversations(conversationOffset);refresh();}
            });
        });
        el("chat-conversations").addEventListener("keydown",function(e){
            if(e.key==="Escape"){e.preventDefault();closeConversations();return;}
            if(e.key!=="Tab")return;
            var fields=Array.prototype.filter.call(el("chat-conversations").querySelectorAll("button,input"),function(field){return !field.disabled && field.offsetParent!==null;});
            if(!fields.length){e.preventDefault();return;}
            if(e.shiftKey && document.activeElement===fields[0]){e.preventDefault();fields[fields.length-1].focus();}
            else if(!e.shiftKey && document.activeElement===fields[fields.length-1]){e.preventDefault();fields[0].focus();}
        });
        function clearSkills() {
            skillEpoch++;skills=[];skillChoice=null;skillContext=null;skillLoading=false;
            technique=null;techniqueReview=null;el("chat-technique").hidden=true;
            el("chat-skill-status").textContent="";el("chat-skill-workspace").textContent="";
            el("chat-skill-search").value="";drawSkills();
        }
        function drawSkills() {
            var picker=el("chat-skill-picker"),query=el("chat-skill-search").value.toLowerCase();picker.textContent="";
            var blank=node("option","No skill selected");blank.value="";picker.appendChild(blank);
            skills.forEach(function(s,i){
                if(s!==skillChoice && (s.name+" "+(s.description || "")).toLowerCase().indexOf(query)<0)return;
                var option=node("option",s.name+(s.description ? " - "+s.description : ""));option.value=String(i);picker.appendChild(option);
            });
            picker.value=skillChoice ? String(skills.indexOf(skillChoice)) : "";
        }
        function refreshSkills() {
            if(skillLoading || !state.project || state.connection!=="connected")return;
            var g=generation,epoch=++skillEpoch;skillLoading=true;
            el("chat-skill-status").textContent="Loading fresh skill metadata...";
            request("skills",{directory:el("chat-workspace").value || undefined}).then(function(data){
                if(g!==generation || epoch!==skillEpoch)return;
                skills=data.skills || [];skillContext={directory:data.directory,sessionID:data.sessionID};
                if(skillChoice){
                    var found=skills.filter(function(s){return s.name===skillChoice.name && s.source===skillChoice.source && s.revision===skillChoice.revision;})[0];
                    skillChoice=found || null;el("chat-skill-status").textContent=found ? "Selected: "+found.name+" (not loaded)" : "Selected skill is missing or changed. Select it again.";
                }else el("chat-skill-status").textContent=skills.length ? "Select a skill for the next message." : "No skills available.";
                el("chat-skill-workspace").textContent="CM workspace: "+data.directory+". Skills are not isolated per .aep.";
                drawSkills();
            },function(e){if(g===generation && epoch===skillEpoch){skills=[];skillChoice=null;skillContext=null;drawSkills();el("chat-skill-status").textContent=e.message || "Skills unavailable";}}).then(function(){if(epoch===skillEpoch)skillLoading=false;controls();});
        }
        function draftTechnique(message) {
            if(techniqueBusy || !snapshot || !snapshot.sessionID || !message.completed || message.error)return;
            var text=(message.parts || []).filter(function(p){return p.type==="text";}).map(function(p){return p.text;}).join("\n\n");
            if(!text.trim() || text.length>64000){error({message:"Choose a completed reply with at most 64000 characters."});return;}
            technique={sessionID:snapshot.sessionID,directory:snapshot.directory};techniqueReview=null;
            el("technique-name").value="";el("technique-description").value="";el("technique-instructions").value=text;
            el("technique-scope").value="workspace";el("technique-workspace").textContent="This CM workspace: "+(snapshot.directory || "Choose a workspace");
            el("technique-status").textContent="Draft only. Review all fields before saving.";
            el("technique-review").textContent="";el("technique-confirm").hidden=true;el("chat-technique").hidden=false;
            el("technique-name").focus();controls();
        }
        function techniqueDraft() { return {name:el("technique-name").value,description:el("technique-description").value,
            instructions:el("technique-instructions").value,scope:el("technique-scope").value}; }
        ["technique-name","technique-description","technique-instructions","technique-scope"].forEach(function(id){
            el(id).addEventListener(id==="technique-scope" ? "change" : "input",function(){techniqueReview=null;el("technique-confirm").hidden=true;el("technique-review").textContent="";});
        });
        el("technique-cancel").addEventListener("click",function(){if(techniqueBusy)return;technique=null;techniqueReview=null;el("chat-technique").hidden=true;controls();el("chat-input").focus();});
        el("chat-technique").addEventListener("keydown",function(e){
            if(e.key==="Escape"){e.preventDefault();if(!techniqueBusy)el("technique-cancel").click();return;}
            if(e.key!=="Tab")return;
            var fields=["technique-name","technique-description","technique-instructions","technique-scope","technique-review-button","technique-confirm","technique-cancel"].map(el).filter(function(field){return !field.disabled && !field.hidden;});
            if(!fields.length){e.preventDefault();return;}
            if(e.shiftKey && document.activeElement===fields[0]){e.preventDefault();fields[fields.length-1].focus();}
            else if(!e.shiftKey && document.activeElement===fields[fields.length-1]){e.preventDefault();fields[0].focus();}
        });
        el("technique-review-button").addEventListener("click",function(){
            if(!technique || techniqueBusy)return;
            var current=technique,draft=techniqueDraft(),g=generation;techniqueBusy=true;controls();
            request("skillReview",{draft:draft,sessionID:current.sessionID,directory:el("chat-workspace").value || current.directory}).then(function(review){
                if(g!==generation || current!==technique || JSON.stringify(draft)!==JSON.stringify(techniqueDraft()))return;
                techniqueReview={token:review.token,draft:draft,directory:review.directory};
                el("technique-review").textContent="Create "+review.destination+"\nScope: "+(draft.scope==="workspace" ? "This CM workspace" : "Global CM skills")+"\nName: "+draft.name+"\nDescription: "+draft.description+"\n\n"+draft.instructions;
                el("technique-status").textContent="Confirm this exact content and destination. Existing files will not be overwritten.";
                el("technique-confirm").hidden=false;
            },function(e){if(g===generation)el("technique-status").textContent=e.message || "Review failed";}).then(function(){techniqueBusy=false;controls();});
        });
        el("technique-confirm").addEventListener("click",function(){
            if(!technique || !techniqueReview || techniqueBusy)return;
            var current=technique,review=techniqueReview,g=generation;
            if(JSON.stringify(review.draft)!==JSON.stringify(techniqueDraft()))return;
            techniqueReview=null;techniqueBusy=true;el("technique-confirm").hidden=true;controls();
            request("skillSave",{draft:review.draft,token:review.token,sessionID:current.sessionID,directory:review.directory}).then(function(receipt){
                if(g!==generation || technique!==current)return;
                el("technique-status").textContent="Saved: "+receipt.destination;technique=null;
                el("chat-technique").hidden=true;el("chat-skill-status").textContent="Saved: "+receipt.name;refreshSkills();el("chat-input").focus();
            },function(e){if(g===generation)el("technique-status").textContent=(e.message || "Save not confirmed")+". No automatic retry.";}).then(function(){techniqueBusy=false;controls();});
        });
        el("chat-skill-search").addEventListener("input",drawSkills);
        el("chat-skills-refresh").addEventListener("click",refreshSkills);
        el("chat-skills").addEventListener("toggle",function(){if(this.open)refreshSkills();});
        el("chat-skill-picker").addEventListener("change",function(){
            skillChoice=this.value==="" ? null : skills[Number(this.value)] || null;
            el("chat-skill-status").textContent=skillChoice ? "Selected: "+skillChoice.name+" (not loaded)" : "No skill selected";
        });
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
            var connected=state.connection==="connected", busy=conversationSwitching || sending || modelSaving || techniqueBusy || !!technique || restoreWorking || !!restoreReview || snapshot && snapshot.status!=="idle";
            var restoring=snapshot && snapshot.restore && ["pending","unconfirmed"].indexOf(snapshot.restore.status)>=0;
            var restoreBlocked=!connected || !!busy || !!restoring || !!client.panelPending || state.busy || state.uncertain || !!state.lock || deliveryUnknown || !!(snapshot && snapshot.owned) || !!(state.binding && state.binding.sessionID!==(snapshot && snapshot.sessionID));
            el("chat-skill-picker").disabled=!connected || !!busy || skillLoading;
            el("chat-skills-refresh").disabled=!connected || !!busy || skillLoading;
            el("technique-review-button").disabled=techniqueBusy || !connected;
            el("technique-confirm").disabled=techniqueBusy || !connected;
            el("technique-cancel").disabled=techniqueBusy;
            ["technique-name","technique-description","technique-instructions","technique-scope"].forEach(function(id){el(id).disabled=techniqueBusy;});
            el("chat-checkpoints-toggle").disabled=restoreWorking || !!restoreReview;
            el("chat-checkpoint-picker").disabled=checkpointLoading || !checkpointList.length || restoreBlocked;
            el("chat-checkpoint-review").disabled=checkpointLoading || restoreBlocked || !checkpointList.some(function(c){return c.id===el("chat-checkpoint-picker").value;});
            el("chat-checkpoint-help").textContent=checkpointLoading ? "Loading checkpoints…" : !connected ? "Connect to load this project's checkpoints." : !snapshot || !snapshot.sessionID ? "Start a conversation to see this project's checkpoints." : !checkpointList.length ? "No checkpoints yet. A checkpoint is saved before an edit runs." : restoreBlocked ? "Restoring is unavailable while work or recovery is in progress. Finish or stop the current task first." : "Restores the whole project. You can review and cancel before anything changes.";
            checkpointButtons.forEach(function(item){
                var available=checkpointList.some(function(c){return c.id===item.id;});
                item.button.disabled=!available || !connected || !!busy || !!restoring || !!client.panelPending || state.busy || state.uncertain || !!state.lock || !!(snapshot && snapshot.owned) || !!(state.binding && state.binding.sessionID!==(snapshot && snapshot.sessionID));
                item.status.textContent=available ? "Saved state before this edit. Verified again when you review Restore." : "Checkpoint unavailable or not loaded for this project.";
                item.button.title=available ? "Restore project to before this request" : "No checkpoint available for this request";
            });
            el("chat-model").disabled=!connected || !!busy || deliveryUnknown || !catalog.length;
            el("chat-reasoning").disabled=el("chat-model").disabled || !el("chat-model").value || el("chat-reasoning").children.length<=1;
            el("chat-model-status").textContent=!connected ? "Connect to CookieMonster to choose a model" : modelSaving ? "Saving model…" : modelError;
            el("chat-send").disabled=!connected || !!busy || !!restoring || !!(snapshot && snapshot.missing) || state.uncertain || deliveryUnknown || attachments.some(function(a){return !a.url;}) || !el("chat-input").value.trim();
            el("chat-attach").disabled=!!busy || deliveryUnknown;
            el("chat-input").disabled=!!sending || deliveryUnknown;
            el("chat-stop").disabled=!connected || restoreWorking || !!restoreReview || !busy;
            el("chat-new").disabled=!!switchBlocked();
            el("chat-conversations-open").disabled=conversationSwitching || !!technique || restoreWorking || !!restoreReview;
            conversationControls();
            el("chat-takeover").hidden=!(snapshot && snapshot.owned);
            el("chat-takeover").textContent=takeover ? "Take control on next message ✓" : "Take control for this chat";
            el("chat-target").textContent=(el("chat-comp").value==="follow" ? "Following: " : "Pinned: ")+label();
        }
        function request(action, extra) {
            var g=generation, project=JSON.parse(projectIdentity(state)),descriptor=client.descriptor, credential=store.state.credential;
            var expected=["send","new","reopen","rename","model","bind","history","stop","permission"].indexOf(action)>=0 ? {expectedSessionID:snapshot && snapshot.sessionID || null} : {};
            return api.request(descriptor,credential,"/chat",Object.assign({action:action,project:project},expected,extra || {}),30000).then(function(r){
                if(g!==generation || descriptor!==client.descriptor || credential!==store.state.credential)throw {code:"stale_project",message:"Project changed; response belongs to the previous conversation"};
                if(!r || !r.result || typeof r.result!=="object")throw {code:"invalid_response",message:"Invalid chat response"};
                return r.result;
            });
        }
        function node(tag, text, className) {
            var e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;
        }
        function restoreNotice(text) { el("chat-restore-status").textContent=text;el("chat-restore-status").hidden=!text; }
        function cancelRestore() { restoreReview=null;client.restoreApproval=null;el("chat-restore-review").hidden=true;controls(); }
        function reviewRestore(id) {
            el("advanced").open=false;
            var g=generation;restoreWorking=true;controls();
            request("bind").then(function(){return client.heartbeat();}).then(function(){
                if(g!==generation)throw {message:"Project changed; review the restore again"};
                return client.panel("checkpoint.restore.propose",{id:id});
            }).then(function(result){
                if(g!==generation || !client.restoreApproval)return;
                restoreReview=client.restoreApproval;el("chat-restore-operation").textContent=result.operation;
                el("chat-restore-review").hidden=false;el("chat-restore-cancel").focus();
            },function(e){
                if(g===generation)error(e.code==="restore_unsupported" ?
                    {message:"Chat restore requires matching compact-restore support in the bridge and AE host. Nothing was changed. Update the matching integration before reviewing again; no full-scene fallback will run."} :
                    e.code==="response_too_large" || e.code==="payload_too_large" ? {message:"Restore review exceeded its response limit. Nothing was changed. Your checkpoint is still available; use After Effects to open a copy manually."} : e);
            }).then(function(){restoreWorking=false;controls();});
        }
        function refreshCheckpoints() {
            if(checkpointLoading || restoreWorking || restoreReview || !snapshot || !snapshot.sessionID)return Promise.resolve();
            var g=generation;checkpointLoading=true;controls();
            return request("checkpoints").then(function(data){if(g===generation){checkpointList=data.checkpoints || [];checkpointAt=Date.now();drawCheckpoints();}},function(e){if(g===generation){checkpointList=[];checkpointAt=Date.now();drawCheckpoints();error({message:"Could not load checkpoints. Close and reopen Restore checkpoint to try again. "+(e.message || "")});}}).then(function(){checkpointLoading=false;controls();});
        }
        // Port CookieMonster's controlled disclosure state: streaming rerenders
        // must not override a user's choice. Native details replaces Solid/Kobalte.
        function disclosure(key, title, expanded) {
            var box=node("details",undefined,"chat-disclosure"),summary=node("summary",title);
            box.open=Object.prototype.hasOwnProperty.call(collapseState,key) ? collapseState[key] : expanded;
            summary.addEventListener("click",function(e){e.preventDefault();box.open=!box.open;collapseState[key]=box.open;saveCollapse();});
            box.appendChild(summary);return box;
        }
        function saveCollapse() {
            try {
                var keys=Object.keys(collapseState);keys.slice(0,Math.max(0,keys.length-500)).forEach(function(k){delete collapseState[k];});
                window.localStorage.setItem("cookiejar-collapse:"+projectKey+":"+collapseSession,JSON.stringify(collapseState));
            }catch(e){/* Disclosure state is optional; storage errors must not block editing. */}
        }
        function loadCollapse() {
            collapseState={};
            try { var raw=window.localStorage.getItem("cookiejar-collapse:"+projectKey+":"+collapseSession),saved=raw && raw.length<64000 ? JSON.parse(raw) : {};
                Object.keys(saved || {}).slice(-500).forEach(function(k){if(typeof saved[k]==="boolean")collapseState[k]=saved[k];});
            }catch(e){}
        }
        function formatted(part) {
            var box=node("div",undefined,"chat-text chat-markdown"),count=0;
            function append(parent,items,depth){
                (items || []).forEach(function(item){
                    if(++count>6000 || depth>20 || !item || typeof item!=="object")return;
                    var allowed=["p","h1","h2","h3","h4","h5","h6","strong","em","del","code","pre","blockquote","ol","ul","li","br","hr","span","table","thead","tbody","tr","th","td"];
                    var child=node(allowed.indexOf(item.tag)>=0 ? item.tag : "span",typeof item.text==="string" ? item.text : undefined);
                    if(Array.isArray(item.children))append(child,item.children,depth+1);parent.appendChild(child);
                });
            }
            if(Array.isArray(part.markdown))append(box,part.markdown,0);else box.textContent=part.text;
            return box;
        }
        el("chat-history").addEventListener("click",function(){
            if(historyLoading || !historyCursor || !snapshot)return;
            var g=generation,session=snapshot.sessionID,box=el("chat-messages"),height=box.scrollHeight,top=box.scrollTop;
            historyLoading=true;this.disabled=true;this.textContent="Loading history…";
            request("history",{before:historyCursor}).then(function(page){
                if(g!==generation || session!==page.sessionID || !snapshot || snapshot.sessionID!==session)return;
                historyMessages=(page.messages || []).concat(historyMessages);historyCursor=page.nextCursor;historyLoaded=true;
                draw(snapshot);box.scrollTop=top+box.scrollHeight-height;
            },function(e){if(g===generation)error(e);}).then(function(){historyLoading=false;el("chat-history").disabled=false;el("chat-history").textContent="Load earlier messages";});
        });
        function drawCheckpoints() {
            var picker=el("chat-checkpoint-picker"),previous=picker.value;picker.textContent="";
            var list=checkpointList.slice().sort(function(a,b){return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));});
            if(!list.length){var empty=node("option","No checkpoints available");empty.value="";picker.appendChild(empty);}
            list.forEach(function(c,index){
                var date=new Date(c.createdAt),label=isNaN(date.getTime()) ? "Checkpoint "+c.id : date.toLocaleString()+" · "+c.id.slice(0,8);
                var option=node("option",(index===0 ? "Latest · " : "")+label);option.value=c.id;picker.appendChild(option);
            });
            picker.value=list.some(function(c){return c.id===previous;}) ? previous : list.length ? list[0].id : "";
        }
        el("chat-checkpoints-toggle").addEventListener("click",function(){
            if(this.disabled)return;
            var open=el("chat-checkpoints").hidden;el("chat-checkpoints").hidden=!open;
            this.setAttribute("aria-expanded",String(open));
            if(open){drawCheckpoints();controls();refreshCheckpoints();}
        });
        el("chat-checkpoint-picker").addEventListener("change",controls);
        el("chat-checkpoint-review").addEventListener("click",function(){if(!this.disabled)reviewRestore(el("chat-checkpoint-picker").value);});
        el("chat-restore-cancel").addEventListener("click",cancelRestore);
        el("chat-restore-confirm").addEventListener("click",function(){
            if(restoreWorking || !restoreReview || restoreReview!==client.restoreApproval)return;
            restoreWorking=true;restoreReview=null;el("chat-restore-review").hidden=true;
            restoreNotice("Saving your current work and restoring the project…");controls();client.start();
            client.confirmRestore().then(function(r){
                restoreNotice((r.recoveryCopy ? "A recovery copy was opened. Review it in AE and save it to the intended location before continuing. " : "Project restored. Earlier chat messages describe historical states. ")+
                    "Your previous work is preserved in checkpoint "+r.currentCheckpointId+". Backup: "+r.emergencyPath+". "+r.warning);
            },function(e){restoreNotice("Restore was not confirmed. Check After Effects and retain the backup files. It will not retry automatically. "+(e.message || ""));}).then(function(){restoreWorking=false;checkpointAt=0;controls();refresh();});
        });
        function modelKey(m) { return JSON.stringify([m.providerID,m.id]); }
        function drawModels() {
            if(modelSaving)return;
            var current=snapshot && snapshot.model,key=JSON.stringify([catalog,current]);
            if(key===catalogKey)return;catalogKey=key;
            var picker=el("chat-model");picker.textContent="";
            var blank=node("option","CookieMonster default");blank.value="";blank.disabled=true;picker.appendChild(blank);
            catalog.forEach(function(m){var option=node("option",m.name);option.title=m.provider;option.value=modelKey(m);picker.appendChild(option);});
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
        el("chat-workspace").addEventListener("change",function(){clearSkills();catalogAt=0;refreshModels();if(el("chat-skills").open)refreshSkills();});
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
            if(snapshot && (snapshot.sessionID!==data.sessionID || snapshot.directory!==data.directory))clearSkills();
            snapshot=data;
            el("chat-title").textContent=data.title || "";
            if(collapseSession!==data.sessionID && data.targetCompId!==undefined)applyTarget(data.targetCompId);
            if(collapseSession!==data.sessionID){collapseSession=data.sessionID;loadCollapse();messagesKey="";historyMessages=[];historyLoaded=false;historyCursor=null;}
            if(!historyLoaded)historyCursor=data.nextCursor || null;
            var combined=historyMessages.concat(data.messages || []),seen={},merged=[];
            for(var mi=combined.length-1;mi>=0;mi--){var msg=combined[mi];if(msg.id && seen["id:"+msg.id])continue;if(msg.id)seen["id:"+msg.id]=true;merged.unshift(msg);}
            if(historyLoaded){historyMessages=merged.filter(function(m){return !!m.id;});data=Object.assign({},data,{messages:merged});}
            el("chat-history").hidden=!historyCursor;
            if(!restoreWorking && data.restore)restoreNotice(data.restore.status==="completed" ?
                (data.restore.recoveryCopy ? "Recovery copy opened. " : "Project restored. ")+"Earlier messages are history. Your previous work is preserved in checkpoint "+data.restore.currentCheckpointId+". "+(data.restore.warning || "") :
                data.restore.status==="reconciled" ? "Recovery was reviewed. A restore was not confirmed; earlier messages remain history. You can continue from the inspected project state." :
                data.restore.status==="pending" ? "Restore is in progress or was interrupted. Wait for After Effects; it will not retry automatically." :
                "The last restore was not confirmed. Inspect AE and retain its backups before starting a new chat. No edits will replay automatically."+(data.restore.emergencyPath ? " Backup: "+data.restore.emergencyPath : ""));
            if(!sending && (data.delivery==="unknown" || data.delivery==="sending"))deliveryUnknown=true;
            el("chat-progress").textContent=data.status==="idle" ? "Ready" : "CookieMonster is working…";
            if(data.error || el("chat-error").textContent===serverError)el("chat-error").textContent=data.error || "";
            serverError=data.error || "";
            var key=JSON.stringify([data.messages || [],data.status]);
            if(key!==messagesKey) {
                messagesKey=key;var box=el("chat-messages"),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
                box.textContent="";checkpointButtons=[];
                var users=(data.messages || []).filter(function(m){return m.role==="user";}),oldUsers=users.slice(0,-2).map(function(m){return m.id;}),turnBox=null;
                var requestCheckpoints={};
                (data.messages || []).forEach(function(message){
                    if(message.role!=="assistant" || !message.parentID)return;
                    (message.parts || []).forEach(function(part){
                        var key="request:"+message.parentID;
                        if(part.type==="checkpoint" && !requestCheckpoints[key])requestCheckpoints[key]=part.id;
                    });
                });
                (data.messages || []).forEach(function(message,messageIndex){
                    if(message.role==="user"){
                        turnBox=null;
                        if(message.id && oldUsers.indexOf(message.id)>=0){
                            var title=(message.parts || []).filter(function(p){return p.type==="text";}).map(function(p){return p.text;}).join(" ").slice(0,100);
                            turnBox=disclosure("turn:"+message.id,title || "Earlier exchange",false);turnBox.className+=" chat-turn";box.appendChild(turnBox);
                        }
                    }
                    var row=node("article",undefined,"chat-message "+(message.role==="user" ? "from-user" : "from-assistant"));
                    row.appendChild(node("h3",message.role==="user" ? "You" : "CookieMonster"));
                    var content=row;
                    if(message.role==="user"){content=node("div",undefined,"chat-user-bubble");row.appendChild(content);}
                    var messageKey="message:"+(message.id || messageIndex),activity=null;
                    (message.parts || []).forEach(function(part,partIndex){
                        var partKey=messageKey+":"+(part.id || partIndex);
                        if(part.type==="image" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.url)) {
                            var imageBox=disclosure(partKey,"Image · "+(part.filename || "Composition frame"),false);
                            var img=node("img");img.src=part.url;img.alt=part.filename || "Composition frame";imageBox.appendChild(img);content.appendChild(imageBox);
                        } else if(part.type==="skill") {
                            content.appendChild(node("p","Loaded skill: "+part.name,"chat-skill-loaded"));
                        } else if(part.type==="checkpoint") {
                            var card=node("section",undefined,"chat-checkpoint");card.appendChild(node("strong",part.label));
                            var status=node("p"),button=node("button","Restore…");button.type="button";
                            button.addEventListener("click",function(){if(!button.disabled)reviewRestore(part.id);});
                            checkpointButtons.push({id:part.id,status:status,button:button});card.appendChild(status);card.appendChild(button);row.appendChild(card);
                        } else if(part.type==="tool" || part.type==="reasoning"){
                            if(!activity){activity=disclosure(messageKey+":activity",!message.completed && data.status!=="idle" ? "Working…" : "Activity",!message.completed && data.status!=="idle");content.appendChild(activity);}
                            if(part.type==="reasoning")activity.appendChild(node("h4","Reasoning"));
                            activity.appendChild(part.type==="tool" ? node("div",part.text,"chat-tool") : formatted(part));
                        } else if(part.type==="text"){
                            var text=formatted(part);
                            if(part.text.length>1200 || part.text.split("\n").length>12){
                                var longText=disclosure(partKey,part.text.slice(0,180).replace(/\s+/g," ")+"…",false);longText.appendChild(text);content.appendChild(longText);
                            }else content.appendChild(text);
                        }
                    });
                    if(message.role==="user"){
                        var checkpointId=requestCheckpoints["request:"+message.id] || "";
                        var footer=node("div",undefined,"chat-message-actions"),restore=node("button","↶","chat-message-restore"),hint=node("span",undefined,"sr-only");
                        restore.type="button";restore.setAttribute("aria-label","Restore project to before this request");
                        restore.addEventListener("click",function(){if(!restore.disabled && checkpointId)reviewRestore(checkpointId);});
                        checkpointButtons.push({id:checkpointId,status:hint,button:restore});
                        footer.appendChild(hint);footer.appendChild(restore);row.appendChild(footer);
                    }
                    if(message.role==="assistant" && message.completed && !message.error && (message.parts || []).some(function(p){return p.type==="text" && p.text.trim();})){
                        var saveTechnique=node("button","Save technique...");saveTechnique.type="button";
                        saveTechnique.addEventListener("click",function(){draftTechnique(message);});row.appendChild(saveTechnique);
                    }
                    if(message.error)row.appendChild(node("p",message.error,"chat-failure"));
                    (turnBox || box).appendChild(row);
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
                var blank=node("option","Choose a CM workspace");blank.value="";select.appendChild(blank);
                dirs.forEach(function(dir){var option=node("option",dir);option.value=dir;select.appendChild(option);});
                if(data.directory && data.workspaceConfirmed)select.value=data.directory;
                else if(dirs.indexOf(old)>=0)select.value=old;
            }
            if(data.directory && data.workspaceConfirmed)select.value=data.directory;
            select.hidden=!!data.workspaceConfirmed || !dirs.length;
            select.disabled=!!data.sessionID;
            if(data.sessionID && !data.workspaceConfirmed)select.disabled=false;
            drawModels();
            controls();
        }
        function refresh() {
            if(polling || conversationSwitching || modelSaving || restoreWorking || state.connection!=="connected" || !state.project)return Promise.resolve();
            polling=true;var g=generation, revision=modelRevision;
            return request("state").then(function(data){if(g===generation && revision===modelRevision){if(el("chat-error").textContent===refreshError)el("chat-error").textContent="";refreshError="";draw(data);return Promise.all([Date.now()-catalogAt>15000 ? refreshModels() : null,Date.now()-checkpointAt>10000 ? refreshCheckpoints() : null]);}}).catch(function(e){if(g===generation){messagesKey="";error(e);refreshError=el("chat-error").textContent;}}).then(function(){polling=false;});
        }
        el("chat-form").addEventListener("submit",function(e){
            e.preventDefault();if(el("chat-send").disabled)return;
            var text=el("chat-input").value.trim(),g=generation;
            sending=true;drawAttachments();el("chat-error").textContent="";controls();
            request("send",{text:text,skill:skillChoice && skillContext ? {name:skillChoice.name,source:skillChoice.source,revision:skillChoice.revision,directory:skillContext.directory,sessionID:skillContext.sessionID} : undefined,attachments:attachments.map(function(a){return {filename:a.filename,mime:a.mime,url:a.url};}),requestId:api.requestId(),compId:selected(),directory:el("chat-workspace").value || undefined,takeover:takeover}).then(function(data){
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
            changeConversation("new");
        });
        function update(s) {
            state=s;var key=projectIdentity(s);
            if(restoreReview && restoreReview!==client.restoreApproval)cancelRestore();
            if(s.connection!=="connected")el("chat-progress").textContent="Connecting to CookieMonster…";
            if(key!==projectKey) {
                conversationEpoch++;conversationLoading=false;conversationSwitching=false;conversationRows=[];el("chat-conversations").hidden=true;el("chat-conversations-list").textContent="";el("chat-title").textContent="";
                clearSkills();el("chat-workspace").value="";el("chat-workspace").workspaceKey="";projectKey=key;generation++;attachments=[];deliveryUnknown=false;drawAttachments();snapshot=null;takeover=false;messagesKey="";approvalsKey="";compKey="";serverError="";collapseState={};collapseSession="";
                catalog=[];catalogKey="";catalogAt=0;modelError="";drawModels();
                checkpointList=[];checkpointButtons=[];checkpointAt=0;cancelRestore();if(!restoreWorking)restoreNotice("");
                drawCheckpoints();el("chat-checkpoints").hidden=true;el("chat-checkpoints-toggle").setAttribute("aria-expanded","false");
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
