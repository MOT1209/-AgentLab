/**
 * The whole UI as one self-contained page (no build step, no external requests).
 * All dynamic text is inserted with textContent, never innerHTML, because it can come from an LLM or an app.
 * Do not use template literals or backslashes inside the <script>: this file is itself a template literal.
 */
export function pageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentLab</title>
<style nonce="${nonce}">
:root{--bg:#f5f6f8;--card:#fff;--fg:#1b1f24;--muted:#5d6672;--line:#dde1e6;--brand:#2563eb;--brand-fg:#fff;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--info:#475569;--okbg:#dcfce7;--warnbg:#fef3c7;--badbg:#fee2e2;--infobg:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c22;--fg:#e6e9ee;--muted:#9aa4b2;--line:#2b333c;--brand:#3b82f6;--okbg:#12301e;--warnbg:#3a2a0c;--badbg:#3b1717;--infobg:#242c36;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--info:#cbd5e1}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;background:var(--card);border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:20px}
header .sub{color:var(--muted);font-size:13px}
main{max-width:1100px;margin:0 auto;padding:16px;display:grid;gap:16px;grid-template-columns:minmax(0,380px) minmax(0,1fr)}
@media (max-width:860px){main{grid-template-columns:1fr}}
.col{display:grid;gap:16px;align-content:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{margin:0 0 10px;font-size:15px}
.card.off{opacity:.45;pointer-events:none}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:64px;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row>*{flex:1}
button{padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg);font-weight:600}
button.danger{border-color:var(--bad);color:var(--bad)}
button:disabled{opacity:.5;cursor:not-allowed}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{flex:1;border:0;border-radius:0}
.seg button.on{background:var(--brand);color:var(--brand-fg)}
.note{font-size:12.5px;color:var(--muted);margin:8px 0 0}
.warn{background:var(--warnbg);color:var(--warn);padding:8px 10px;border-radius:8px;font-size:13px;margin-top:10px}
.err{background:var(--badbg);color:var(--bad);padding:8px 10px;border-radius:8px;font-size:13px;margin-top:10px}
.dev{display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:8px;margin-top:6px;cursor:pointer}
.dev small{color:var(--muted)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--infobg);color:var(--info)}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}
.bar{height:8px;background:var(--infobg);border-radius:99px;overflow:hidden;margin:10px 0}
.bar>div{height:100%;background:var(--brand);width:0;transition:width .3s}
.tl{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-height:340px;overflow:auto}
.tl li{border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.tl .a{font-weight:700;font-size:13px;direction:ltr;display:inline-block}
.tl .r{color:var(--muted);font-size:13px}
.tl .res{font-size:12.5px}.tl .res.ok{color:var(--ok)}.tl .res.bad{color:var(--bad)}
.shots{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.shots img{height:90px;border:1px solid var(--line);border-radius:6px;cursor:pointer}
#big{max-width:100%;max-height:480px;display:block;margin:0 auto;border:1px solid var(--line);border-radius:8px}
.f{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:6px}
.empty{color:var(--muted);text-align:center;padding:30px 10px}
.kv{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-top:8px}
.hide{display:none}.w120{width:190px}.mt10{margin-top:10px}.mt12{margin-top:12px}.mt16{margin-top:16px}.m0{margin:0}.between{justify-content:space-between}.row>.pill{flex:0 0 auto}.row>h2{flex:1}
a.btn{display:inline-block;padding:9px 14px;border:1px solid var(--line);border-radius:8px;color:var(--fg);text-decoration:none}
</style>
</head>
<body>
<header>
  <div><h1>AgentLab</h1><div class="sub" id="tagline"></div></div>
  <div class="seg w120"><button id="lang-ar">العربية</button><button id="lang-en">English</button></div>
</header>
<main>
  <div class="col">
    <section class="card">
      <h2 id="t-mode"></h2>
      <div class="seg"><button id="mode-demo"></button><button id="mode-real"></button></div>
      <p class="note" id="mode-note"></p>
    </section>

    <section class="card" id="card-device">
      <h2 id="t-device"></h2>
      <button id="btn-refresh"></button>
      <div id="devices"></div>
      <div id="device-err" class="err hide"></div>
      <p class="note" id="device-help"></p>
    </section>

    <section class="card" id="card-model">
      <h2 id="t-model"></h2>
      <label id="l-kind"></label>
      <select id="kind"><option value="anthropic">Claude (Anthropic API)</option><option value="openai-compatible"></option></select>
      <label id="l-model"></label><input type="text" id="model" dir="ltr" value="claude-sonnet-5-5" autocomplete="off">
      <div id="url-wrap" class="hide"><label id="l-url"></label><input type="text" id="baseUrl" dir="ltr" placeholder="http://localhost:11434/v1" autocomplete="off"></div>
      <label id="l-key"></label><input type="password" id="apiKey" dir="ltr" autocomplete="off" placeholder="sk-ant-...">
      <div class="row mt10"><button class="primary" id="btn-save"></button><button id="btn-test"></button><button id="btn-clear"></button></div>
      <div id="model-status" class="note"></div>
      <div class="warn" id="privacy"></div>
    </section>

    <section class="card" id="card-run">
      <h2 id="t-run"></h2>
      <div id="pkg-wrap"><label id="l-pkg"></label><input type="text" id="pkg" dir="ltr" placeholder="com.example.app" autocomplete="off"></div>
      <label id="l-obj"></label><textarea id="obj"></textarea>
      <div class="row"><div><label id="l-steps"></label><input type="number" id="steps" min="1" max="200" value="15"></div><div><label id="l-time"></label><input type="number" id="time" min="10" max="1800" value="180"></div></div>
      <div class="row mt12"><button class="primary" id="btn-start"></button><button class="danger hide" id="btn-cancel"></button></div>
      <div id="run-err" class="err hide"></div>
    </section>
  </div>

  <div class="col">
    <section class="card">
      <div class="row between"><h2 id="t-live" class="m0"></h2><span class="pill" id="status"></span></div>
      <div class="bar"><div id="bar"></div></div>
      <div id="empty" class="empty"></div>
      <div id="live" class="hide">
        <img id="big" alt="">
        <div class="shots" id="shots"></div>
        <h2 class="mt16" id="t-steps"></h2>
        <ol class="tl" id="tl"></ol>
        <h2 class="mt16" id="t-find"></h2>
        <div id="finds"></div>
        <div id="summary" class="note"></div>
        <div class="kv" id="telemetry"></div>
        <div class="mt12" id="dl"></div>
      </div>
    </section>
  </div>
</main>
<script nonce="${nonce}">
(function(){
var TEXT={
ar:{tagline:'اختبار تطبيقات أندرويد بالذكاء الاصطناعي',mode:'الوضع',demo:'تجربة (بدون جهاز ولا مفتاح)',real:'جهاز حقيقي',
modeDemo:'تشغيل تجريبي مبرمج مسبقاً: يثبت أن الواجهة تعمل، ولا يختبر أي تطبيق حقيقي.',modeReal:'يستخدم هاتفك أو المحاكي ونموذج الذكاء الاصطناعي الذي تحدده. لم يُجرَّب على أجهزة حقيقية بعد، فتوقع أخطاء.',
device:'1. الجهاز',refresh:'بحث عن الأجهزة',noDev:'لا توجد أجهزة. شغّل محاكياً أو وصّل هاتفاً (USB debugging) ثم اضغط بحث.',
devHelp:'يجب تثبيت adb، وأن يظهر جهازك بحالة device في الأمر adb devices.',
model:'2. نموذج الذكاء الاصطناعي',kind:'النوع',ocompat:'نموذج محلي / متوافق مع OpenAI (Ollama, OpenRouter...)',modelName:'اسم النموذج',url:'عنوان الخادم (Base URL)',key:'مفتاح API',keySaved:'محفوظ في الذاكرة (اتركه فارغاً للإبقاء عليه)',
save:'حفظ',test:'اختبار الاتصال',clear:'مسح',notConf:'لم يُعدّ النموذج بعد.',conf:'مُعدّ: ',keyIn:'المفتاح يُحفظ في ذاكرة البرنامج فقط ولا يُكتب على القرص ولا يُعرض هنا مرة أخرى.',
privacy:'تنبيه: نصوص واجهة التطبيق وأسطر السجل تُرسل إلى مزود النموذج. لا تختبر تطبيقاً يعرض بيانات شخصية حقيقية.',
run:'3. الاختبار',pkg:'اسم الحزمة (Package) — يجب أن يكون التطبيق مثبتاً على الجهاز',obj:'ما الذي تريد البحث عنه؟',steps:'أقصى عدد خطوات',time:'المهلة (ثوانٍ)',
objDef:'استكشف التطبيق وابحث عن الانهيارات وعطل التنقل والأزرار التي لا تستجيب ومشاكل الواجهة الواضحة.',
start:'ابدأ الاختبار',cancel:'إيقاف',live:'النتيجة المباشرة',idle:'جاهز',running:'يعمل...',
empty:'لا يوجد تشغيل بعد. اختر الوضع واضغط «ابدأ الاختبار».',steps2:'الخطوات',find:'النتائج (Findings)',noFind:'لا نتائج.',
verified:'مُتحقَّق منه',ai:'ملاحظة النموذج (غير مؤكدة)',download:'تنزيل التقرير (JSON)',
PASSED:'نجح',FAILED:'فشل (عُثر على علّة)',BLOCKED:'متعثر',CANCELLED:'أُلغي',TIMEOUT:'انتهت المهلة',MAX_STEPS_REACHED:'بلغ حد الخطوات',ERROR:'خطأ',
actions:'إجراءات',failed:'فاشلة',calls:'طلبات للنموذج',tokens:'رموز (دخل/خرج)',secs:'ثانية',ok:'نجح: ',bad:'فشل: ',
needDev:'اختر جهازاً أولاً.',needPkg:'أدخل اسم الحزمة.',needModel:'أعدّ النموذج أولاً.',saved:'تم الحفظ.',testing:'جارٍ الاختبار...',noToken:'افتح الرابط الذي طُبع في الطرفية (يحتوي على رمز سري).'},
en:{tagline:'AI-driven Android app testing',mode:'Mode',demo:'Demo (no device, no key)',real:'Real device',
modeDemo:'A scripted demo run: proves the UI works. It does not test any real app.',modeReal:'Uses your phone or emulator and the AI model you configure. Not yet tried on real hardware, so expect rough edges.',
device:'1. Device',refresh:'Find devices',noDev:'No devices. Start an emulator or connect a phone (USB debugging), then press Find.',
devHelp:'adb must be installed and your device must show as "device" in adb devices.',
model:'2. AI model',kind:'Type',ocompat:'Local / OpenAI-compatible (Ollama, OpenRouter...)',modelName:'Model name',url:'Server URL (Base URL)',key:'API key',keySaved:'Saved in memory (leave empty to keep it)',
save:'Save',test:'Test connection',clear:'Clear',notConf:'Model not configured yet.',conf:'Configured: ',keyIn:'The key is kept in program memory only. It is never written to disk or shown again.',
privacy:'Note: the app UI text and log lines are sent to the model provider. Do not test an app that shows real personal data.',
run:'3. Test',pkg:'Package name — the app must already be installed on the device',obj:'What should it look for?',steps:'Max steps',time:'Timeout (seconds)',
objDef:'Explore the application and identify crashes, broken navigation, unresponsive controls and obvious UI problems.',
start:'Start test',cancel:'Stop',live:'Live result',idle:'Ready',running:'Running...',
empty:'No run yet. Pick a mode and press "Start test".',steps2:'Steps',find:'Findings',noFind:'No findings.',
verified:'verified',ai:'model observation (unverified)',download:'Download report (JSON)',
PASSED:'Passed',FAILED:'Failed (bug found)',BLOCKED:'Blocked',CANCELLED:'Cancelled',TIMEOUT:'Timed out',MAX_STEPS_REACHED:'Step limit reached',ERROR:'Error',
actions:'actions',failed:'failed',calls:'model calls',tokens:'tokens (in/out)',secs:'s',ok:'OK: ',bad:'Failed: ',
needDev:'Select a device first.',needPkg:'Enter the package name.',needModel:'Configure the model first.',saved:'Saved.',testing:'Testing...',noToken:'Open the link printed in the terminal (it contains a secret token).'}
};
var lang=(function(){try{return localStorage.getItem('lang')||'ar'}catch(e){return 'ar'}})();
var mode='demo',selected=null,last=null,bigId=null,busy=false;
var token=new URLSearchParams(location.search).get('token');
try{if(token){sessionStorage.setItem('t',token)}else{token=sessionStorage.getItem('t')}}catch(e){}
if(location.search){history.replaceState(null,'',location.pathname)}
function $(id){return document.getElementById(id)}
function t(k){return (TEXT[lang]&&TEXT[lang][k])||k}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function api(method,path,body){
  return fetch(path,{method:method,headers:{'x-agentlab-token':token||'','content-type':'application/json'},body:body?JSON.stringify(body):undefined})
   .then(function(r){return r.json().then(function(j){if(!r.ok){throw new Error(j.error||('HTTP '+r.status))}return j})});
}
function showErr(id,msg){var e=$(id);if(msg){e.textContent=msg;e.classList.remove('hide')}else{e.classList.add('hide')}}

function applyText(){
  document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
  var map={tagline:'tagline','t-mode':'mode','mode-demo':'demo','mode-real':'real','t-device':'device','btn-refresh':'refresh','device-help':'devHelp','t-model':'model','l-kind':'kind','l-model':'modelName','l-url':'url','l-key':'key','btn-save':'save','btn-test':'test','btn-clear':'clear','privacy':'privacy','t-run':'run','l-pkg':'pkg','l-obj':'obj','l-steps':'steps','l-time':'time','btn-start':'start','btn-cancel':'cancel','t-live':'live','empty':'empty','t-steps':'steps2','t-find':'find'};
  for(var id in map){$(id).textContent=t(map[id])}
  $('kind').options[1].textContent=t('ocompat');
  $('mode-note').textContent=t(mode==='demo'?'modeDemo':'modeReal');
  $('apiKey').placeholder=(last&&last.provider&&last.provider.keyPresent)?t('keySaved'):'sk-...';
  if(!$('obj').dataset.touched){$('obj').value=t('objDef')}
  $('lang-ar').classList.toggle('on',lang==='ar');$('lang-en').classList.toggle('on',lang==='en');
  $('mode-demo').classList.toggle('on',mode==='demo');$('mode-real').classList.toggle('on',mode==='real');
  $('card-device').classList.toggle('off',mode==='demo');$('card-model').classList.toggle('off',mode==='demo');$('pkg-wrap').classList.toggle('hide',mode==='demo');
  if(last)render(last);
}

function renderDevices(s){
  var box=$('devices');box.textContent='';
  var list=s.devices.list;
  if(!list.length){box.appendChild(el('p','note',t('noDev')))}
  list.forEach(function(d){
    var row=el('label','dev');var r=document.createElement('input');r.type='radio';r.name='dev';r.checked=(selected===d.id);
    r.addEventListener('change',function(){selected=d.id});
    row.appendChild(r);
    var info=el('div');info.appendChild(el('div',null,d.id));
    info.appendChild(el('small',null,[d.source,d.model,d.androidVersion?('Android '+d.androidVersion):null,d.state].filter(Boolean).join(' · ')));
    row.appendChild(info);box.appendChild(row);
  });
  if(!selected&&list.length){selected=list[0].id}
  showErr('device-err',s.devices.error);
}
function renderModel(s){
  var p=s.provider,st=$('model-status');
  if(!p.configured){st.textContent=t('notConf');return}
  var line=t('conf')+p.model+(p.baseUrl?(' @ '+p.baseUrl):'')+' — '+t('keyIn');
  if(p.test){line+=' ['+(p.test.ok?'✓ ':'✗ ')+p.test.message+']'}
  st.textContent=line;
}
function pillFor(run){
  var pill=$('status');pill.className='pill';
  if(!run){pill.textContent=t('idle');return}
  if(run.status==='running'){pill.textContent=t('running');pill.classList.add('warn');return}
  var st=run.result?run.result.status:'ERROR';
  pill.textContent=t(st);
  pill.classList.add(st==='PASSED'||st==='MAX_STEPS_REACHED'?'ok':(st==='FAILED'||st==='ERROR'?'bad':'warn'));
}
function render(s){
  renderDevices(s);renderModel(s);
  var run=s.run;
  pillFor(run);
  $('btn-cancel').classList.toggle('hide',!(run&&run.status==='running'));
  $('btn-start').disabled=!!(run&&run.status==='running')||busy;
  if(!run){$('empty').classList.remove('hide');$('live').classList.add('hide');$('bar').style.width='0';return}
  $('empty').classList.add('hide');$('live').classList.remove('hide');
  var evs=run.events,actions=evs.filter(function(e){return e.kind==='action'}),shots=evs.filter(function(e){return e.kind==='screenshot'});
  $('bar').style.width=Math.min(100,Math.round(100*actions.length/run.params.maxSteps))+'%';
  var tl=$('tl');tl.textContent='';
  actions.forEach(function(a){
    var li=el('li');li.appendChild(el('span','a','#'+a.step+' '+a.action));
    var p=a.params||{};var extra=[];if(p.target)extra.push('('+p.target.x+', '+p.target.y+')');if(p.text)extra.push('"'+p.text+'"');if(extra.length){li.appendChild(el('span','r',' '+extra.join(' ')))}
    li.appendChild(el('div','r',a.reason||''));
    li.appendChild(el('div','res '+(a.ok?'ok':'bad'),(a.ok?t('ok'):t('bad'))+(a.detail||'')));
    tl.appendChild(li);
  });
  tl.scrollTop=tl.scrollHeight;
  var box=$('shots');box.textContent='';
  shots.forEach(function(sh){
    var img=document.createElement('img');img.src='/api/run/screenshot/'+sh.id+'?t='+encodeURIComponent(token||'')+'&r='+run.id;img.alt=sh.id;
    img.addEventListener('click',function(){bigId=sh.id;$('big').src=img.src});box.appendChild(img);
  });
  if(shots.length){var cur=bigId&&shots.some(function(x){return x.id===bigId})?bigId:shots[shots.length-1].id;var u='/api/run/screenshot/'+cur+'?t='+encodeURIComponent(token||'')+'&r='+run.id;if($('big').getAttribute('src')!==u&&(!bigId||run.status==='running')){$('big').src=u;if(run.status==='running'){bigId=null}}$('big').classList.remove('hide')}else{$('big').classList.add('hide')}
  var finds=run.result?run.result.findings:evs.filter(function(e){return e.kind==='finding'});
  var fb=$('finds');fb.textContent='';
  if(!finds.length){fb.appendChild(el('p','note',t('noFind')))}
  finds.forEach(function(f){
    var d=el('div','f');var badge=el('span','pill '+(f.source==='VERIFIED'?'bad':''),f.severity);d.appendChild(badge);
    d.appendChild(el('span',null,' '+f.title+' '));d.appendChild(el('small','note','— '+(f.source==='VERIFIED'?t('verified'):t('ai'))));
    if(f.description){d.appendChild(el('div','note',f.description))}
    fb.appendChild(d);
  });
  $('summary').textContent=run.result?run.result.summary:(run.error||'');
  var tel=$('telemetry');tel.textContent='';
  if(run.result){var m=run.result.telemetry;
    [m.actions+' '+t('actions')+' ('+m.actionFailures+' '+t('failed')+')',m.llmCalls+' '+t('calls'),m.inputTokens+'/'+m.outputTokens+' '+t('tokens'),(m.durationMs/1000).toFixed(1)+' '+t('secs')].forEach(function(x){tel.appendChild(el('span',null,x))});
  }
  var dl=$('dl');dl.textContent='';
  if(run.result){var a=el('a','btn',t('download'));a.href='/api/run/report?t='+encodeURIComponent(token||'');dl.appendChild(a)}
}
function refresh(){
  if(!token){showErr('run-err',t('noToken'));return Promise.resolve()}
  return api('GET','/api/state').then(function(s){last=s;render(s);if($('apiKey').placeholder!==undefined){applyKeyPlaceholder()}}).catch(function(e){showErr('run-err',e.message)});
}
function applyKeyPlaceholder(){$('apiKey').placeholder=(last&&last.provider&&last.provider.keyPresent)?t('keySaved'):'sk-...'}

$('lang-ar').addEventListener('click',function(){lang='ar';try{localStorage.setItem('lang','ar')}catch(e){}applyText()});
$('lang-en').addEventListener('click',function(){lang='en';try{localStorage.setItem('lang','en')}catch(e){}applyText()});
$('mode-demo').addEventListener('click',function(){mode='demo';applyText()});
$('mode-real').addEventListener('click',function(){mode='real';applyText();$('btn-refresh').click()});
$('obj').addEventListener('input',function(){$('obj').dataset.touched='1'});
$('kind').addEventListener('change',function(){var o=$('kind').value==='openai-compatible';$('url-wrap').classList.toggle('hide',!o);$('model').value=o?'':'claude-sonnet-5-5';$('apiKey').placeholder=o?'(optional)':'sk-ant-...'});
$('btn-refresh').addEventListener('click',function(){showErr('device-err');api('POST','/api/devices/refresh').then(function(s){last=s;render(s)}).catch(function(e){showErr('device-err',e.message)})});
$('btn-save').addEventListener('click',function(){
  showErr('run-err');
  api('POST','/api/provider',{kind:$('kind').value,model:$('model').value,baseUrl:$('baseUrl').value,apiKey:$('apiKey').value}).then(function(s){$('apiKey').value='';last=s;render(s);applyKeyPlaceholder();$('model-status').textContent=t('saved')+' '+$('model-status').textContent}).catch(function(e){showErr('run-err',e.message)});
});
$('btn-test').addEventListener('click',function(){$('model-status').textContent=t('testing');api('POST','/api/provider/test').then(function(){return refresh()}).catch(function(e){$('model-status').textContent=e.message})});
$('btn-clear').addEventListener('click',function(){api('POST','/api/provider/clear').then(function(s){last=s;render(s);applyKeyPlaceholder()})});
$('btn-start').addEventListener('click',function(){
  showErr('run-err');
  if(mode==='real'){
    if(!selected){return showErr('run-err',t('needDev'))}
    if(!last||!last.provider.configured){return showErr('run-err',t('needModel'))}
    if(!$('pkg').value.trim()){return showErr('run-err',t('needPkg'))}
  }
  busy=true;bigId=null;
  api('POST','/api/run',{mode:mode,package:$('pkg').value,objective:$('obj').value,maxSteps:Number($('steps').value),timeoutMs:Number($('time').value)*1000,deviceId:selected||undefined})
   .then(function(){busy=false;return refresh()}).catch(function(e){busy=false;showErr('run-err',e.message)});
});
$('btn-cancel').addEventListener('click',function(){api('POST','/api/run/cancel').then(refresh).catch(function(e){showErr('run-err',e.message)})});

applyText();refresh();setInterval(refresh,1000);
})();
</script>
</body>
</html>`;
}
