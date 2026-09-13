/* CookieMonster AE: ES3. DEVELOPMENT UNQUALIFIED; native capture uses undocumented saveFrameToPng. */
var CookieMonsterAE = (function () {
    var LIMIT = 4 * 1024 * 1024, lastProject = null, unsaved = "", plan = null, busy = false, uncertain = false, transaction = null, recovery = null;
    var inspectionCursors = [], inspectionSerial = 0;
    var projectEpoch = "", projectSerial = 0;
    function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function array(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
    function keys(o) { var a = [], k; for (k in o) if (own(o, k)) a.push(k); return a.sort(); }
    function quote(s) {
        return '"' + s.replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (c) {
            var n = c.charCodeAt(0).toString(16);
            return "\\u" + ("0000" + n).slice(-4);
        }) + '"';
    }
    function stringify(v, depth) {
        var a = [], k, i; depth = depth || 0;
        if (depth > 80) fail("response_too_large", "JSON nesting exceeds safe limit");
        if (v === null) return "nu" + "ll";
        if (typeof v === "string") return quote(v);
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number" && isFinite(v)) return String(v);
        if (!v || typeof v !== "object") fail("unsupported_value", "Non-JSON host value");
        if (array(v)) { for (i = 0; i < v.length; i++) a.push(stringify(v[i], depth + 1)); return "[" + a.join(",") + "]"; }
        k = keys(v);
        for (i = 0; i < k.length; i++) a.push(quote(k[i]) + ":" + stringify(v[k[i]], depth + 1));
        return "{" + a.join(",") + "}";
    }
    // No eval-based JSON parser: transport strings cannot execute code.
    function parse(s) {
        var at = 0;
        function ws() { while (/\s/.test(s.charAt(at)) && at < s.length) at++; }
        function value(depth) {
            var c, out, key, m, n;
            if (depth > 64) fail("invalid_payload", "JSON nesting limit");
            ws(); c = s.charAt(at++);
            if (c === '"') {
                out = "";
                while (at < s.length) {
                    c = s.charAt(at++);
                    if (c === '"') return out;
                    if (c === "\\") {
                        c = s.charAt(at++);
                        if (c === "u") {
                            m = s.substr(at, 4); if (!/^[0-9a-fA-F]{4}$/.test(m)) break;
                            out += String.fromCharCode(parseInt(m, 16)); at += 4;
                        } else {
                            m = {'"':'"', "\\":"\\", "/":"/", b:"\b", f:"\f", n:"\n", r:"\r", t:"\t"};
                            if (!own(m, c)) break; out += m[c];
                        }
                    } else { if (c.charCodeAt(0) < 32) break; out += c; }
                }
            } else if (c === "[" || c === "{") {
                out = c === "[" ? [] : {}; ws();
                if (s.charAt(at) === (c === "[" ? "]" : "}")) { at++; return out; }
                while (at < s.length) {
                    if (c === "[") out.push(value(depth + 1));
                    else {
                        ws(); if (s.charAt(at) !== '"') break;
                        key = value(depth + 1); ws();
                        if (s.charAt(at++) !== ":" || key === "__proto__" || key === "constructor" || key === "prototype" || own(out, key)) break;
                        out[key] = value(depth + 1);
                    }
                    ws(); n = s.charAt(at++);
                    if (n === (c === "[" ? "]" : "}")) return out;
                    if (n !== ",") break;
                }
            } else {
                at--; m = /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(s.substr(at));
                if (m) {
                    at += m[0].length;
                    if (m[0] === "true") return true;
                    if (m[0] === "false") return false;
                    if (m[0] === "nu" + "ll") return null;
                    n = Number(m[0]); if (isFinite(n)) return n;
                }
            }
            fail("invalid_payload", "Invalid JSON");
        }
        if (typeof s !== "string" || s.length > LIMIT) fail("invalid_payload", "Request size limit");
        var result = value(0); ws(); if (at !== s.length) fail("invalid_payload", "Trailing JSON data"); return result;
    }
    function object(v, allowed, required) {
        var k, i;
        if (!v || typeof v !== "object" || array(v)) fail("invalid_payload", "Expected object");
        k = keys(v); allowed = (" " + allowed + " ");
        for (i = 0; i < k.length; i++) if (allowed.indexOf(" " + k[i] + " ") < 0) fail("invalid_payload", "Unknown field: " + k[i]);
        k = (required || "").split(" ");
        for (i = 0; i < k.length; i++) if (k[i] && !own(v, k[i])) fail("invalid_payload", "Missing field: " + k[i]);
    }
    function str(v, name, empty) { if (typeof v !== "string" || (!empty && !v.length) || v.length > 262144 || /\u0000/.test(v)) fail("invalid_payload", "Invalid " + name); return v; }
    function num(v, min, max, integer) { if (typeof v !== "number" || !isFinite(v) || v < min || v > max || (integer && Math.floor(v) !== v)) fail("invalid_payload", "Number outside supported range"); return v; }
    function bool(v) { if (typeof v !== "boolean") fail("invalid_payload", "Expected boolean"); return v; }
    function vec(v, n, min, max) { var i; if (!array(v) || v.length !== n) fail("invalid_payload", "Wrong value dimensions"); for (i = 0; i < n; i++) num(v[i], min, max); return v; }
    function id(v) { return num(v, 1, 2147483647, true); }
    function capability() {
        var enabled = false;
        try { enabled = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; } catch (e) {}
        return {fileNetwork: enabled};
    }
    function project() {
        var p = app.project, path = null;
        // AE throws even on equality comparison with a project handle invalidated by open/close.
        if (!isValid(lastProject) || p !== lastProject) {
            lastProject = p; unsaved = "unsaved:" + new Date().getTime() + ":" + Math.random(); plan = null;
            projectEpoch = "project:" + new Date().getTime() + ":" + (++projectSerial) + ":" + Math.random();
            inspectionCursors = [];
        }
        if (p && p.file) {
            var file = p.file;
            if (file.alias) { file = file.resolve(); if (!file) fail("unsafe_state", "Cannot resolve project alias"); }
            path = file.fsName;
        }
        return {id: path ? "path:" + hash(path) : unsaved, path: path, saved: !!path};
    }
    function ready(write) {
        var major = parseInt(app.version, 10);
        if (major !== 25 && major !== 26) fail("incompatible", "DEVELOPMENT UNQUALIFIED: only AE 25/26 are targeted");
        if (!app.project) fail("no_project", "Open a project");
        if (app.isWatchFolder || app.isRenderEngine || app.project.renderQueue.rendering) fail("busy", "AE is rendering or watching a folder");
        if (uncertain && write) fail("uncertain_outcome", "Host recovery is required");
        if (write && !project().saved) fail("unsaved_project", "Save the project manually before mutation");
    }
    function requireFiles() { if (!capability().fileNetwork) fail("preference_disabled", "Enable Allow Scripts to Write Files and Access Network in Scripting & Expressions preferences"); }
    function item(target, kind, refs) {
        var i, p, r;
        if (target && typeof target === "object") {
            object(target, "$ref", "$ref"); str(target.$ref, "$ref");
            r = refs && own(refs,target.$ref) ? refs[target.$ref] : null;
            if (!r || r.deleted || r.kind === "layer" || (kind && r.kind !== kind)) fail("invalid_reference", "Reference must be created earlier with the correct kind");
            return r.object || r;
        }
        id(target);
        for (i = 1; i <= app.project.numItems; i++) {
            p = app.project.item(i);
            if (p.id === target) {
                if (kind === "comp" && !(p instanceof CompItem)) fail("invalid_target", "Target is not a composition");
                if (kind === "folder" && !(p instanceof FolderItem)) fail("invalid_target", "Target is not a folder");
                return p;
            }
        }
        fail("stale_target", "Project item no longer exists");
    }
    function layer(c, target, refs) {
        var i, r;
        if (target && typeof target === "object") {
            object(target, "$ref", "$ref"); r = refs && own(refs,target.$ref) ? refs[target.$ref] : null;
            if (!r || r.deleted || r.kind !== "layer" || r.comp !== c) fail("invalid_reference", "Layer reference belongs to another composition or is not yet created");
            return r.object || r;
        }
        id(target);
        if (c.virtual) fail("invalid_target", "Existing layer cannot belong to a new composition");
        for (i = 1; i <= c.numLayers; i++) if (c.layer(i).id === target) return c.layer(i);
        fail("stale_target", "Layer no longer exists");
    }
    function effects() {
        var a = [], i, e;
        if (!app.effects) fail("unsupported_capability", "Installed effect catalog unavailable");
        for (i = 0; i < app.effects.length; i++) { e = app.effects[i]; a.push({matchName: String(e.matchName), displayName: String(e.displayName), category: String(e.category), version: String(e.version)}); }
        a.sort(function (a, b) { return a.matchName < b.matchName ? -1 : (a.matchName > b.matchName ? 1 : 0); }); return a;
    }
    function installed(match) { var i; for (i = 0; i < app.effects.length; i++) if (app.effects[i].matchName === match) return app.effects[i]; return null; }
    function children(p, isLayer) {
        var a = [], i, q, seen = {}, named = ["ADBE Transform Group", "ADBE Marker", "ADBE Time Remapping", "ADBE Text Properties", "ADBE Root Vectors Group", "ADBE Camera Options Group", "ADBE Light Options Group", "ADBE Material Options Group", "ADBE Audio Group", "ADBE Layer Styles", "ADBE Layer Overrides"];
        for (i = 1; i <= p.numProperties; i++) { q = p.property(i); if (q) { a.push({p:q, index:i}); seen[q.matchName] = true; } }
        if (isLayer) for (i = 0; i < named.length; i++) if (!own(seen, named[i])) {
            q = p.property(named[i]); if (q) a.push({p:q, index:0});
        }
        return a;
    }
    function hash(s) { var a = 2166136261, b = 5381, i; for (i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a += (a << 1) + (a << 4) + (a << 7) + (a << 8) + (a << 24); b = ((b << 5) + b) ^ s.charCodeAt(i); } return (a >>> 0).toString(16) + "-" + (b >>> 0).toString(16); }
    function plainValue(v, type) {
        var i, o, fields;
        if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
        if (array(v)) { o = []; for (i = 0; i < v.length; i++) o.push(plainValue(v[i])); return o; }
        if (type === PropertyValueType.SHAPE) {
            fields = "vertices inTangents outTangents closed featherSegLocs featherRelSegLocs featherRadii featherInterps featherTensions featherTypes featherRelCornerAngles".split(" ");
        } else if (type === PropertyValueType.MARKER) {
            fields = "comment chapter cuePointName duration eventCuePoint frameTarget url label protectedRegion".split(" ");
        } else if (type === PropertyValueType.TEXT_DOCUMENT) {
            // TextDocument has version-dependent, mixed-style values. revision is required as an additional stale guard.
            fields = "text font fontSize applyFill fillColor applyStroke strokeColor strokeWidth justification tracking leading autoLeading baselineShift horizontalScale verticalScale".split(" ");
        } else fail("unsupported_value", "Host value is not safely inspectable");
        o = {};
        for (i = 0; i < fields.length; i++) {
            try { if (typeof v[fields[i]] !== "undefined") o[fields[i]] = plainValue(v[fields[i]]); } catch (e) { o[fields[i]] = {unavailable:true}; }
        }
        if (type === PropertyValueType.MARKER) o.parameters = v.getParameters();
        if (type === PropertyValueType.TEXT_DOCUMENT) o.mixedStyleRevisionGuard = true;
        return o;
    }
    function ease(a) { var r = [], i; for (i = 0; i < a.length; i++) r.push({speed:a[i].speed, influence:a[i].influence}); return r; }
    function keyData(p, k) {
        var o = {time:p.keyTime(k), value:plainValue(p.keyValue(k), p.propertyValueType)};
        if (p.propertyValueType !== PropertyValueType.MARKER) {
            o.inType = String(p.keyInInterpolationType(k)); o.outType = String(p.keyOutInterpolationType(k));
            o.inEase = ease(p.keyInTemporalEase(k)); o.outEase = ease(p.keyOutTemporalEase(k));
            o.temporalContinuous = p.keyTemporalContinuous(k); o.temporalAutoBezier = p.keyTemporalAutoBezier(k);
            o.label = p.keyLabel(k);
            if (p.isSpatial) {
                o.inTangent = p.keyInSpatialTangent(k); o.outTangent = p.keyOutSpatialTangent(k);
                o.roving = p.keyRoving(k); o.spatialContinuous = p.keySpatialContinuous(k); o.spatialAutoBezier = p.keySpatialAutoBezier(k);
            }
        }
        return o;
    }
    function propertyTree(p, locator, state, depth) {
        if (++state.count > 25000 || depth > 32) fail("response_too_large", "Property snapshot limit; no partial snapshot returned");
        locator.revision=app.project.revision;
        var o = {locator:locator, matchName:p.matchName, name:p.name, propertyType:String(p.propertyType),selected:!!p.selected}, i, list, next;
        if (p.isEffect) { o.missing = !installed(p.matchName); o.enabled = p.enabled; o.version = o.missing ? null : String(installed(p.matchName).version); }
        if (p.propertyType === PropertyType.PROPERTY) {
            o.valueType = String(p.propertyValueType); o.units = p.unitsText || "";
            o.canSetExpression = !!p.canSetExpression; o.canVaryOverTime = !!p.canVaryOverTime;
            o.expression = p.canSetExpression ? p.expression : ""; o.expressionEnabled = p.canSetExpression ? p.expressionEnabled : false;
            o.expressionError = p.canSetExpression ? p.expressionError : "";
            o.separated = p.isSeparationLeader ? p.dimensionsSeparated : false;
            o.min = p.hasMin ? p.minValue : null; o.max = p.hasMax ? p.maxValue : null;
            o.keys = [];
            o.selectedKeys = p.selectedKeys ? p.selectedKeys.slice(0, state.shallow ? 100 : p.selectedKeys.length) : [];
            if(state.shallow)o.keyCount=p.numKeys;
            if (p.propertyValueType === PropertyValueType.NO_VALUE) o.value = null;
            else if (p.propertyValueType === PropertyValueType.CUSTOM_VALUE) { o.value = {opaque:true}; state.opaque = true; }
            else {
                o.value = plainValue(p.value, p.propertyValueType);
                o.baseValue = plainValue(p.valueAtTime(state.time, true), p.propertyValueType);
            }
            for (i = 1; !state.shallow && i <= p.numKeys; i++) {
                if (++state.count > 25000) fail("response_too_large", "Keyframe snapshot limit");
                o.keys.push(keyData(p, i));
            }
        } else {
            o.properties = []; if(state.shallow)return o; list = children(p, false);
            for (i = 0; i < list.length; i++) {
                next = {itemId:locator.itemId, layerId:locator.layerId, path:locator.path.concat([{index:list[i].index, matchName:list[i].p.matchName, name:list[i].p.name}])};
                o.properties.push(propertyTree(list[i].p, next, state, depth + 1));
            }
        }
        return o;
    }
    function inspect() {
        ready(false);
        var o = {project:project(), aeVersion:String(app.version), items:[], activeCompId:null, selection:[], capabilities:capability(), busy:busy, installedEffects:effects(), qualification:"DEVELOPMENT UNQUALIFIED", revision:app.project.revision}, i, j, k, p, l, it, ly, list, state = {count:0, opaque:false, time:0}, s;
        if (typeof o.revision !== "number") fail("unsupported_capability", "Project revision is required for opaque/mixed host state");
        if (app.project.activeItem instanceof CompItem) o.activeCompId = app.project.activeItem.id;
        for (i = 1; i <= app.project.numItems; i++) {
            if (++state.count > 25000) fail("response_too_large", "Item snapshot limit");
            p = app.project.item(i); it = {id:p.id, name:p.name, parentId:p.parentFolder ? p.parentFolder.id : null, selected:!!p.selected, kind:p instanceof CompItem ? "comp" : (p instanceof FolderItem ? "folder" : "footage")};
            if (p.selected) o.selection.push({itemId:p.id});
            if (p instanceof CompItem) {
                it.width=p.width; it.height=p.height; it.pixelAspect=p.pixelAspect; it.duration=p.duration; it.frameRate=p.frameRate; it.time=p.time; it.bgColor=p.bgColor; it.layers=[];
                state.time = p.time;
                if (p.markerProperty) it.markers = propertyTree(p.markerProperty, {itemId:p.id,layerId:null,path:[]}, state, 0);
                for (j = 1; j <= p.numLayers; j++) {
                    if (++state.count > 25000) fail("response_too_large", "Layer snapshot limit");
                    l = p.layer(j); id(l.id);
                    ly = {id:l.id, index:j, name:l.name, matchName:l.matchName, enabled:l.enabled, locked:l.locked, shy:l.shy, solo:l.solo, startTime:l.startTime, inPoint:l.inPoint, outPoint:l.outPoint, stretch:l.stretch, parentId:l.parent ? l.parent.id : null, sourceId:l.source ? l.source.id : null, properties:[], selected:!!l.selected};
                    if (typeof l.threeDLayer !== "undefined") ly.threeDLayer = l.threeDLayer;
                    list = children(l, true);
                    for (k = 0; k < list.length; k++) ly.properties.push(propertyTree(list[k].p, {itemId:p.id,layerId:l.id,path:[{index:list[k].index,matchName:list[k].p.matchName,name:list[k].p.name}]}, state, 0));
                    if (l.selected) o.selection.push({itemId:p.id,layerId:l.id});
                    it.layers.push(ly);
                }
            } else if (!(p instanceof FolderItem)) {
                it.file = p.file ? resolvedFile(p.file).fsName : null; it.missing = !!p.footageMissing;
                if(p.file){try{it.interpretation=parse(interpretation(p));}catch(interpretError){it.interpretation={unavailable:true};}}
            }
            o.items.push(it);
        }
        o.opaqueValuesRevisionGuard = state.opaque;
        s = stringify(o);
        if (s.length > LIMIT - 512) fail("response_too_large", "Complete snapshot exceeds 4 MiB; no metadata omitted");
        o.fingerprint = hash(s); return o;
    }
    function inspectQuery(q) {
        object(q,"compId layerId propertyPath depth cursor","");
        var depth=own(q,"depth") ? num(q.depth,0,8,true) : 1, query={}, k, i, c, l, p, step, actualPath=[], start=0, stack=[], saved=null;
        if(own(q,"compId"))id(q.compId);
        if(own(q,"layerId")){id(q.layerId);if(!own(q,"compId"))fail("invalid_payload","layerId requires compId");}
        if(own(q,"propertyPath")){
            if(!own(q,"layerId") || !array(q.propertyPath) || q.propertyPath.length>32)fail("invalid_payload","propertyPath requires a layer and at most 32 steps");
            for(i=0;i<q.propertyPath.length;i++){
                step=q.propertyPath[i];object(step,"index matchName name","index matchName");
                num(step.index,0,100000,true);str(step.matchName,"matchName");
                if(own(step,"name"))str(step.name,"name",true);
            }
        }
        for(k in q)if(own(q,k) && k!=="cursor")query[k]=q[k];
        query.depth=depth;
        var identity=project(), nativeProject=app.project, revision=num(app.project.revision,1,9007199254740991,true), signature=stringify(query);
        if(own(q,"cursor")){
            str(q.cursor,"cursor");
            for(i=0;i<inspectionCursors.length;i++)if(inspectionCursors[i].token===q.cursor)saved=inspectionCursors[i];
            if(!saved || saved.project!==nativeProject || saved.identity!==stringify(identity) || saved.revision!==revision || saved.query!==signature)
                fail("stale_cursor","Inspection cursor expired or project, revision or query changed");
            start=saved.start;
            for(i=0;i<saved.stack.length;i++){
                var copy={}, field;
                for(field in saved.stack[i])if(own(saved.stack[i],field))copy[field]=saved.stack[i][field];
                copy.seen=copy.seen ? parse(stringify(copy.seen)) : {};
                stack.push(copy);
            }
        }
        var o={project:identity,projectEpoch:projectEpoch,aeVersion:String(app.version),revision:revision,items:[],selection:[],installedEffects:[],capabilities:capability(),busy:busy,
            activeCompId:app.project.activeItem instanceof CompItem ? app.project.activeItem.id : null,qualification:"DEVELOPMENT UNQUALIFIED",nextCursor:null};
        function summary(v,isLayer,index) {
            var r={id:v.id,name:v.name,selected:!!v.selected};
            if(isLayer){
                r.index=index;r.matchName=v.matchName;r.enabled=v.enabled;r.locked=v.locked;r.sourceId=v.source ? v.source.id : null;
                r.parentId=v.parent ? v.parent.id : null;
                if(v.selected)o.selection.push({itemId:c.id,layerId:v.id});
            }else{
                r.kind=v instanceof CompItem ? "comp" : (v instanceof FolderItem ? "folder" : "footage");
                r.parentId=v.parentFolder ? v.parentFolder.id : null;
                if(v instanceof CompItem){r.width=v.width;r.height=v.height;r.pixelAspect=v.pixelAspect;r.duration=v.duration;r.frameRate=v.frameRate;r.time=v.time;r.layerCount=v.numLayers;}
                if(v.selected)o.selection.push({itemId:v.id});
            }
            return r;
        }
        function frame(v,path,level,isLayer){return {p:v,path:path,level:level,isLayer:isLayer,next:1,named:0,seen:{}};}
        var more=false, it, ly, row, state={count:0,opaque:false,time:0,shallow:true}, count=0;
        if(!own(q,"compId")){
            for(i=start+1;i<=app.project.numItems && i<=start+100;i++)o.items.push(summary(app.project.item(i),false,i));
            start=i-1;more=start<app.project.numItems;
        }else{
            c=item(q.compId,"comp");it=summary(c,false,0);o.items.push(it);it.layers=[];state.time=c.time;
            if(!own(q,"layerId")){
                for(i=start+1;i<=c.numLayers && i<=start+100;i++)it.layers.push(summary(c.layer(i),true,i));
                start=i-1;more=start<c.numLayers;
            }else{
                l=layer(c,q.layerId);p=l;
                for(i=0;i<(q.propertyPath || []).length;i++){
                    step=q.propertyPath[i];
                    var found=step.index ? p.property(step.index) : (i===0 ? p.property(step.matchName) : null);
                    if(!found || found.matchName!==step.matchName || (own(step,"name") && found.name!==step.name))
                        fail("stale_locator","Property index, matchName or name changed");
                    actualPath.push({index:step.index,matchName:found.matchName,name:found.name});p=found;
                }
                var layerIndex=1;while(layerIndex<=c.numLayers && c.layer(layerIndex)!==l)layerIndex++;
                ly=summary(l,true,layerIndex);ly.properties=[];it.layers.push(ly);
                // ponytail: flat preorder records keep page boundaries independent of tree shape; locators retain ancestry.
                o.propertyLayout="preorder";
                if(p!==l && p.propertyType===PropertyType.PROPERTY){
                    row=propertyTree(p,{itemId:c.id,layerId:l.id,path:actualPath},state,0);
                    for(i=start+1;i<=p.numKeys && i<=start+100;i++)row.keys.push(keyData(p,i));
                    row.keyOffset=start;start=i-1;more=start<p.numKeys;row.keysTruncated=more || row.keyOffset>0;ly.properties.push(row);
                }else{
                    if(!saved){
                        if(p!==l)stack.push({node:p,path:actualPath,level:0,seen:{}});
                        else if(depth>0)stack.push(frame(l,[],1,true));
                    }
                    var named=["ADBE Transform Group","ADBE Marker","ADBE Time Remapping","ADBE Text Properties","ADBE Root Vectors Group","ADBE Camera Options Group","ADBE Light Options Group","ADBE Material Options Group","ADBE Audio Group","ADBE Layer Styles","ADBE Layer Overrides"];
                    while(stack.length && count<100){
                        var top=stack[stack.length-1], child=null, index=0;
                        if(top.node){stack.pop();child=top.node;actualPath=top.path;}
                        else{
                            if(top.next<=top.p.numProperties){index=top.next++;child=top.p.property(index);if(child)top.seen[child.matchName]=true;}
                            else if(top.isLayer && top.named<named.length){
                                var match=named[top.named++];if(!own(top.seen,match))child=top.p.property(match);
                            }else{stack.pop();continue;}
                            if(!child)continue;
                            actualPath=top.path.concat([{index:index,matchName:child.matchName,name:child.name}]);
                        }
                        row=propertyTree(child,{itemId:c.id,layerId:l.id,path:actualPath},state,0);
                        if(child.propertyType===PropertyType.PROPERTY)row.keysTruncated=child.numKeys>0;
                        else{
                            row.childCount=child.numProperties;row.childrenTruncated=child.numProperties>0;
                            if(top.level<depth)stack.push(frame(child,actualPath,top.level+1,false));
                        }
                        ly.properties.push(row);count++;
                    }
                    more=stack.length>0;
                }
            }
        }
        if(app.project!==nativeProject || app.project.revision!==revision || stringify(project())!==stringify(identity))fail("stale_cursor","Project changed during inspection");
        if(more){
            var token="inspect:"+new Date().getTime()+":"+(++inspectionSerial)+":"+Math.random();
            inspectionCursors.push({token:token,project:nativeProject,identity:stringify(identity),revision:revision,query:signature,start:start,stack:stack});
            // ponytail: retain 64 recent continuations; older cursors explicitly expire rather than growing host memory.
            if(inspectionCursors.length>64)inspectionCursors.shift();
            o.nextCursor=token;
        }
        var encoded=stringify(o);if(encoded.length>LIMIT-512)fail("response_too_large","Inspection page exceeds 4 MiB; narrow the query");
        o.fingerprint=hash(encoded);return o;
    }
    function resolve(loc, pin, enableEffect) {
        object(loc, "itemId layerId path revision", "itemId layerId path revision");
        num(loc.revision,1,9007199254740991,true);
        if(loc.revision!==app.project.revision)fail("stale_locator","Project revision changed since locator was inspected");
        var c = item(loc.itemId, "comp"), p = layer(c, loc.layerId), i, step, list, found, j, signature, objects;
        if (!array(loc.path) || !loc.path.length || loc.path.length > 32) fail("invalid_locator", "Explicit hierarchical property path required");
        if (p.locked) fail("locked_layer", "Unlock layer manually before writing");
        for (i = 0; i < loc.path.length; i++) {
            step = loc.path[i]; object(step, "index matchName name", "index matchName name");
            num(step.index, 0, 100000, true); str(step.matchName, "matchName"); str(step.name, "name", true);
            list = children(p, i === 0); found = null; signature=[];objects=[];
            for (j = 0; j < list.length; j++) {
                signature.push({index:list[j].index,matchName:list[j].p.matchName,name:list[j].p.name,type:String(list[j].p.propertyType),valueType:String(list[j].p.propertyValueType)});
                objects.push(list[j].p);
                if (list[j].index === step.index && list[j].p.matchName === step.matchName && list[j].p.name === step.name) {
                    if (found) fail("ambiguous_locator", "Ambiguous named siblings"); found = list[j].p;
                }
            }
            if (!found) fail("stale_locator", "Property siblings changed; inspect and preflight again");
            if(pin)pin.push({parent:p,objects:objects,signature:stringify(signature)});
            p = found;
            if (p.isEffect && !installed(p.matchName)) fail("missing_effect", "Missing effects are preserved, never mutated");
            // Only explicit re-enable may reach a disabled final effect, never its descendants.
            if (p.isEffect && p.enabled !== true && !(enableEffect === true && i === loc.path.length - 1 &&
                p.enabled === false && p.parentProperty.matchName === "ADBE Effect Parade"))
                fail("disabled_effect", "Disabled effects and their stored properties are preserved");
        }
        return p;
    }
    function reacquire(loc, pin, enableEffect) {
        var c=item(loc.itemId,"comp"),p=layer(c,loc.layerId),i,j,list,signature,step=loc.path,found;
        if(!pin || pin.length!==step.length)fail("stale_locator","Missing execution pin");
        for(i=0;i<step.length;i++) {
            if(p!==pin[i].parent)fail("stale_locator","Property ancestor was replaced");
            list=children(p,i===0);signature=[];found=null;
            if(list.length!==pin[i].objects.length)fail("stale_locator","Property siblings were added or removed");
            for(j=0;j<list.length;j++) {
                // Exact live identity also distinguishes duplicate effects with identical match/display names.
                if(list[j].p!==pin[i].objects[j])fail("stale_locator","Property siblings were replaced or reordered");
                signature.push({index:list[j].index,matchName:list[j].p.matchName,name:list[j].p.name,type:String(list[j].p.propertyType),valueType:String(list[j].p.propertyValueType)});
                if(list[j].index===step[i].index && list[j].p.matchName===step[i].matchName && list[j].p.name===step[i].name)found=list[j].p;
            }
            if(!found || stringify(signature)!==pin[i].signature)fail("stale_locator","Property sibling metadata changed");
            p=found;
        }
        // Only this private execution proof can refresh a revision. Public resolution always checks it.
        var refreshed=parse(stringify(loc));refreshed.revision=app.project.revision;
        resolve(refreshed,null,enableEffect);
        return refreshed;
    }
    function preserve(l) {
        if (l.virtual) return;
        var group = l.property("ADBE Effect Parade"), i;
        if (group) for (i = 1; i <= group.numProperties; i++) {
            if (!installed(group.property(i).matchName)) fail("missing_effect", "Layer contains missing effects; destructive or layer-wide changes refused");
            if (group.property(i).enabled !== true) fail("disabled_effect", "Layer contains disabled effects; destructive or layer-wide changes refused");
        }
    }
    function time(t, c) { return num(t, 0, c.duration); }
    function dependsOn(source,target,edges,seen) {
        if(source===target)return true;
        var i,next,key=source.virtual ? source.refKey : String(source.id);
        if(seen[key])return false;
        seen[key]=true;
        if(!source.virtual && source instanceof CompItem)for(i=1;i<=source.numLayers;i++) {
            next=source.layer(i).source;
            if(next instanceof CompItem && dependsOn(next,target,edges,seen))return true;
        }
        for(i=0;i<edges.length;i++)if(edges[i].from===source && dependsOn(edges[i].to,target,edges,seen))return true;
        return false;
    }
    function keyAt(p, t, optional) { var i; for (i = 1; i <= p.numKeys; i++) if (Math.abs(p.keyTime(i) - t) < 0.0000001) return i; if (!optional) fail("stale_keyframe", "No keyframe at exact time"); return 0; }
    function propertyValue(p, v) {
        var t = p.propertyValueType, n = 0, i;
        if (p.isSeparationLeader && p.dimensionsSeparated) fail("unsupported_value", "Write separated followers instead");
        if (t === PropertyValueType.OneD) num(v, p.hasMin ? p.minValue : -1e12, p.hasMax ? p.maxValue : 1e12);
        else {
            if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) n = 2;
            if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) n = 3;
            if (t === PropertyValueType.COLOR) n = 4;
            if (n) vec(v, n, t === PropertyValueType.COLOR ? 0 : (p.hasMin ? p.minValue : -1e12), t === PropertyValueType.COLOR ? 1 : (p.hasMax ? p.maxValue : 1e12));
            else if (t === PropertyValueType.TEXT_DOCUMENT) { object(v, "text", "text"); str(v.text, "text", true); }
            else if (t === PropertyValueType.SHAPE) {
                object(v, "vertices inTangents outTangents closed", "vertices inTangents outTangents closed"); bool(v.closed);
                if (!array(v.vertices) || !v.vertices.length || !array(v.inTangents) || !array(v.outTangents) || v.vertices.length !== v.inTangents.length || v.vertices.length !== v.outTangents.length) fail("invalid_payload", "Shape tangent counts must match vertices");
                for (i=0;i<v.vertices.length;i++) { vec(v.vertices[i],2,-1e9,1e9); vec(v.inTangents[i],2,-1e9,1e9); vec(v.outTangents[i],2,-1e9,1e9); }
            } else fail("unsupported_value", "Only numeric, color, text and shape property writes are supported; index/custom values require a qualified adapter");
        }
        return v;
    }
    function nativeValue(p,v,t) {
        if (p.propertyValueType === PropertyValueType.TEXT_DOCUMENT) { var d=p.valueAtTime(t || 0,true); d.text=v.text; return d; }
        if (p.propertyValueType === PropertyValueType.SHAPE) { var s=new Shape(); s.vertices=v.vertices; s.inTangents=v.inTangents; s.outTangents=v.outTangents; s.closed=v.closed; return s; }
        return v;
    }
    function interp(s) { if (s !== "linear" && s !== "bezier" && s !== "hold") fail("invalid_payload", "Interpolation must be linear, bezier or hold"); return s === "linear" ? KeyframeInterpolationType.LINEAR : (s === "bezier" ? KeyframeInterpolationType.BEZIER : KeyframeInterpolationType.HOLD); }
    function validateEase(a, n) {
        var i; if (!array(a) || a.length !== n) fail("invalid_payload", "Ease dimensions do not match property");
        for (i=0;i<a.length;i++) { object(a[i],"speed influence","speed influence"); num(a[i].speed,-1e12,1e12); num(a[i].influence,0.1,100); }
    }
    function nativeEase(a) { var r=[],i; for(i=0;i<a.length;i++) r.push(new KeyframeEase(a[i].speed,a[i].influence)); return r; }
    function updates(v, comp, target) {
        object(v, comp ? "name width height pixelAspect duration frameRate time bgColor" : "name enabled shy solo startTime inPoint outPoint stretch position text", "");
        var k=keys(v),i,n;
        if (!k.length) fail("invalid_payload","Empty update");
        for(i=0;i<k.length;i++) {
            n=k[i];
            if(n==="name" || n==="text") str(v[n],n,n==="text");
            else if(n==="width" || n==="height") num(v[n],4,30000,true);
            else if(n==="pixelAspect") num(v[n],0.01,100);
            else if(n==="duration") num(v[n],1/99,10800);
            else if(n==="frameRate") num(v[n],1,99);
            else if(n==="bgColor") vec(v[n],3,0,1);
            else if(n==="position") vec(v[n],target.positionDimensions || (target.threeDLayer || target instanceof CameraLayer || target instanceof LightLayer ? 3 : 2),-1e9,1e9);
            else if(n==="enabled" || n==="shy" || n==="solo") bool(v[n]);
            else if(n==="stretch") { num(v[n],-9900,9900); if(Math.abs(v[n])<1) fail("invalid_payload","Stretch cannot be zero or rounded by AE"); }
            else num(v[n],comp ? 0 : -10800,comp ? (own(v,"duration") ? v.duration : target.duration) : 10800);
        }
        if(comp && (own(v,"duration") || own(v,"frameRate"))) {
            if ((own(v,"duration") ? v.duration : target.duration) < 1/(own(v,"frameRate") ? v.frameRate : target.frameRate)) fail("invalid_payload","Composition needs at least one frame");
        }
        if(!comp) {
            if ((own(v,"inPoint") ? v.inPoint : target.inPoint) >= (own(v,"outPoint") ? v.outPoint : target.outPoint)) fail("invalid_payload","Layer inPoint must precede outPoint");
            if (own(v,"text") && !(target instanceof TextLayer) && target.layerKind !== "text") fail("invalid_target","Text update requires text layer");
            if (!target.virtual) {
                if(own(v,"position")) {
                    var pp=target.property("ADBE Transform Group").property("ADBE Position");
                    if(pp.numKeys || pp.expressionEnabled || (pp.isSeparationLeader && pp.dimensionsSeparated)) fail("invalid_target","Use explicit property/keyframe actions for animated or separated position");
                    propertyValue(pp,v.position);
                }
                if(own(v,"text")) {
                    var tp=target.property("ADBE Text Properties").property("ADBE Text Document");
                    if(tp.numKeys || tp.expressionEnabled) fail("invalid_target","Use explicit property/keyframe actions for animated text");
                }
            }
        }
    }
    function refName(a, refs, value) { if(own(a,"ref")) { str(a.ref,"ref"); if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(a.ref) || own(refs,a.ref)) fail("invalid_reference","Reference must be unique"); refs[a.ref]=value; } }
    function pathFile(path) { str(path,"path"); var local=path.charAt(0)==="/" || (/^[A-Za-z]:/.test(path) && (path.charAt(2)==="/" || path.charAt(2)==="\\")), network=path.substr(0,2)==="//" || path.substr(0,2)==="\\\\"; if(!local || network) fail("invalid_path","Use an absolute local path, not a network path"); var f=new File(path); if(!f.exists) fail("file_missing","File does not exist"); return f; }
    function resolvedFile(file) {
        if(file.alias){file=file.resolve();if(!file)fail("unsafe_state","Unresolved footage alias");}
        return file;
    }
    function interpretation(footage) {
        var s=footage.mainSource,o={},fields,i;
        if(!(s instanceof FileSource) || footage.footageMissing || footage.useProxy)fail("unsupported_asset","Duplicate footage must have an available file source without proxy");
        bool(s.isStill);bool(s.hasAlpha);
        fields=["isStill","hasAlpha"];
        if(s.hasAlpha)fields=fields.concat(["alphaMode","invertAlpha","premulColor"]);
        if(!s.isStill)fields=fields.concat(["conformFrameRate","nativeFrameRate","displayFrameRate","fieldSeparationType","highQualityFieldSeparation","loop","removePulldown"]);
        for(i=0;i<fields.length;i++){
            var value=s[fields[i]];
            if(typeof value==="undefined")fail("unsupported_asset","Footage interpretation is not inspectable");
            o[fields[i]]=fields[i]==="alphaMode" || fields[i]==="fieldSeparationType" || fields[i]==="removePulldown" ? String(value) : plainValue(value);
        }
        return stringify(o);
    }
    function existingFootage(file) {
        file=resolvedFile(file);
        var found=null,i,p,signature;
        for(i=1;i<=app.project.numItems;i++){
            p=app.project.item(i);
            if(p instanceof FootageItem && p.file && resolvedFile(p.file).fsName===file.fsName){
                signature=interpretation(p);
                if(found && found.signature!==signature)fail("unsupported_asset","Same file has conflicting interpretations; choose footage explicitly");
                if(!found)found={object:p,path:file.fsName,signature:signature};
            }
        }
        return found;
    }
    function importPins(actions) {
        var result=[],i;
        for(i=0;i<actions.length;i++)result[i]=actions[i].type==="asset.import" ? existingFootage(pathFile(actions[i].path)) : null;
        return result;
    }
    function validate(actions, liveRefs) {
        if(!array(actions) || !actions.length) fail("invalid_payload","Nonempty actions required");
        var refs=liveRefs || {}, warnings=[], affected=[], structural={}, deleted={}, compChanges={}, layerChanges={}, propertyEdits={}, hierarchyChanged=false, edges=[], canonical=parse(stringify(actions)), i,a,c,l,p,v,k,target,key,source,folder,token;
        for(i=0;i<canonical.length;i++) {
            a=canonical[i]; object(a,"type ref compId layerId itemId folderId sourceId kind name text position color width height pixelAspect duration frameRate changes beforeLayerId locator value time toTime inType outType inEase outEase inTangent outTangent roving temporalContinuous temporalAutoBezier spatialContinuous spatialAutoBezier source enabled matchName index path comment markerDuration","type");
            str(a.type,"type"); c=null;l=null;p=null; token="";
            var itemFields=["compId","itemId","folderId","sourceId"], fieldIndex, compKey=own(a,"compId") ? stringify(a.compId) : (a.locator ? stringify(a.locator.itemId) : ""), layerKey=own(a,"layerId") ? stringify(a.layerId) : (a.locator ? stringify(a.locator.layerId) : "");
            for(fieldIndex=0;fieldIndex<itemFields.length;fieldIndex++)if(own(a,itemFields[fieldIndex]) && own(deleted,"item:"+stringify(a[itemFields[fieldIndex]])))fail("invalid_reference","Item deleted earlier in plan");
            if(a.locator && own(deleted,"item:"+stringify(a.locator.itemId)))fail("invalid_reference","Locator composition deleted earlier");
            if(own(deleted,"layer:"+layerKey) || (own(a,"beforeLayerId") && own(deleted,"layer:"+stringify(a.beforeLayerId))))fail("invalid_reference","Layer deleted earlier in plan");
            if(compChanges[compKey])fail("unsupported_ordering","Inspect and re-preflight after updating an existing composition's timing or dimensions");
            if(layerChanges[layerKey])fail("unsupported_ordering","Inspect and re-preflight after updating an existing layer");
            var schema=function(allowed,required) { object(a,"type "+allowed,required); };
            if(a.type==="comp.create") {
                schema("ref name width height pixelAspect duration frameRate","name width height pixelAspect duration frameRate");
                v={name:a.name,width:a.width,height:a.height,pixelAspect:a.pixelAspect,duration:a.duration,frameRate:a.frameRate}; updates(v,true,v);
                refName(a,refs,{virtual:true,kind:"comp",refKey:a.ref,duration:a.duration,frameRate:a.frameRate,width:a.width,height:a.height}); affected.push(a.ref || "new comp");
            } else if(a.type==="folder.create") {
                schema("ref name folderId","name"); str(a.name,"name"); if(own(a,"folderId")) item(a.folderId,"folder",refs);
                refName(a,refs,{virtual:true,kind:"folder",parentFolder:own(a,"folderId") ? item(a.folderId,"folder",refs) : null}); affected.push(a.ref || "new folder");
            } else if(a.type==="asset.import") {
                schema("ref path","path"); requireFiles(); source=resolvedFile(pathFile(a.path));a.path=source.fsName;
                if(!/\.(png|jpe?g|tiff?|exr|psd|ai|wav|aif|aiff|mp3|mp4|mov)$/i.test(a.path)) fail("unsupported_asset","Asset extension not qualified for noninteractive footage import");
                var io=new ImportOptions(source); if(!io.canImportAs(ImportAsType.FOOTAGE)) fail("unsupported_asset","Cannot import as footage");
                var reused=existingFootage(source);
                refName(a,refs,reused ? {kind:"footage",object:reused.object} : {virtual:true,kind:"footage"});
                warnings.push(reused ? "Reuse footage "+reused.object.id+" with its unchanged existing interpretation." : "Asset import may invoke codec/plugin dialogs or external I/O.");
                affected.push(reused ? reused.object.id : a.ref || "new footage");
            } else if(a.type==="item.move") {
                schema("itemId folderId","itemId folderId"); target=item(a.itemId,null,refs); folder=item(a.folderId,"folder",refs);
                if(target===folder) fail("invalid_target","Cannot parent an item to itself");
                if(hierarchyChanged)fail("unsupported_ordering","Inspect after a folder move before planning another item move");
                var walk=folder; while(walk && walk !== app.project.rootFolder) { if(walk===target) fail("invalid_target","Folder cycle"); walk=walk.parentFolder; }
                if(target.virtual && target.kind==="folder") fail("unsupported_ordering","Inspect new folders before moving them");
                affected.push(a.itemId);
            } else if(a.type==="comp.reorder") { fail("unsupported_action","AE has no documented project-item reorder API; use item.move for folders"); }
            else if(a.type.indexOf("comp.")===0) {
                c=item(a.compId,"comp",refs);
                if(a.type==="comp.update") { schema("compId changes","compId changes"); updates(a.changes,true,c); if(c.virtual) { for(k in a.changes) if(own(a.changes,k)) c[k]=a.changes[k]; } else if(own(a.changes,"width") || own(a.changes,"height") || own(a.changes,"pixelAspect") || own(a.changes,"duration") || own(a.changes,"frameRate")) compChanges[compKey]=true; }
                else if(a.type==="comp.delete") {
                    schema("compId","compId"); if(!c.virtual) for(k=1;k<=c.numLayers;k++) preserve(c.layer(k));
                    warnings.push("Destructive: deletes composition and its layers."); deleted["item:"+stringify(a.compId)]=true;
                } else fail("unsupported_action","Unknown composition action");
                affected.push(a.compId);
            } else if(a.type==="layer.create") {
                schema("ref compId kind name text position color width height pixelAspect sourceId","compId kind name");
                c=item(a.compId,"comp",refs); str(a.name,"name"); str(a.kind,"kind");
                if(!/^(text|shape|solid|footage|camera|light|null|precomp)$/.test(a.kind)) fail("unsupported_action","Unsupported layer kind");
                if(a.kind==="text") { if(!own(a,"text")) a.text=""; str(a.text,"text",true); } else if(own(a,"text")) fail("invalid_payload","text only applies to text layers");
                if(a.kind==="footage" || a.kind==="precomp") { source=item(a.sourceId,a.kind==="precomp" ? "comp" : null,refs); if(source===c || source instanceof FolderItem || source.kind==="folder") fail("invalid_target","Invalid layer source"); if(a.kind==="footage" && (source instanceof CompItem || source.kind==="comp")) fail("invalid_target","Use precomp kind for compositions"); }
                else if(own(a,"sourceId")) fail("invalid_payload","Unexpected sourceId");
                if(a.kind==="precomp") {
                    if(dependsOn(source,c,edges,{}))fail("invalid_target","Precomposition cycle");
                    edges.push({from:c,to:source});
                }
                if(a.kind==="footage" && source.footageMissing)fail("missing_asset","Relink missing footage manually");
                if(a.kind==="solid") { vec(a.color,3,0,1); num(a.width,4,30000,true);num(a.height,4,30000,true);num(a.pixelAspect,0.01,100); }
                else if(own(a,"color") || own(a,"width") || own(a,"height") || own(a,"pixelAspect")) fail("invalid_payload","Solid fields on non-solid layer");
                if(own(a,"position")) vec(a.position,a.kind==="camera" || a.kind==="light" ? 3 : 2,-1e9,1e9);
                l={virtual:true,kind:"layer",layerKind:a.kind,comp:c,inPoint:0,outPoint:c.duration,positionDimensions:a.kind==="camera" || a.kind==="light" ? 3 : 2};
                refName(a,refs,l); affected.push(a.ref || "new layer");
            } else if(a.type.indexOf("layer.")===0 || a.type==="effect.add") {
                c=item(a.compId,"comp",refs); l=layer(c,a.layerId,refs); if(l.locked) fail("locked_layer","Layer is locked"); preserve(l);
                if(a.type==="layer.update") { schema("compId layerId changes","compId layerId changes"); updates(a.changes,false,l); if(l.virtual) { for(k in a.changes) if(own(a.changes,k)) l[k]=a.changes[k]; } else layerChanges[layerKey]=true; }
                else if(a.type==="layer.delete") { schema("compId layerId","compId layerId"); warnings.push("Destructive: deletes layer."); deleted["layer:"+stringify(a.layerId)]=true; }
                else if(a.type==="layer.reorder") { schema("compId layerId beforeLayerId","compId layerId beforeLayerId"); if(a.beforeLayerId !== null && layer(c,a.beforeLayerId,refs)===l) fail("invalid_target","Cannot reorder relative to itself"); }
                else if(a.type==="effect.add") {
                    schema("compId layerId matchName","compId layerId matchName"); str(a.matchName,"matchName");
                    if(l.virtual) fail("unsupported_ordering","Inspect newly created layer before adding effects");
                    p=l.property("ADBE Effect Parade");
                    if(!installed(a.matchName) || !p || !p.canAddProperty(a.matchName)) fail("unsupported_effect","Effect is not installed or cannot be added");
                    structural[stringify({c:a.compId,l:a.layerId})]=true;
                    warnings.push("Effects may trigger licensing dialogs, cache writes, downloads or network activity; checkpoint rollback cannot undo those side effects.");
                } else fail("unsupported_action","Unknown layer action");
                affected.push(a.layerId);
            } else if(a.type==="marker.set" || a.type==="marker.delete") {
                schema("compId layerId time comment markerDuration",a.type==="marker.set" ? "compId time comment" : "compId time");
                if(a.type==="marker.delete" && (own(a,"comment") || own(a,"markerDuration"))) fail("invalid_payload","Unexpected marker fields");
                c=item(a.compId,"comp",refs); if(c.virtual) fail("unsupported_ordering","Inspect new composition before markers");
                l=own(a,"layerId") ? layer(c,a.layerId,refs) : null;
                if(l && (l.virtual || l.locked)) fail("invalid_target","Marker layer must exist and be unlocked");
                p=l ? l.property("ADBE Marker") : c.markerProperty;
                if(!p) fail("unsupported_capability","Markers unavailable");
                time(a.time,c);
                if(a.type==="marker.set") { str(a.comment,"comment",true); if(!own(a,"markerDuration")) a.markerDuration=0; num(a.markerDuration,0,c.duration-a.time); }
                else keyAt(p,a.time,false);
                affected.push(l ? a.layerId : a.compId);
            } else {
                schema("locator value time toTime inType outType inEase outEase inTangent outTangent roving temporalContinuous temporalAutoBezier spatialContinuous spatialAutoBezier source enabled index","locator");
                p=resolve(a.locator,null,a.type==="effect.enable" && a.enabled===true); c=item(a.locator.itemId,"comp"); token=stringify({c:a.locator.itemId,l:a.locator.layerId});
                if(structural[token]) fail("unsupported_ordering","Inspect/re-preflight after changing this layer's effect structure");
                var propertyKey=stringify(a.locator), state=propertyEdits[propertyKey], keyIndex=-1, destinationIndex=-1;
                if(!state) {
                    state={keys:[],expressionEnabled:!!p.expressionEnabled};
                    for(k=1;k<=p.numKeys;k++)state.keys.push({time:p.keyTime(k),value:plainValue(p.keyValue(k),p.propertyValueType),roving:p.isSpatial ? p.keyRoving(k) : false});
                    propertyEdits[propertyKey]=state;
                }
                if(state.rovingPending)fail("unsupported_ordering","Roving changes neighboring times; inspect before another action on this property");
                for(k=0;k<state.keys.length;k++) {
                    if(Math.abs(state.keys[k].time-a.time)<0.0000001)keyIndex=k;
                    if(Math.abs(state.keys[k].time-a.toTime)<0.0000001)destinationIndex=k;
                }
                if(a.type==="property.set") { schema("locator value","locator value"); propertyValue(p,a.value); if(state.keys.length || state.expressionEnabled) fail("invalid_target","Static write refuses keyed or expression-enabled property"); }
                else if(a.type==="expression.set") {
                    schema("locator source enabled","locator source"); str(a.source,"source",true);
                    if(!p.canSetExpression) fail("unsupported_expression","Target cannot accept expressions");
                    if(!own(a,"enabled")) a.enabled=!!a.source; bool(a.enabled); if(a.enabled && !a.source) fail("invalid_payload","Empty expression cannot be enabled");
                    state.expressionEnabled=a.enabled;
                    warnings.push("Expression source is executed by AE and may have external side effects; syntax/evaluation is checked at execution.");
                } else if(a.type.indexOf("keyframe.")===0) {
                    if(!p.canVaryOverTime || p.propertyValueType===PropertyValueType.MARKER) fail("unsupported_animation","Property cannot accept numeric keyframe actions");
                    time(a.time,c);
                    if(a.type==="keyframe.set") {
                        schema("locator time value","locator time value"); propertyValue(p,a.value);
                        if(keyIndex<0)state.keys.push({time:a.time,value:a.value,roving:false});
                        else state.keys[keyIndex].value=a.value;
                    } else {
                        if(keyIndex<0)fail("stale_keyframe","No existing or earlier planned key at exact time");
                        if(a.type==="keyframe.delete") { schema("locator time","locator time");state.keys.splice(keyIndex,1); }
                        else if(a.type==="keyframe.move") {
                            schema("locator time toTime","locator time toTime"); time(a.toTime,c);
                            if(destinationIndex>=0) fail("keyframe_collision","Destination already has a keyframe");
                            propertyValue(p,state.keys[keyIndex].value);
                            if(state.keys[keyIndex].roving) fail("unsupported_animation","Disable roving before moving a keyframe");
                            state.keys[keyIndex].time=a.toTime;
                        } else if(a.type==="keyframe.interpolation") {
                            schema("locator time inType outType inEase outEase inTangent outTangent roving temporalContinuous temporalAutoBezier spatialContinuous spatialAutoBezier","locator time inType outType");
                            if(!p.isInterpolationTypeValid(interp(a.inType)) || !p.isInterpolationTypeValid(interp(a.outType))) fail("unsupported_interpolation","Interpolation not supported");
                            if(own(a,"inEase")!==own(a,"outEase") || own(a,"inTangent")!==own(a,"outTangent")) fail("invalid_payload","Supply both in/out values");
                            var dims=p.propertyValueType===PropertyValueType.TwoD ? 2 : (p.propertyValueType===PropertyValueType.ThreeD ? 3 : 1);
                            if(own(a,"inEase")) { validateEase(a.inEase,dims);validateEase(a.outEase,dims); }
                            if(own(a,"inTangent")) {
                                if(!p.isSpatial) fail("unsupported_interpolation","Not a spatial property");
                                var spatialDims=p.propertyValueType===PropertyValueType.ThreeD_SPATIAL ? 3 : 2;
                                vec(a.inTangent,spatialDims,-1e9,1e9);vec(a.outTangent,spatialDims,-1e9,1e9);
                            }
                            var flags=["roving","temporalContinuous","temporalAutoBezier","spatialContinuous","spatialAutoBezier"];
                            for(k=0;k<flags.length;k++) if(own(a,flags[k])) { bool(a[flags[k]]); if((flags[k]==="roving" || flags[k].indexOf("spatial")===0) && !p.isSpatial) fail("unsupported_interpolation","Spatial flag on nonspatial property"); }
                            if(a.roving && (keyIndex===0 || keyIndex===state.keys.length-1)) fail("unsupported_interpolation","First/last key cannot rove");
                            if(a.roving)state.rovingPending=true;
                            if(own(a,"roving"))state.keys[keyIndex].roving=a.roving;
                        } else fail("unsupported_action","Unknown keyframe action");
                    }
                    state.keys.sort(function(a,b){return a.time-b.time;});
                } else if(a.type.indexOf("effect.")===0) {
                    if(!p.isEffect || p.parentProperty.matchName!=="ADBE Effect Parade") fail("invalid_target","Locator must target a live effect instance");
                    if(a.type==="effect.remove" || a.type==="effect.reorder")preserve(layer(c,a.locator.layerId));
                    if(a.type==="effect.remove") { schema("locator","locator"); warnings.push("Destructive: removes effect."); structural[token]=true; }
                    else if(a.type==="effect.enable") { schema("locator enabled","locator enabled"); bool(a.enabled); if(!p.canSetEnabled) fail("unsupported_effect","Effect cannot change enabled state"); }
                    else if(a.type==="effect.reorder") { schema("locator index","locator index");num(a.index,1,p.parentProperty.numProperties,true);structural[token]=true; }
                    else fail("unsupported_action","Unknown effect action");
                    warnings.push("Effect changes may invoke external plugin side effects.");
                } else fail("unsupported_action","Unknown action: "+a.type);
                affected.push(a.locator);
            }
            if(a.type==="item.move" && (target instanceof FolderItem || target.kind==="folder"))hierarchyChanged=true;
        }
        if(canonical.length*40>5000) warnings.push("Long plan: server must bound execution and checkpoint/revision-check between chunks.");
        return {actions:canonical,warnings:warnings,affected:affected,estimatedMs:canonical.length*40};
    }
    function applyChanges(target,changes) {
        var k,p;
        for(k in changes) if(own(changes,k)) {
            if(k==="position") target.property("ADBE Transform Group").property("ADBE Position").setValue(changes[k]);
            else if(k==="text") { p=target.property("ADBE Text Properties").property("ADBE Text Document");var d=p.value;d.text=changes[k];p.setValue(d); }
            else target[k]=changes[k];
        }
    }
    function applyInterpolation(p,k,a) {
        p.setInterpolationTypeAtKey(k,interp(a.inType),interp(a.outType));
        if(own(a,"inEase")) p.setTemporalEaseAtKey(k,nativeEase(a.inEase),nativeEase(a.outEase));
        if(own(a,"temporalContinuous")) p.setTemporalContinuousAtKey(k,a.temporalContinuous);
        if(own(a,"temporalAutoBezier")) p.setTemporalAutoBezierAtKey(k,a.temporalAutoBezier);
        if(own(a,"inTangent")) p.setSpatialTangentsAtKey(k,a.inTangent,a.outTangent);
        if(own(a,"spatialContinuous")) p.setSpatialContinuousAtKey(k,a.spatialContinuous);
        if(own(a,"spatialAutoBezier")) p.setSpatialAutoBezierAtKey(k,a.spatialAutoBezier);
        if(own(a,"roving")) p.setRovingAtKey(k,a.roving);
    }
    function executionPlan(actions) {
        ready(true);
        var pinned=plan,current=inspect(),checked,i,pins=[];
        if(!pinned || stringify(actions)!==pinned.actions || stringify(current)!==pinned.snapshot) fail("stale_plan","Exact preflight actions and unchanged project snapshot required");
        checked=validate(actions);
        for(i=0;i<checked.actions.length;i++) {
            pins[i]=[];
            if(checked.actions[i].locator)resolve(checked.actions[i].locator,pins[i],checked.actions[i].type==="effect.enable" && checked.actions[i].enabled===true);
        }
        plan=null;
        return {actions:checked.actions,pins:pins,imports:pinned.imports,imported:{},refs:{},snapshot:stringify(current),projectObject:app.project,offset:0};
    }
    function execute(actions, context, count) {
        ready(true);
        var ctx=context || executionPlan(actions),checked={actions:ctx.actions},refs=ctx.refs,results=[],i,a,c,l,p,r,k,d,v,group=false,failure=null;
        if(app.project!==ctx.projectObject || stringify(inspect())!==ctx.snapshot)fail("stale_plan","Transaction snapshot or project object changed");
        var pins=ctx.pins,expectedRevision=app.project.revision,expectedProject=stringify(project()),start=ctx.offset,end=Math.min(checked.actions.length,start+(count || checked.actions.length));
        try {
            app.beginUndoGroup("CookieMonster AE");group=true;
            expectedRevision=app.project.revision;
            for(i=start;i<end;i++) {
                if(app.project.revision!==expectedRevision || stringify(project())!==expectedProject)fail("stale_plan","Unexpected project change between actions");
                a=parse(stringify(checked.actions[i]));
                if(a.locator)a.locator=reacquire(a.locator,pins[i],a.type==="effect.enable" && a.enabled===true);
                var validationRefs={}, refKey;
                for(refKey in refs)if(own(refs,refKey))validationRefs[refKey]=refs[refKey];
                validate([a],validationRefs);
                r=null;c=own(a,"compId") ? item(a.compId,"comp",refs) : null;l=own(a,"layerId") ? layer(c,a.layerId,refs) : null;
                if(a.type==="comp.create") r=app.project.items.addComp(a.name,a.width,a.height,a.pixelAspect,a.duration,a.frameRate);
                else if(a.type==="folder.create") { r=app.project.items.addFolder(a.name);if(own(a,"folderId"))r.parentFolder=item(a.folderId,"folder",refs); }
                else if(a.type==="asset.import") {
                    var sourceFile=resolvedFile(pathFile(a.path)),existing=existingFootage(sourceFile),proof=ctx.imports[i] || ctx.imported[sourceFile.fsName];
                    if(proof){
                        if(!existing || existing.object!==proof.object || existing.path!==proof.path || existing.signature!==proof.signature)
                            fail("stale_asset","Pinned footage identity or interpretation changed");
                        r=proof.object;
                    }else{
                        if(existing)fail("stale_asset","Unreviewed duplicate appeared after preflight");
                        var io=new ImportOptions(sourceFile);io.importAs=ImportAsType.FOOTAGE;io.sequence=false;r=app.project.importFile(io);
                        ctx.imported[sourceFile.fsName]={object:r,path:sourceFile.fsName,signature:interpretation(r)};
                    }
                }
                else if(a.type==="item.move") item(a.itemId,null,refs).parentFolder=item(a.folderId,"folder",refs);
                else if(a.type==="comp.update") applyChanges(c,a.changes);
                else if(a.type==="comp.delete") c.remove();
                else if(a.type==="layer.create") {
                    if(a.kind==="text") r=c.layers.addText(a.text);
                    else if(a.kind==="shape") r=c.layers.addShape();
                    else if(a.kind==="solid") r=c.layers.addSolid(a.color,a.name,a.width,a.height,a.pixelAspect,c.duration);
                    else if(a.kind === "nu" + "ll") r=c.layers.addNull(c.duration);
                    else if(a.kind==="camera") r=c.layers.addCamera(a.name,[c.width/2,c.height/2]);
                    else if(a.kind==="light") r=c.layers.addLight(a.name,[c.width/2,c.height/2]);
                    else r=c.layers.add(item(a.sourceId,null,refs));
                    r.name=a.name;if(own(a,"position"))r.property("ADBE Transform Group").property("ADBE Position").setValue(a.position);
                } else if(a.type==="layer.update") applyChanges(l,a.changes);
                else if(a.type==="layer.delete") l.remove();
                else if(a.type==="layer.reorder") { if(a.beforeLayerId === null)l.moveToEnd();else l.moveBefore(layer(c,a.beforeLayerId,refs)); }
                else if(a.type==="effect.add") { p=l.property("ADBE Effect Parade");if(!p.canAddProperty(a.matchName))fail("unsupported_effect","Effect capability changed");p.addProperty(a.matchName); }
                else if(a.type==="marker.set" || a.type==="marker.delete") {
                    p=l ? l.property("ADBE Marker") : c.markerProperty;
                    if(a.type==="marker.delete")p.removeKey(keyAt(p,a.time,false));
                    else { v=new MarkerValue(a.comment);v.duration=a.markerDuration;p.setValueAtTime(a.time,v); }
                } else {
                    p=resolve(a.locator,null,a.type==="effect.enable" && a.enabled===true);
                    if(a.type==="property.set")p.setValue(nativeValue(p,a.value,0));
                    else if(a.type==="keyframe.set")p.setValueAtTime(a.time,nativeValue(p,a.value,a.time));
                    else if(a.type==="keyframe.delete")p.removeKey(keyAt(p,a.time,false));
                    else if(a.type==="keyframe.interpolation")applyInterpolation(p,keyAt(p,a.time,false),a);
                    else if(a.type==="keyframe.move") {
                        k=keyAt(p,a.time,false);d=keyData(p,k);v=p.keyValue(k);p.removeKey(k);p.setValueAtTime(a.toTime,v);k=keyAt(p,a.toTime,false);
                        var interpolationName=function(s) { return s===String(KeyframeInterpolationType.LINEAR) ? "linear" : (s===String(KeyframeInterpolationType.HOLD) ? "hold" : "bezier"); };
                        d.inType=interpolationName(d.inType);d.outType=interpolationName(d.outType);applyInterpolation(p,k,d);p.setLabelAtKey(k,d.label);
                    } else if(a.type==="expression.set") { p.expression=a.source;if(p.expressionError)fail("expression_error","Expression evaluation failed: "+p.expressionError);p.expressionEnabled=a.enabled; }
                    else if(a.type==="effect.remove")p.remove();
                    else if(a.type==="effect.enable")p.enabled=a.enabled;
                    else if(a.type==="effect.reorder")p.moveTo(a.index);
                }
                if(r && own(a,"ref")) refs[a.ref]={kind:a.type==="layer.create" ? "layer" : (a.type==="comp.create" ? "comp" : (a.type==="folder.create" ? "folder" : "footage")),object:r,comp:c};
                results.push(r ? {id:r.id,ref:own(a,"ref") ? a.ref : null} : {ok:true});
                expectedRevision=app.project.revision;
            }
        } catch(e) {
            if(app.project!==ctx.projectObject || stringify(project())!==expectedProject ||
                (e.code && /^(stale_|unsafe_|uncertain|outcome_|busy|timeout|modal|lost_reply|disconnected)/.test(e.code))){
                uncertain=true;transaction=null;fail("uncertain_outcome","Execution identity changed; automatic recovery refused");
            }
            failure={code:e.code || "native_exception",message:String(e.message || e).substr(0,2048),actionIndex:i};
        } finally { if(group) { try { app.endUndoGroup(); } catch(undoError) { uncertain=true;transaction=null;fail("uncertain_outcome","Undo group could not be closed; recovery required"); } } }
        try {
            var stopped=inspect();
            if(failure){
                recovery={id:String(new Date().getTime())+":"+Math.random(),owner:ctx.owner || null,projectObject:app.project,project:project(),snapshot:stringify(stopped),phase:"stopped"};
                transaction=null;
                return {status:"stopped",results:results,failure:failure,recovery:{id:recovery.id,snapshot:stopped}};
            }
            ctx.offset=end;ctx.snapshot=stringify(stopped);
            return context ? {status:end===ctx.actions.length ? "complete" : "chunk",results:results,offset:end,snapshot:stopped} : {results:results,snapshot:stopped};
        } catch(postError){uncertain=true;transaction=null;fail("uncertain_outcome","Post-execution inspection failed; no automatic recovery");}
    }
    function owner(value) {
        object(value,"id sessionID bindingID","id sessionID bindingID");
        str(value.id,"transaction id");str(value.sessionID,"session");str(value.bindingID,"binding");
        return stringify(value);
    }
    var RESTORE_PROOF = "compact-restore-v2";
    function restoreGuard() {
        ready(false);requireFiles();
        var nativeProject=app.project, identity=project(), epoch=projectEpoch, revision, dirty, callback;
        try { revision=nativeProject.revision;dirty=nativeProject.dirty;callback=app.onError; }
        catch(e){fail("restore_unsupported","Native restore guards are unavailable");}
        if(typeof revision!=="number" || !isFinite(revision) || revision<1 || revision>9007199254740991 || Math.floor(revision)!==revision ||
            typeof dirty!=="boolean" || !(callback === undefined || callback === null || typeof callback==="string"))
            fail("restore_unsupported","Native revision, dirty and callback checks must be supported");
        if(!identity.saved || nativeProject.renderQueue.rendering!==false || !(callback === undefined || callback === null || callback===""))
            fail("unsafe_state","Restore requires a saved idle project without an error callback");
        if(!isValid(nativeProject) || app.project!==nativeProject || stringify(project())!==stringify(identity) ||
            projectEpoch!==epoch || nativeProject.revision!==revision || nativeProject.dirty!==dirty ||
            app.onError!==callback || nativeProject.renderQueue.rendering!==false || !capability().fileNetwork)
            fail("unsafe_state","Native project changed during compact guard read");
        return {protocol:RESTORE_PROOF,project:identity,projectEpoch:epoch,revision:revision,dirty:dirty,
            busy:false,callbacksClear:true,capabilities:capability()};
    }
    function manualRestore(p) {
        var preparing=p.phase==="restore_prepare", fields="phase transaction recoveryId expected path";
        object(p,preparing ? fields : fields+" verifiedCheckpoint",preparing ? fields : fields+" verifiedCheckpoint");
        if(!p.expected || p.expected.protocol!==RESTORE_PROOF)fail("restore_unsupported","Matching compact restore receipt required");
        ready(true);requireFiles();str(p.recoveryId,"restore id");
        var identity=owner(p.transaction), rec=recovery, approved=restoreGuard();
        if(stringify(p.expected)!==stringify(approved))fail("unsafe_state","Approved compact restore guard changed");
        if(preparing){
            if(rec || transaction)fail("unsafe_state","Another transaction requires recovery");
            str(p.path,"emergency path");
            var slash=String.fromCharCode(92),local=p.path.split(slash).join("/");
            if((local.charAt(0)!=="/" && (!/^[A-Za-z]:/.test(local) || local.charAt(2)!=="/")) ||
                local.substr(0,2)==="//" || !/[.]aepx?$/i.test(local))fail("invalid_path","Absolute local recovery project required");
            var file=new File(p.path);
            if(file.exists)fail("unsafe_state","Emergency destination already exists");
            rec={id:p.recoveryId,owner:identity,projectObject:app.project,project:approved.project,
                receipt:approved,phase:"saving",manual:true};
            recovery=rec;plan=null;
            try {
                if(stringify(restoreGuard())!==stringify(approved))fail("unsafe_state","State changed before save");
                // Save in place: native Save As changes revision even without an edit.
                // The workflow has already preserved the previous on-disk file.
                rec.projectObject.save(rec.projectObject.file);
                if(!isValid(rec.projectObject) || app.project!==rec.projectObject)fail("unsafe_state","Save replaced the native project");
                var saved=restoreGuard();
                if(stringify(saved.project)!==stringify(approved.project) || saved.projectEpoch!==approved.projectEpoch || saved.dirty!==false ||
                    saved.revision!==approved.revision)
                    fail("unsafe_state","Save did not preserve native ownership and revision");
                if(file.exists || !rec.projectObject.file.copy(file.fsName) || !file.exists ||
                    stringify(restoreGuard())!==stringify(saved))
                    fail("unsafe_state","Emergency copy or saved state did not confirm");
                rec.receipt=saved;rec.phase="saved";
                return {status:"recovery_saved",project:saved.project,receipt:saved};
            }catch(e){uncertain=true;fail("uncertain_outcome","Emergency save was not confirmed; do not close or retry");}
        }
        if(!rec || !rec.manual || rec.phase!=="saved" || rec.id!==p.recoveryId || rec.owner!==identity ||
            !isValid(rec.projectObject) || app.project!==rec.projectObject || stringify(rec.receipt)!==stringify(approved))
            fail("unsafe_state","No matching single-use compact restore preparation");
        object(p.verifiedCheckpoint,"id hash size","id hash size");str(p.verifiedCheckpoint.id,"checkpoint");
        if(!/^[a-f0-9]{64}$/.test(p.verifiedCheckpoint.hash))fail("invalid_payload","Verified emergency hash required");
        num(p.verifiedCheckpoint.size,1,5*1024*1024*1024,true);
        var canonicalFile=pathFile(p.path);
        if(!/[.]aepx?$/i.test(canonicalFile.fsName))fail("invalid_path","Expected a verified AE project");
        if(approved.dirty!==false || stringify(restoreGuard())!==stringify(rec.receipt) ||
            !isValid(rec.projectObject) || app.project!==rec.projectObject)
            fail("unsafe_state","Current state changed before close");
        rec.phase="closing";
        try {
            if(!rec.projectObject.close(CloseOptions.DO_NOT_SAVE_CHANGES))fail("unsafe_state","Project close was refused");
            var opened=app.open(canonicalFile);
            if(!opened || !isValid(opened) || app.project!==opened ||
                (isValid(rec.projectObject) && opened===rec.projectObject))
                fail("unsafe_state","Open did not return the actual new native project");
            var restored=restoreGuard();
            if(restored.project.path!==canonicalFile.fsName || restored.dirty!==false ||
                restored.projectEpoch===rec.receipt.projectEpoch)
                fail("unsafe_state","Reopened identity, epoch or clean state did not confirm");
            recovery=null;transaction=null;
            return {status:"recovered",project:restored.project,receipt:restored};
        }catch(e){uncertain=true;fail("uncertain_outcome","Recovery close/open was not confirmed; retain backups without retry");}
    }
    function executePhase(p) {
        str(p.phase,"phase");
        if(uncertain)fail("uncertain_outcome","Unknown host outcome cannot authorize recovery");
        if(p.phase==="restore_prepare" || p.phase==="restore_finish")return manualRestore(p);
        if(p.phase==="begin"){
            object(p,"phase transaction actions","phase transaction actions");
            var identity=owner(p.transaction);
            if(recovery)fail("unsafe_state","Stopped execution requires recovery");
            transaction=executionPlan(p.actions);transaction.owner=identity;
            return {status:"prepared",offset:0};
        }
        if(p.phase==="chunk"){
            object(p,"phase transaction offset count expected","phase transaction offset count expected");
            var tx=transaction;
            if(!tx || tx.owner!==owner(p.transaction) || tx.offset!==p.offset || stringify(p.expected)!==tx.snapshot)fail("stale_plan","Transaction owner, offset or expected snapshot changed");
            num(p.count,1,64,true);
            var result=execute(null,tx,p.count);
            if(result.status==="complete")transaction=null;
            return result;
        }
        var preparing=p.phase==="recovery_prepare";
        object(p,preparing ? "phase transaction recoveryId expected path" : "phase transaction recoveryId expected verifiedCheckpoint","phase transaction recoveryId expected");
        var rec=recovery,identity=owner(p.transaction);
        if(rec && rec.manual)fail("unsafe_state","Recovery mode changed");
        if(!rec || rec.id!==p.recoveryId || (rec.owner && rec.owner!==identity) || app.project!==rec.projectObject || stringify(p.expected)!==rec.snapshot || stringify(inspect())!==rec.snapshot)
            fail("unsafe_state","Stopped snapshot changed; preserve current edits and recover manually");
        requireFiles();
        if(preparing){
            if(rec.phase!=="stopped")fail("unsafe_state","Recovery prepare is single-use");
            str(p.path,"emergency path");
            var slash=String.fromCharCode(92),local=p.path.split(slash).join("/");
            if((local.charAt(0)!=="/" && (!/^[A-Za-z]:/.test(local) || local.charAt(2)!=="/")) || local.substr(0,2)==="//" || !/[.]aepx?$/i.test(local))fail("invalid_path","Absolute local recovery project required");
            var file=new File(p.path);
            if(file.exists)fail("unsafe_state","Emergency destination already exists");
            rec.phase="saving";
            try {
                app.project.save(file);
                if(project().path!==file.fsName)fail("unsafe_state","Emergency save did not confirm its path");
                var saved=inspect(),prior=parse(rec.snapshot),normalized=parse(stringify(saved));
                normalized.project=prior.project;delete normalized.fingerprint;delete prior.fingerprint;
                // AE Save As may increment revision once without changing scene data.
                // Only our synchronous save may refresh these locators; extra revisions still fail closed.
                if(saved.revision!==prior.revision && saved.revision!==prior.revision+1)fail("unsafe_state","Unexpected revision while saving emergency file");
                function savedRevision(value) {
                    if(!value || typeof value!=="object")return;
                    if(value.locator)value.locator.revision=prior.revision;
                    var key;for(key in value)if(own(value,key))savedRevision(value[key]);
                }
                normalized.revision=prior.revision;savedRevision(normalized);
                if(stringify(normalized)!==stringify(prior))fail("unsafe_state","State or revision changed while saving emergency file");
                rec.snapshot=stringify(saved);rec.phase="saved";
                return {status:"recovery_saved",project:project(),snapshot:saved};
            }catch(saveError){uncertain=true;fail("uncertain_outcome","Emergency save failed; do not close or retry");}
        }
        if(p.phase!=="recovery_finish" || rec.phase!=="saved")fail("invalid_payload","Unknown recovery phase");
        object(p.verifiedCheckpoint,"id hash size","id hash size");str(p.verifiedCheckpoint.id,"checkpoint");
        if(!/^[a-f0-9]{64}$/.test(p.verifiedCheckpoint.hash))fail("invalid_payload","Verified emergency hash required");
        num(p.verifiedCheckpoint.size,1,9007199254740991,true);
        if(app.project.dirty!==false)fail("unsafe_state","Dirty or unknown state after emergency verification");
        var canonicalFile=pathFile(rec.project.path);
        if(!/[.]aepx?$/i.test(canonicalFile.fsName))fail("invalid_path","Expected a verified AE project");
        if(app.onError)fail("unsafe_state","Application error callback prevents automatic close");
        if(app.project!==rec.projectObject || stringify(inspect())!==rec.snapshot || app.project.dirty!==false)
            fail("unsafe_state","Current state changed before close");
        // Node has verified the emergency checkpoint and unchanged canonical bytes.
        // No await/UI turn occurs between the exact snapshot check and documented close.
        rec.phase="closing";
        try {
            if(!app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES))fail("unsafe_state","Project close was refused");
            if(!app.open(canonicalFile))fail("unsafe_state","Canonical reopen was refused");
            var restored=inspect();
            if(app.project.dirty!==false)fail("unsafe_state","Reopened project changed before confirmation");
            if(stringify(restored.project)!==stringify(rec.project))fail("unsafe_state","Recovery identity did not return");
            recovery=null;transaction=null;
            return {status:"recovered",project:restored.project,snapshot:restored};
        }catch(closeError){uncertain=true;fail("uncertain_outcome","Recovery close/open could not be confirmed; emergency checkpoint retained");}
    }
    function templates(compId) {
        ready(false);
        var c=item(compId,"comp"),q=app.project.renderQueue,i,entry,status,r=null;
        if(q.rendering!==false || app.onError)fail("unsafe_state","Template discovery requires an idle queue without application error callbacks");
        // No existing render flag is toggled: terminal history does not need restoration.
        for(i=1;i<=q.numItems;i++) {
            entry=q.item(i);status=entry.status;
            if(entry.onStatusChanged || typeof status==="undefined" ||
                (status!==RQItemStatus.QUEUED && status!==RQItemStatus.UNQUEUED && status!==RQItemStatus.NEEDS_OUTPUT &&
                status!==RQItemStatus.DONE && status!==RQItemStatus.USER_STOPPED && status!==RQItemStatus.ERR_STOPPED))
                fail("unsafe_state","Queue contains callbacks, active/paused rendering or unknown status; leave it untouched");
        }
        try { r=q.items.add(c);return {renderSettings:r.templates.slice(0),outputModules:r.outputModule(1).templates.slice(0)}; }
        finally { if(r)r.remove(); }
    }
    function expectedState(p) {
        if(own(p,"expectedEpoch")){
            str(p.expectedEpoch,"expectedEpoch");project();
            if(p.expectedEpoch!==projectEpoch)fail("stale_project","Native project instance changed before execution");
        }
        if(own(p,"expectedRevision")){
            num(p.expectedRevision,1,9007199254740991,true);
            if(p.expectedRevision!==app.project.revision)fail("stale_revision","Native project revision changed before execution");
        }
        if(own(p,"expectedProject")){
            object(p.expectedProject,"id path","id path");str(p.expectedProject.id,"project id");
            if(p.expectedProject.path !== null)str(p.expectedProject.path,"project path");
            var current=project();
            if(current.id!==p.expectedProject.id || current.path!==p.expectedProject.path)fail("stale_project","Project changed before execution");
        }
    }
    function rawScript(p) {
        object(p,"source expectedRevision expectedProject expectedEpoch label","source");ready(true);str(p.source,"source",true);
        if(own(p,"label"))str(p.label,"label");
        expectedState(p);
        var modern=own(p,"expectedRevision"), run=modern ? new Function(p.source) : null, started=false, group=false, value, result;
        function jsonValue(v,ancestors) {
            var i,k,r;
            if(v === null || typeof v==="string" || typeof v==="boolean" || (typeof v==="number" && isFinite(v)))return v;
            if(!v || typeof v!=="object" || (!array(v) && (Object.prototype.toString.call(v)!=="[object Object]" || v.constructor!==Object)))
                fail("unsupported_value","Script returned a non-JSON value");
            if(ancestors.length>=64)fail("unsupported_value","Script result nesting limit");
            for(i=0;i<ancestors.length;i++)if(ancestors[i]===v)fail("unsupported_value","Script returned a circular value");
            ancestors.push(v);r=array(v) ? [] : {};
            if(array(v)){for(i=0;i<v.length;i++)r.push(jsonValue(v[i],ancestors));}
            else{for(k in v)if(own(v,k)){if(k==="__proto__" || k==="constructor" || k==="prototype")fail("unsupported_value","Unsafe script result key");r[k]=jsonValue(v[k],ancestors);}}
            ancestors.pop();return r;
        }
        try{
            app.beginUndoGroup(own(p,"label") ? p.label : "CookieMonster AE raw");group=true;
            expectedState(p);plan=null;started=true;
            // Arbitrary unsandboxed script BODY in the new contract; legacy eval retains its completion value.
            value=modern ? run() : eval(p.source);
            result={value:typeof value==="undefined" ? null : jsonValue(value,[])};
            if(modern){result.revision=app.project.revision;result.project=project();}
            if(stringify(result).length>LIMIT-512)fail("response_too_large","Script result exceeds transport budget");
        }catch(e){
            if(!started)throw e;
            uncertain=true;
            var line=e && (e.line || e.lineNumber), message=String(e && e.message || e).substr(0,1200);
            fail("uncertain_outcome","Script error at line "+(line || "unavailable")+": "+message+"; partial changes and external side effects may remain. Checkpoint recovery required; do not retry.");
        }finally{
            if(group)try{app.endUndoGroup();}catch(undoError){uncertain=true;fail("uncertain_outcome","Script undo group could not close; partial changes may remain; do not retry");}
        }
        return result;
    }
    function capture(params) {
        ready(true);requireFiles();
        var c=item(params.compId,"comp"), alpha=own(params,"alpha") ? bool(params.alpha) : true, maxWidth=own(params,"maxWidth") ? num(params.maxWidth,1,2000,true) : 2000;
        time(params.time,c);expectedState(params);
        if(typeof c.saveFrameToPng!=="function")fail("unsupported_capability","Native frame capture is unavailable in this AE version");
        if(app.project.renderQueue.rendering!==false || app.onError)fail("unsafe_state","Capture requires an idle queue without application error callbacks");
        var dir=new Folder(Folder.temp.fsName+"/cookiemonster-ae-"+new Date().getTime()+"-"+Math.floor(Math.random()*1000000000));
        if(dir.exists || !dir.create())fail("capture_failed","Cannot create private frame directory");
        var file=new File(dir.fsName+"/frame_00000.png");
        // This undocumented API can finish after evalScript returns. CEP waits for a complete PNG.
        // Never remove its destination after dispatch: even an exception may leave a native writer active.
        c.saveFrameToPng(params.time,file);
        return {path:file.fsName,tempDir:dir.fsName,pending:true,alpha:alpha,maxWidth:maxWidth};
    }
    function dispatch(jsonString) {
        try {
            var request=parse(jsonString),p,result,text,mutationStarted=false;
            object(request,"method params expectedProject","method params");str(request.method,"method");p=request.params;
            if(own(request,"expectedProject")) {
                object(request.expectedProject,"id path saved","id path saved");
                if(stringify(request.expectedProject)!==stringify(project()))fail("stale_project","Project changed before host dispatch; explicitly rebind");
            }
            if(busy)fail("busy","Host command already running");
            ready(false);
            if(recovery && request.method!=="status" && request.method!=="inspect" && request.method!=="reconcile" &&
                !(request.method==="execute" && (p.phase==="recovery_prepare" || p.phase==="recovery_finish" || p.phase==="restore_prepare" || p.phase==="restore_finish")))
                fail("unsafe_state","Stopped execution permits only inspected recovery");
            if(request.method==="status"){
                object(p,"");
                var compositions=[], ci, currentComp=app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
                for(ci=1;ci<=app.project.numItems && compositions.length<2000;ci++){
                    var composition=app.project.item(ci);
                    if(composition instanceof CompItem)compositions.push({id:composition.id,name:composition.name,time:composition.time});
                }
                result={project:project(),activeCompId:currentComp ? currentComp.id : null,compositions:compositions,
                    aeVersion:String(app.version),capabilities:capability(),busy:busy,uncertain:uncertain};
            }
            else if(request.method==="inspect"){
                object(p,"query restore");
                if(own(p,"restore")){
                    if(own(p,"query") || p.restore!==RESTORE_PROOF)fail("restore_unsupported","Matching compact restore protocol required");
                    result=restoreGuard();
                }else result=own(p,"query") ? inspectQuery(p.query) : inspect();
            }
            else if(request.method==="preflight"){
                object(p,"actions","actions");ready(true);var snapshot=inspect();result=validate(p.actions);plan={actions:stringify(result.actions),snapshot:stringify(snapshot),imports:importPins(result.actions)};
            } else if(request.method==="execute"){
                if(own(p,"phase"))result=executePhase(p);
                else {object(p,"actions","actions");if(recovery)fail("unsafe_state","Stopped execution requires recovery");result=execute(p.actions);}
                mutationStarted=p.phase!=="begin";
            }
            else if(request.method==="save"){object(p,"");ready(true);requireFiles();app.project.save(app.project.file);result={project:project()};}
            else if(request.method==="open"){
                object(p,"path","path");requireFiles();
                // dirty is an undocumented AE read; absent/unknown must never authorize discarding a project.
                if(app.project.dirty!==false)fail("unsafe_state","Dirty or unknown project state: save or close manually before open/recovery");
                var file=pathFile(p.path);if(!/\.aepx?$/i.test(p.path))fail("invalid_path","Expected an AE project");
                if(!app.open(file))fail("open_cancelled","Project open cancelled");plan=null;result={project:project()};
            } else if(request.method==="raw"){
                result=rawScript(p);
            } else if(request.method==="capture"){
                object(p,"compId time alpha maxWidth expectedRevision expectedProject expectedEpoch","compId time");busy=true;try{result=capture(p);}finally{busy=false;}
            } else if(request.method==="templates"){object(p,"compId","compId");result=templates(p.compId);}
            else if(request.method==="confirmIdle"){object(p,"");fail("unsafe_state","An idle assertion cannot authorize safe capture without qualified preview/modal detection");}
            else if(request.method==="reconcile"){object(p,"");uncertain=false;plan=null;transaction=null;recovery=null;result={project:project()};}
            else fail("unsupported_method","Unknown host method");
            text=stringify({result:result});
            if(text.length>LIMIT)fail("response_too_large","Complete host response exceeds limit");
            return text;
        } catch(e) {
            if(mutationStarted || (recovery && request && request.method==="execute" && p &&
                (p.phase==="recovery_prepare" || p.phase==="recovery_finish" || p.phase==="restore_prepare" || p.phase==="restore_finish"))){
                uncertain=true;return stringify({error:{code:"uncertain_outcome",message:"Execution or recovery could not be confirmed ("+(e.code || "host_error")+"); do not retry"}});
            }
            return stringify({error:{code:e.code || "host_error",message:String(e.message || e).substr(0,2048)}});
        }
    }
    return {dispatch:dispatch};
}());
