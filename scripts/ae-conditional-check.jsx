/* Run via File > Scripts > Run Script File in an already-running AE.
 * Reads ../panel/host.jsx; writes only a unique Folder.temp report.
 * Does not load the host, access projects/preferences, or change recovery state.
 * File writing must already be permitted; do not change preferences for this check.
 */
(function () {
    var host = new File(new File($.fileName).parent.parent.fsName + "/panel/host.jsx");
    var report = new File(Folder.temp.fsName + "/cm-ae-conditionals-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000000) + ".txt");
    var source, lines = ["AE=" + String(app.version), "SOURCE=" + host.fsName], passed = 0, failure = null;
    // Synthetic constructors and enums stay local; no native project objects are created.
    function CompItem() {}
    function FolderItem() {}
    var KeyframeInterpolationType = {LINEAR:1, BEZIER:2, HOLD:3};
    var PropertyValueType = {OneD:1, TwoD:2, ThreeD:3, TwoD_SPATIAL:4, ThreeD_SPATIAL:5, COLOR:6};
    function expression(prefix, suffix) {
        var start = source.indexOf(prefix), end;
        if (start < 0 || source.indexOf(prefix, start + prefix.length) >= 0) throw new Error("Missing/ambiguous expression: " + prefix);
        start += prefix.length;
        end = source.indexOf(suffix, start);
        if (end < 0) throw new Error("Missing expression terminator: " + prefix);
        var text = source.substring(start, end);
        lines.push("EXPR=" + text);
        return text;
    }
    function check(name, actual, expected) {
        if (actual !== expected) throw new Error(name + ": expected " + expected + ", got " + actual);
        passed++;
        lines.push("PASS " + name + "=" + actual);
    }
    try {
        if (!host.open("r")) throw new Error("Cannot read host: " + host.error);
        try { source = host.read(); if (host.error) throw new Error(host.error); }
        finally { host.close(); }
        // ponytail: exact source delimiters, not a JS parser; update these if the six sites move structurally.
        var comparator = expression("a.sort(function (a, b) { return ", "; }); return a;");
        var kind = expression("selected:!!p.selected, kind:", "};");
        var interp = expression('return s === "linear" ? ', "; }");
        interp = 's === "linear" ? ' + interp;
        var dims = expression("var dims=", ";");
        var interpolationName = expression("var interpolationName=function(s) { return ", "; };");
        var refKind = expression('refs[a.ref]={kind:', ",object:r,comp:c}");
        var a, b, p, s, i;
        var comparisons = [["A","B",-1], ["B","A",1], ["A","A",0]];
        for (i = 0; i < comparisons.length; i++) {
            a = {matchName:comparisons[i][0]}; b = {matchName:comparisons[i][1]};
            check("comparator." + i, eval(comparator), comparisons[i][2]);
        }
        var items = [new CompItem(), new FolderItem(), {}], kinds = ["comp","folder","footage"];
        for (i = 0; i < items.length; i++) { p = items[i]; check("kind." + kinds[i], eval(kind), kinds[i]); }
        CompItem.prototype = new FolderItem();
        p = new CompItem();
        check("kind.both", eval(kind), "comp");
        var names = ["linear","bezier","hold"];
        for (i = 0; i < names.length; i++) { s = names[i]; check("interp." + s, eval(interp), i + 1); }
        var types = ["OneD","TwoD","ThreeD","TwoD_SPATIAL","ThreeD_SPATIAL","COLOR"], dimensions = [1,2,3,1,1,1];
        for (i = 0; i < types.length; i++) {
            p = {propertyValueType:PropertyValueType[types[i]]};
            check("dims." + types[i], eval(dims), dimensions[i]);
        }
        var enums = [1,2,3,99], labels = ["linear","bezier","hold","bezier"];
        for (i = 0; i < enums.length; i++) { s = String(enums[i]); check("interpolationName." + s, eval(interpolationName), labels[i]); }
        var actions = ["layer.create","comp.create","folder.create","asset.import"], refs = ["layer","comp","folder","footage"];
        for (i = 0; i < actions.length; i++) { a = {type:actions[i]}; check("refs." + a.type, eval(refKind), refs[i]); }
        lines.push("PASS 24/24");
    } catch (e) {
        failure = String(e);
        lines.push("FAIL after " + passed + "/24: " + failure);
    }
    if (report.exists) throw new Error("Report already exists; refusing overwrite: " + report.fsName);
    report.encoding = "UTF-8";
    if (!report.open("w")) throw new Error("Cannot write report (no preferences changed): " + report.error);
    var written;
    try { written = report.write(lines.join("\n") + "\n"); }
    finally { report.close(); }
    if (!written) throw new Error("Report write failed: " + report.fsName);
    $.writeln(report.fsName);
    if (failure) throw new Error(failure + "\nReport: " + report.fsName);
    return report.fsName;
}());
