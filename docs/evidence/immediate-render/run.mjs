// Minimal CDP client for the local R7 desktop (dev-only, gitignored under .local/).
// Usage:
//   node cdp.mjs targets
//   node cdp.mjs contexts
//   node cdp.mjs eval <contextId> "<js expression>"
//   node cdp.mjs click <contextId> "<css selector>"
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:8080';
import { readFile } from 'node:fs/promises';

async function listTargets() {
  const response = await fetch(`${BASE}/json/list`);
  return response.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      events,
      close() { socket.close(); },
      onMessage(handler) { listeners.push(handler); }
    }));
    const listeners = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
        return;
      }
      for (const handler of listeners) handler(message);
      events.push(message);
    });
    socket.addEventListener('error', reject);
  });
}

async function attachEditor() {
  const targets = (await listTargets()).filter(target => target.type === 'page');
  const wanted = process.env.CDP_MATCH;
  const editor = targets.find(target => target.url.includes(wanted));
  if (!wanted || !editor) throw new Error('Required disposable target not found');
  const client = await connect(editor.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await new Promise(resolve => setTimeout(resolve, 700));
  const contexts = client.events
    .filter(event => event.method === 'Runtime.executionContextCreated')
    .map(event => event.params.context);
  return { client, editor, contexts };
}


import {createHash} from 'node:crypto';
const GUID='asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function ev(a,id,expression){const r=await a.client.send('Runtime.evaluate',{contextId:id,expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Evaluation failed');return r.result?.value}
async function context(a,needle){for(const c of a.contexts){const href=await ev(a,c.id,'location.href');if(href.includes(needle))return c.id}return null}
async function panel(kind){
 process.env.CDP_MATCH='title='+(kind==='slide'?'visual5-':'visual4-')+kind+'.';let a=await attachEditor();const main=await context(a,{word:'documenteditor/main',cell:'spreadsheeteditor/main',slide:'presentationeditor/main'}[kind]);
 await ev(a,main,`window.g_asc_plugins.isRunned(${JSON.stringify(GUID)}) || window.g_asc_plugins.run(${JSON.stringify(GUID)},0,'')`);a.client.close();await delay(600);
 for(let i=0;i<6;i++){a=await attachEditor();const id=await context(a,'7C91D48E-5F12');if(id!==null)return {...a,id,kind};a.client.close();await delay(400)}throw Error('Panel missing')
}
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);const kind=process.argv[2];const base=process.argv[3];
const a=await panel(kind);const editorId=await context(a,{word:'documenteditor/main',cell:'spreadsheeteditor/main',slide:'presentationeditor/main'}[kind]);
await a.client.send('Debugger.enable'); await delay(100); const scripts=a.client.events.filter(e=>e.method==='Debugger.scriptParsed'&&e.params.url.endsWith('/panel.js')); if(!scripts.length)throw Error('Loaded bundle absent'); const loaded=await a.client.send('Debugger.getScriptSource',{scriptId:scripts.at(-1).params.scriptId});console.log(JSON.stringify({loadedPanelSha256:createHash('sha256').update(loaded.scriptSource).digest('hex')}));
const dom=await ev(a,editorId,`[...document.querySelectorAll('[id]')].filter(e=>/zoom|comment/.test(e.id)).map(e=>({id:e.id,text:e.textContent.slice(0,100)}))`);console.log(JSON.stringify({dom}));
await ev(a,a.id,`document.getElementById('stop').click()`);
await ev(a,a.id,`(()=>{document.getElementById('mode').value='EDIT';document.getElementById('mode').dispatchEvent(new Event('change',{bubbles:true}));const c=document.getElementById('include-context');if(c.checked){c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}))}document.getElementById('check-r7').click();return true})()`);await delay(500);
const reads={cell:"var s=Api.GetActiveSheet(),r=s.GetRange('A1'),f=r.GetFillColor();return [Api.GetSheets().map(function(x){return x.GetName()}),s.GetName(),s.GetRange('A1:B2').GetValue(),r.GetCharacters().GetFont().GetBold(),r.GetCharacters().GetFont().GetSize(),typeof f==='string'?f:f.color.getRgb(),r.GetRowHeight(),r.GetColumnWidth(),s.GetRange('B1').GetNumberFormat()];",word:"var d=Api.GetDocument();return [d.GetAllParagraphs().map(function(p){return p.GetText()}),d.GetAllTables().length,d.ToHtml(),d.GetAllImages().map(function(x){return [x.GetWidth(),x.GetHeight()]}),d.GetAllComments().map(function(x){return x.GetText()})];",slide:"var p=Api.GetPresentation(),a=[];for(var i=0;i<p.GetSlidesCount();i++){var s=p.GetSlideByIndex(i),txt=[];s.GetAllShapes().forEach(function(x){var d=x.GetContent();if(d)for(var k=0;k<d.GetElementsCount();k++)txt.push(d.GetElement(k).GetText())});a.push({text:txt,drawings:s.GetAllDrawings().length,images:s.GetAllImages().map(function(x){return [x.GetWidth(),x.GetHeight()]})});}return [JSON.stringify(a)];"};
const rawRead=()=>ev(a,a.id,`new Promise(resolve=>Asc.plugin.callCommand(function(){${reads[kind]}},false,false,resolve))`);
const read=async()=>{const value=await rawRead();if(!Array.isArray(value))throw Error('Independent readback missing');return kind==='slide'?JSON.parse(value[0]):value;};
const scenarios=JSON.parse(await readFile(base+'/'+kind+'-cases.json','utf8'));
let current=null;let pending=Promise.resolve();
await a.client.send('Fetch.enable',{patterns:[{urlPattern:'https://api.deepseek.com/v1/chat/completions',requestStage:'Request'}]});
a.client.onMessage(event=>{if(event.method!=='Fetch.requestPaused')return;pending=pending.then(async()=>{
 const e=event.params;if(!current)throw Error('Unexpected request');
 if(e.request.method==='OPTIONS'){await a.client.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:204,responseHeaders:[{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Methods',value:'POST, OPTIONS'},{name:'Access-Control-Allow-Headers',value:'authorization, content-type, x-session-id, x-request-id'}]});return;}
 const post=JSON.parse(e.request.postData);const results=[];for(const m of post.messages??[]){if(m.role!=='user')continue;try{const j=JSON.parse(m.content);if(j.type==='tool_results')results.push(j)}catch{}}
 if(current.index===1){await delay(250);await exec('import',['-window','root',base+'/'+current.name+'-immediate.png'],{env:{...process.env,DISPLAY:':0',XAUTHORITY:'/home/r7dev/.Xauthority'}});current.screenshot=true;current.results=results;}
 const response=current.index===0 ? {type:'tool_calls',calls:[{tool:current.tool,arguments:current.args}]} : (current.index===1 || current.index===3 && kind==='slide') ? {type:'tool_calls',calls:[{tool:{word:'read_structure',cell:'list_sheets',slide:'read_presentation'}[kind],arguments:{}},...(kind==='slide'?[{tool:'read_slide',arguments:{slideIndex:0}}]:[])]} : {type:'final',message:'Visual check completed'};
 current.index++;if(current.index>7)throw Error('Completion loop');
 await a.client.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'}],body:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]})).toString('base64')});
}).catch(err=>{console.error('Harness failed',err.message);process.exitCode=1;});});
try{
 for(const row of scenarios){
  current={...row,index:0};
  if(row.confirm){await ev(a,a.id,`new Promise(resolve=>Asc.plugin.callCommand(function(){return Api.GetDocument().GetAllParagraphs()[3].GetRange(0,7).Select()},false,false,resolve))`);await ev(a,a.id,`(()=>{const c=document.getElementById('include-context');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);}
  current.before=await read();
  await exec('import',['-window','root',base+'/'+row.name+'-before.png'],{env:{...process.env,DISPLAY:':0',XAUTHORITY:'/home/r7dev/.Xauthority'}});
  await ev(a,a.id,`(()=>{document.getElementById('new-chat').click();document.getElementById('prompt').value=${JSON.stringify('Check '+row.tool)};document.getElementById('composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
  for(let i=0;i<160;i++){await delay(100);if(current.index>0&&await ev(a,a.id,`document.getElementById('stop').hidden`))break;}
  await pending;
  if(row.confirm){const enabled=await ev(a,a.id,`!document.getElementById('apply').disabled`);current.previewReady=enabled;if(!enabled)throw Error('Owned preview not ready');await ev(a,a.id,`document.getElementById('apply').click()`);for(let i=0;i<100;i++){await delay(50);if(await ev(a,a.id,`document.getElementById('stop').hidden && document.getElementById('apply').disabled`))break;}await delay(250);await exec('import',['-window','root',base+'/'+row.name+'-immediate.png'],{env:{...process.env,DISPLAY:':0',XAUTHORITY:'/home/r7dev/.Xauthority'}});current.screenshot=true;current.applyStatus=await ev(a,a.id,`document.getElementById('status').textContent`);await ev(a,a.id,`(()=>{const c=document.getElementById('include-context');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);}
  const status=await ev(a,a.id,`({status:document.getElementById('status').textContent,detail:document.getElementById('connection-status').textContent,actions:document.getElementById('actions').textContent,active:!document.getElementById('stop').hidden})`);
  if(!current.screenshot){await exec('import',['-window','root',base+'/'+row.name+'-immediate.png'],{env:{...process.env,DISPLAY:':0',XAUTHORITY:'/home/r7dev/.Xauthority'}});current.screenshot=true;} current.after=await read();console.log(JSON.stringify({editor:kind,...current,status}));
  if(!current.screenshot||status.active)throw Error('No completed screenshot');
 }
}finally{await a.client.send('Fetch.disable');a.client.close()}
