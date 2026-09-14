(function(){
    "use strict";
    var key="cookiejar-presentation-v1",choices={textSize:["small","normal","large"],density:["comfortable","compact"],sendKey:["enter","modifier"],activity:["auto","collapsed","expanded"]};
    var defaults={textSize:"normal",density:"comfortable",sendKey:"enter",activity:"auto"};
    function clean(input){var value={};Object.keys(defaults).forEach(function(k){value[k]=input && choices[k].indexOf(input[k])>=0 ? input[k] : defaults[k];});return value;}
    function read(){try{var raw=window.localStorage.getItem(key);return clean(raw && raw.length<2048 ? JSON.parse(raw) : null);}catch(e){return clean(null);}}
    var value=read();
    function apply(){
        if(document.documentElement){document.documentElement.setAttribute("data-text-size",value.textSize);document.documentElement.setAttribute("data-density",value.density);}
        Object.keys(defaults).forEach(function(k){var control=document.getElementById("preference-"+k);if(control)control.value=value[k];});
    }
    function save(input){value=clean(input);var saved=true;try{window.localStorage.setItem(key,JSON.stringify(value));}catch(e){saved=false;}apply();
        var status=document.getElementById("preferences-status");if(status)status.textContent=saved ? "Preferences saved." : "Applied for this panel; local storage is unavailable.";
        if(window.dispatchEvent && typeof CustomEvent!=="undefined")window.dispatchEvent(new CustomEvent("cookiejar-preferences"));return clean(value);
    }
    window.CookieJarPreferences={get:function(){return clean(value);},set:save,reset:function(){return save(defaults);},shouldSend:function(e){
        if(e.key!=="Enter" || e.isComposing || e.keyCode===229 || e.shiftKey || e.altKey)return false;
        return value.sendKey==="modifier" ? !!(e.ctrlKey || e.metaKey) : !e.ctrlKey && !e.metaKey;
    }};
    Object.keys(defaults).forEach(function(k){var control=document.getElementById("preference-"+k);if(control)control.addEventListener("change",function(){var next=clean(value);next[k]=control.value;save(next);});});
    var reset=document.getElementById("preferences-reset");if(reset)reset.addEventListener("click",window.CookieJarPreferences.reset);
    apply();
}());
