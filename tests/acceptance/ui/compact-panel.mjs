import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// Dev-only rendered acceptance. Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs.
// CHROME_EXECUTABLE optionally selects an existing browser; neither ships in the plugin.
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
await mkdir('.local/sprint9', {recursive:true});
const entry = `import {mountPanel} from './src/ui/view.js';
import {createController} from './src/ui/controller.js';
import {SettingsStore} from './src/config/storage.js';
let release;
const controller=createController({store:new SettingsStore(null),crypto:window.crypto,bridge:{getState(){return {editorType:'word',busy:false,uncertain:false}},invalidate(){},canApply(){return false},async readSelection(){return {text:'fixture',editorType:'word',eligible:false}}},transport:async()=>({content:JSON.stringify({type:'final',message:window.hold?await new Promise(r=>release=r):'# Результат\\n\\nАбзац **важно** и *курсив*, [ссылка](https://example.invalid/), \`code\`.\\n\\n- первый\\n- второй\\n\\n\`\`\`\\n'+ 'long-code-'.repeat(40)+'\\n\`\`\`\\n\\n<img src=x onerror=alert(1)> '})})});
controller.saveSettings({endpoint:'https://example.invalid/v1/chat/completions',apiKey:'synthetic'});
mountPanel(document.querySelector('main'),controller);window.controller=controller;window.finish=()=>release('Готово');`;
const output=await build({stdin:{contents:entry,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
const css=await readFile('src/ui/styles.css');
const server=createServer((req,res)=>{if(req.url==='/styles.css'){res.setHeader('content-type','text/css');res.end(css)}else if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(output.outputFiles[0].contents)}else res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main></main><script src="/fixture.js"></script></body></html>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE});
try{
const page=await browser.newPage({viewport:{width:259,height:499},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.goto('http://127.0.0.1:'+server.address().port);
await page.evaluate(async()=>{for(let i=0;i<10;i++)await controller.analyze('Запрос '+i)});
const measure=()=>page.evaluate(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,right:r.right}};return {doc:[document.documentElement.clientWidth,document.documentElement.scrollWidth,document.documentElement.clientHeight,document.documentElement.scrollHeight],composer:rect('composer'),prompt:rect('prompt'),send:rect('send'),content:rect('content'),header:document.querySelector('header').getBoundingClientRect().height,overflow:[...document.querySelectorAll('*')].filter(el=>el.scrollHeight>el.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(el).overflowY)&&el.tagName!=='TEXTAREA'&&el.tagName!=='PRE').map(el=>el.id),messages:document.querySelectorAll('.message').length,font:getComputedStyle(document.querySelector('.message-body')).fontSize,line:getComputedStyle(document.querySelector('.message-body')).lineHeight}});
const idle=await measure();assert.deepEqual(idle.doc,[259,259,499,499]);assert.equal(idle.header,32);assert.equal(idle.messages,20);assert.ok(idle.composer.h<=51);assert.equal(idle.prompt.h,38);assert.deepEqual(idle.overflow,['content']);assert.equal(idle.font,'12.5px');assert.equal(idle.line,'17px');
await page.evaluate(()=>document.getElementById('content').scrollTop=0);const top=await measure();await page.screenshot({path:'.local/sprint9/implemented-idle-259x499.png'});
await page.evaluate(()=>document.getElementById('content').scrollTop=999999);const bottom=await measure();assert.deepEqual(top.composer,bottom.composer);
await page.evaluate(()=>{window.hold=true;controller.analyze('Рабочий запрос')});await page.waitForFunction(()=>!document.getElementById('stop').hidden);
const active=await measure();const stage=await page.locator('#progress-stage').boundingBox();assert.ok(stage.y+stage.height<=active.content.bottom,'working stage remains visible at transcript tail');assert.ok(active.composer.h<=73);assert.ok(active.send.right<=259&&active.send.bottom<=499);assert.deepEqual(active.doc,[259,259,499,499]);
await page.screenshot({path:'.local/sprint9/implemented-active-259x499.png'});
await page.locator('#prompt').fill('line\n'.repeat(20));const expanded=await measure();assert.equal(expanded.prompt.h,72);assert.equal(expanded.composer.bottom,499);assert.deepEqual(expanded.doc,[259,259,499,499]);
await page.locator('#prompt').fill('');assert.equal((await measure()).prompt.h,38);
await page.locator('#toggle-diagnostics').click();const diagnostics=await measure();assert.deepEqual(diagnostics.overflow,['content']);
await page.locator('#toggle-diagnostics').click();await page.evaluate(()=>window.finish());await page.waitForFunction(()=>document.getElementById('stop').hidden);
await page.keyboard.press('Tab');await page.locator('#new-chat').focus();const focus=await page.locator('#new-chat').evaluate(el=>({style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));assert.equal(focus.style,'solid');
await page.evaluate(()=>document.getElementById('content').scrollTop=999999);
await page.locator('#prompt').fill('long\n'.repeat(20));
await page.evaluate(()=>{window.hold=true;controller.analyze('grow and focus')});
await page.waitForFunction(()=>!document.getElementById('stop').hidden);
const grownStage=await page.locator('#progress-stage').boundingBox();const grown=await measure();assert.ok(grownStage.y+grownStage.height<=grown.content.bottom);
await page.locator('#history a').last().focus();await page.evaluate(()=>window.focusedLink=document.activeElement);await page.evaluate(()=>window.finish());await page.waitForFunction(()=>document.getElementById('stop').hidden);
assert.equal(await page.evaluate(()=>document.activeElement===window.focusedLink&&window.focusedLink.isConnected),true);
await page.locator('#new-chat').click();await page.keyboard.press('Tab');await page.locator('#new-chat').focus();const tabs=[];for(let i=0;i<4;i++){tabs.push(await page.evaluate(()=>document.activeElement.id));await page.keyboard.press('Tab')};assert.deepEqual(tabs,['new-chat','toggle-diagnostics','prompt','send']);
assert.deepEqual(errors,[]);const report={idle,active,expanded,diagnostics,focus,tabs,errors};await writeFile('.local/sprint9/geometry.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();server.close()}
