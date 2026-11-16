const { spawn } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const URL_ = process.argv[2];
(async () => {
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(process.env.TEMP,'cdp_f_'+Date.now())}`,
    '--no-first-run','about:blank'], { stdio:'ignore' });
  let v=null; for(let i=0;i<60&&!v;i++){ try{ v=await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }catch{ await sleep(250);} }
  const t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`,{method:'PUT'})).json();
  const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let seq=0; const pend=new Map(); const logs=[];
  ws.addEventListener('message',ev=>{ const m=JSON.parse(ev.data);
    if(m.id&&pend.has(m.id)){const {res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}
    if(m.method==='Runtime.exceptionThrown') logs.push('EXC '+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text).split('\n')[0]);
    if(m.method==='Log.entryAdded') logs.push('LOG '+m.params.entry.level+' '+m.params.entry.text+' @'+(m.params.entry.url||''));
  });
  const cmd=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));});
  const ev=async e=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?'<<ERR '+(r.exceptionDetails.exception?.description||'').split('\n')[0]+'>>':r.result.value;};
  await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Log.enable');
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cmd('Page.navigate',{url:URL_}); await sleep(1800);
  console.log('URL            :', URL_);
  console.log('TRIPS          :', await ev('typeof TRIPS!=="undefined" ? TRIPS.length : "undefined"'));
  console.log('TAXONOMY       :', await ev('typeof TAXONOMY!=="undefined"'));
  console.log('注册按钮        :', await ev('!!document.querySelector("#doRegister")'));
  console.log('内存提示屏      :', await ev('document.querySelector(".screen h1")?.textContent || "(无)"'));
  console.log('storage        :', await ev('(()=>{try{sessionStorage.setItem("__x","1");return "ok"}catch(e){return "ERR "+e.name}})()'));
  if (await ev('!!document.querySelector("#doRegister")')) {
    await ev('document.querySelector("#phone").value="13800138000"');
    await ev('document.querySelector("#code").value="123456"');
    await ev('document.querySelector("#doRegister").click()');
    await sleep(900);
    console.log('点击后 hash     :', await ev('location.hash'));
  }
  console.log(logs.length ? '日志: '+[...new Set(logs)].join(' | ') : '无日志异常');
  ws.close(); chrome.kill(); await sleep(200);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
