(function(){
    "use strict";
    window.CookieJarRender=function(client,api,bind){
        var context=client.context(),ticket=null,done=null,polling=false,listKey="",epoch=0,approval=null;
        function el(id){return document.getElementById(id);}
        function node(tag,text){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
        function message(text){el("render-status").textContent=text;}
        function failed(e){message((e.code || "render_error")+": "+e.message+". No automatic retry.");}
        function clear(){ticket=null;approval=null;done=null;client.renderWorking=false;el("render-review").hidden=true;}
        function controls(){
            var blocked=client.renderWorking || client.state.connection!=="connected" || client.state.uncertain || client.state.busy || !!client.state.lock;
            ["render-comp","render-settings","render-output","render-start","render-end","render-path","render-templates","render-submit","render-refresh"].forEach(function(id){el(id).disabled=!!blocked;});
            el("render-submit").disabled=blocked || !el("render-settings").value || !el("render-output").value;
        }
        function options(id,values){var select=el(id);select.textContent="";values.forEach(function(v){var o=node("option",v);o.value=v;select.appendChild(o);});}
        function accept(state){
            if(!state || ["running","approval","completed","failed"].indexOf(state.status)<0)throw {code:"invalid_response",message:"Invalid render operation state"};
            ticket=state.token;approval=state.approval;el("render-review").hidden=!approval;
            if(approval){el("render-review-text").textContent=approval.summary;message("Review "+approval.permission);}
            else if(state.status==="running")message("Working… Keep AE available. No automatic retry.");
            if(state.status==="failed"){clear();failed(state.error || {message:"Operation failed"});}
            if(state.status==="completed"){var finish=done;clear();message("Operation completed.");if(finish)finish(state.result);}
            controls();client.emit();
        }
        function start(tool,args,finish,alreadyBound){
            if(client.renderWorking)return;
            var g=epoch,project=JSON.stringify(client.state.project);
            Promise.resolve().then(function(){return alreadyBound ? null : bind();}).then(function(){
                if(project!==JSON.stringify(client.state.project))throw {code:"stale_project",message:"Project changed"};g=epoch;
                context=client.context();client.renderWorking=true;done=finish;controls();client.emit();
                return client.panel("render.start",{tool:tool,args:args});
            }).then(function(state){if(g===epoch)accept(state);}).catch(function(e){if(g===epoch){clear();failed(e);controls();client.emit();}});
        }
        function refresh(){
            if(client.renderWorking)return;
            var scope=client.context();
            bind().then(function(){scope=client.context();return client.panel("renders",{});}).then(function(jobs){
                if(scope!==client.context())return;
                var box=el("render-job-list");box.textContent="";
                if(!jobs.length)box.appendChild(node("p","No render jobs for this project and session."));
                jobs.forEach(function(job){
                    var row=node("section"), label=node("p",job.jobId+" · "+job.state+(job.recoverable ? " · Detached" : ""));row.appendChild(label);
                    function button(title,tool,callback){var b=node("button",title);b.type="button";b.addEventListener("click",function(){start(tool,{jobId:job.jobId},callback,true);});row.appendChild(b);}
                    if(job.recoverable)button("Review recovery…","ae_render_recover",refresh);
                    else {
                        button("Status","ae_render_status",function(result){label.textContent=job.jobId+" · "+result.state+(result.progress ? " · "+JSON.stringify(result.progress) : "");});
                        if(["completed","failed","cancelled","unknown"].indexOf(job.state)<0)button("Review cancellation…","ae_render_cancel",refresh);
                        if(job.state==="completed")button("Verify outputs","ae_render_result",function(result){
                            if(!result.verified || result.state!=="completed")throw {code:"unverified_output",message:"No verified completed outputs"};
                            (result.outputs || []).forEach(function(file){var link=node("button","Show output: "+file.path);link.type="button";link.addEventListener("click",function(){api.revealRenderOutput(file).catch(failed);});row.appendChild(link);});
                        });
                    }
                    box.appendChild(row);
                });
            }).catch(failed);
        }
        el("render-templates").addEventListener("click",function(){start("ae_templates",{compId:Number(el("render-comp").value)},function(result){options("render-settings",result.renderSettings);options("render-output",result.outputModules);controls();});});
        el("render-comp").addEventListener("change",function(){options("render-settings",[]);options("render-output",[]);controls();});
        el("render-submit").addEventListener("click",function(){
            var args={compId:Number(el("render-comp").value),startFrame:Number(el("render-start").value),endFrame:Number(el("render-end").value),renderSettings:el("render-settings").value,outputModule:el("render-output").value,outputPath:el("render-path").value.trim()};
            if(!Number.isSafeInteger(args.startFrame) || !Number.isSafeInteger(args.endFrame) || args.startFrame<0 || args.endFrame<args.startFrame){failed({message:"Choose a valid inclusive frame range"});return;}
            var directory;try{directory=api.renderDirectory(args.outputPath);}catch(e){failed(e);return;}
            start("ae_grant",{path:directory,recursive:true,write:true},function(){start("ae_render_submit",args,function(result){message("Submitted "+result.jobId+". Later live edits are excluded.");refresh();},true);});
        });
        ["render-approve","render-deny"].forEach(function(id){el(id).addEventListener("click",function(){
            if(!ticket || !approval)return;
            var g=epoch,args={token:ticket,approvalID:approval.id,allow:id==="render-approve"};approval=null;el("render-review").hidden=true;
            client.panel("render.reply",args).catch(function(e){if(g===epoch){failed(e);}});
        });});
        el("render-refresh").addEventListener("click",refresh);
        var timer=setInterval(function(){
            if(!ticket || polling || client.panelPending || client.state.connection!=="connected")return;
            polling=true;var g=epoch;
            client.panel("render.poll",{token:ticket}).then(function(state){if(g===epoch)accept(state);}).catch(function(e){if(g===epoch){clear();failed(e);controls();}}).then(function(){polling=false;});
        },1000);
        window.addEventListener("beforeunload",function(){clearInterval(timer);});
        return {update:function(state){
            if(context!==client.context()){epoch++;context=client.context();clear();el("render-job-list").textContent="";options("render-settings",[]);options("render-output",[]);message("Project or binding changed. Refresh jobs; interrupted operations are not retried.");}
            var comps=state.compositions || [],key=JSON.stringify(comps.map(function(c){return [c.id,c.name];}));
            if(key!==listKey){listKey=key;var selected=el("render-comp").value;el("render-comp").textContent="";comps.forEach(function(c){var o=node("option",c.name+" (#"+c.id+")");o.value=String(c.id);el("render-comp").appendChild(o);});if(comps.some(function(c){return String(c.id)===selected;}))el("render-comp").value=selected;}
            controls();
        }};
    };
}());
