import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build-plugin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const GUID = '{7C91D48E-5F12-4B36-8A90-2DFA8467C013}';
const VERSION = process.env.R7_AI_ASSISTANT_DEB_VERSION || '0.9.0-pilot-rc';
const OWNED = Object.freeze(['LICENSE','THIRD_PARTY_NOTICES.md','config.json','index.html','panel.js','resources/icon.png','resources/icon@2x.png','styles.css']);
const PAYLOAD_ROOT = 'usr/share/r7-ai-assistant/plugin';
const MANIFEST_PATH = 'usr/share/doc/r7-ai-assistant/product-owned-files.txt';
const COMPATIBILITY_PATH = 'usr/share/r7-ai-assistant/compatibility.json';
const PREFLIGHT_PATH = 'usr/bin/r7-ai-assistant-preflight';
const CONTROL_PATH = resolve(root, 'packaging/deb/control');
const EPOCH = 0;

function pad(value, block = 2) { return (block - value % block) % block; }
function field(value, width) { const out = Buffer.alloc(width, 0x20); Buffer.from(String(value)).copy(out); return out; }
function ar(entries) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const entry of entries) {
    const header = Buffer.concat([field(`${entry.name}/`,16),field(EPOCH,12),field(0,6),field(0,6),field('100644',8),field(entry.data.length,10),Buffer.from('`\n')]);
    parts.push(header, entry.data); if (entry.data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}
function tar(entries) {
  const parts = [];
  for (const entry of [...entries].sort((a,b)=>a.name.localeCompare(b.name))) {
    const directory = entry.type === 'directory';
    const data = directory ? Buffer.alloc(0) : entry.data;
    const h = Buffer.alloc(512); const name = Buffer.from(`./${entry.name}`); name.copy(h,0); Buffer.from(directory ? '0000755\0' : '0000644\0').copy(h,100); Buffer.from('0000000\0').copy(h,108); Buffer.from('0000000\0').copy(h,116);
    Buffer.from(`${data.length.toString(8).padStart(11,'0')}\0`).copy(h,124); Buffer.from('00000000000\0').copy(h,136); h.fill(0x20,148,156); h[156]=directory ? 0x35 : 0x30; if (entry.executable) Buffer.from('0000755\0').copy(h,100); Buffer.from('ustar\0').copy(h,257); Buffer.from('00').copy(h,263); Buffer.from('root\0').copy(h,265); Buffer.from('root\0').copy(h,297);
    Buffer.from(`${[...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')}\0 `).copy(h,148); parts.push(h,data,Buffer.alloc(pad(data.length,512)));
  }
  parts.push(Buffer.alloc(1024)); return Buffer.concat(parts);
}
function untar(data) {
  const files={}; const directories=[]; for(let o=0;o+512<=data.length;){const h=data.subarray(o,o+512); if(h.every(b=>b===0)) break; const name=h.subarray(0,100).toString().replace(/\0.*$/,'').replace(/^\.\//,''); const size=parseInt(h.subarray(124,136).toString().replace(/\0.*$/,'').trim()||'0',8); const type=String.fromCharCode(h[156]); if(type==='5') directories.push(name); else files[name]=data.subarray(o+512,o+512+size); o+=512+size+pad(size,512);} return {files,directories};
}
function unar(data) { const out={}; if(data.subarray(0,8).toString()!=='!<arch>\n') throw new Error('INVALID_DEB'); for(let o=8;o<data.length;){const h=data.subarray(o,o+60); const name=h.subarray(0,16).toString().trim().replace(/\/$/,''); const size=Number(h.subarray(48,58).toString().trim()); out[name]=data.subarray(o+60,o+60+size); o+=60+size+(size%2);} return out; }
function parseControl(data){return Object.fromEntries(data.toString('utf8').trim().split('\n').map(line=>{const i=line.indexOf(':');return [line.slice(0,i),line.slice(i+1).trim()]}));}
function parentDirectories(entries) {
  return [...new Set(entries.flatMap(({name}) => { const parts=name.split('/'); return parts.slice(0,-1).map((_,index)=>`${parts.slice(0,index+1).join('/')}/`); }))].sort().map(name=>({name,type:'directory'}));
}
export function inspectDeb(data){const a=unar(data); if(a['debian-binary']?.toString()!=='2.0\n')throw new Error('INVALID_DEB'); const control=untar(a['control.tar']); const payload=untar(a['data.tar']); return {control:parseControl(control.files.control),data:payload.files,directories:payload.directories.sort()};}
export async function buildDeb(){await buildPlugin(); const data=[]; for(const name of OWNED)data.push({name:`${PAYLOAD_ROOT}/${name}`,data:await readFile(resolve(root,'dist/plugin',name))}); data.push({name:MANIFEST_PATH,data:Buffer.from(`${OWNED.map(name=>`$HOME/.local/share/r7-office/editors/sdkjs-plugins/${GUID}/${name}`).join('\n')}\n`)}); data.push({name:COMPATIBILITY_PATH,data:await readFile(resolve(root,'packaging/compatibility.json'))}); data.push({name:PREFLIGHT_PATH,data:await readFile(resolve(root,'packaging/deb/r7-ai-assistant-preflight')),executable:true}); const control=Buffer.from((await readFile(CONTROL_PATH,'utf8')).replace(/^Version:.*$/m,`Version: ${VERSION}`)); const deb=ar([{name:'debian-binary',data:Buffer.from('2.0\n')},{name:'control.tar',data:tar([{name:'control',data:control}])},{name:'data.tar',data:tar([...parentDirectories(data),...data])}]); const debPath=resolve(root,`dist/deb/r7-ai-assistant_${VERSION}_amd64.deb`); await mkdir(dirname(debPath),{recursive:true}); await writeFile(debPath,deb); return {debPath,sha256:createHash('sha256').update(deb).digest('hex'),files:data.map(x=>x.name).sort()};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await buildDeb();process.stdout.write(`DEB build: ${r.files.length} regular files; SHA-256 ${r.sha256}\n${r.debPath}\n`);}
