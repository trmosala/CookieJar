/* Run in AE via File > Scripts > Run Script File, with an empty unsaved project.
 * Uses the production host against a disposable project in Folder.temp.
 * Does not change preferences, close projects, or touch existing project files.
 * Reports host behavior only: this does not test CEP, chat approvals or the bridge.
 */
(function () {
    var root = new File($.fileName).parent.parent;
    var dir = new Folder(Folder.temp.fsName + "/cm-ae-host-smoke-" + new Date().getTime());
    var report = null;
    function encode(v) {
        var a = [], k, i;
        if (v === null) return "null";
        if (typeof v === "string") return '"' + v.replace(/[\\"\u0000-\u001f]/g, function (c) {
            return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) a.push(encode(v[i]));
            return "[" + a.join(",") + "]";
        }
        for (k in v) if (v.hasOwnProperty(k)) a.push(encode(k) + ":" + encode(v[k]));
        return "{" + a.join(",") + "}";
    }
    function record(step, value) {
        if (!report.open("a")) throw new Error("Cannot append smoke report");
        report.writeln(encode({step: step, value: value}));
        report.close();
    }
    function call(method, params, refusal) {
        var text = CookieMonsterAE.dispatch(encode({method: method, params: params}));
        // Response comes exclusively from the local production host loaded below.
        var response = eval("(" + text + ")");
        record(method, response);
        if (refusal) {
            if (!response.error || response.error.code !== refusal) throw new Error("Expected " + refusal);
        } else if (response.error) throw new Error(response.error.code + ": " + response.error.message);
        return response.result;
    }
    try {
        if (!app.project || app.project.file || app.project.numItems !== 0 || app.project.dirty === true)
            throw new Error("Open an empty unsaved project before running the smoke test. Existing work was left untouched.");
        if (dir.exists || !dir.create()) throw new Error("Cannot create unique smoke directory");
        report = new File(dir.fsName + "/report.jsonl");
        report.encoding = "UTF-8";
        if (!report.open("w")) throw new Error("Cannot write report; enable scripting file access deliberately");
        report.close();
        record("environment", {aeVersion: String(app.version), os: $.os, source: root.fsName + "/panel/host.jsx"});
        $.evalFile(new File(root.fsName + "/panel/host.jsx"));
        var status = call("status", {});
        if (!status.capabilities.fileNetwork) throw new Error("Scripting file access is disabled; preference left unchanged");
        app.project.save(new File(dir.fsName + "/First Test.aep"));
        var before = call("inspect", {query: {}});
        call("save", {});
        var saved = call("inspect", {query: {}});
        if (saved.revision !== before.revision) throw new Error("Save changed native revision; workflow checkpoint guard needs qualification");
        var created = call("raw", {
            source: 'var c = app.project.items.addComp("CookieMonster First Test", 1280, 720, 1, 3, 24);' +
                'var t = c.layers.addText("Hello from CookieMonster");' +
                'var p=t.property("ADBE Text Properties").property("ADBE Text Document"),d=p.value;' +
                'd.fontSize=64;d.applyFill=true;d.fillColor=[1,1,1];d.applyStroke=false;p.setValue(d);' +
                'var r=t.sourceRectAtTime(0,false);' +
                't.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([r.left+r.width/2,r.top+r.height/2]);' +
                't.property("ADBE Transform Group").property("ADBE Position").setValue([640,360]);' +
                'var o = t.property("ADBE Transform Group").property("ADBE Opacity");' +
                'o.setValueAtTime(0,0); o.setValueAtTime(1,100);' +
                'return {compId:c.id,layerId:t.id};',
            label: "CookieMonster first host test", expectedRevision: saved.revision,
            expectedEpoch: saved.projectEpoch, expectedProject: {id: saved.project.id, path: saved.project.path}
        });
        var after = call("inspect", {query: {compId: created.value.compId, layerId: created.value.layerId, depth: 2}});
        if (after.revision <= before.revision) throw new Error("Script did not advance native revision");
        call("raw", {source: 'throw new Error("Stale source must never execute");', expectedRevision: before.revision,
            expectedEpoch: before.projectEpoch, expectedProject: {id: before.project.id, path: before.project.path}}, "stale_revision");
        call("capture", {compId: created.value.compId, time: 1, alpha: true, maxWidth: 1280,
            expectedRevision: after.revision, expectedEpoch: after.projectEpoch,
            expectedProject: {id: after.project.id, path: after.project.path}});
        app.project.itemByID(created.value.compId).openInViewer();
        app.project.itemByID(created.value.compId).time = 1;
        call("save", {});
        record("PASS", {project: app.project.file.fsName, compId: created.value.compId});
    } catch (e) {
        if (report) record("FAIL", {message: String(e.message || e), line: e.line || null});
        else $.writeln("CookieMonster smoke refused: " + String(e.message || e));
    } finally {
        $.writeln("CookieMonster host smoke report: " + dir.fsName + "/report.jsonl");
    }
}());
