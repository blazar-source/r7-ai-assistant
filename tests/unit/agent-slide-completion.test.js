import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/runtime.js';
import { createRegistry } from '../../src/tools/registry.js';

const final = message => ({type:'final', message});
const calls = (...names) => ({type:'tool_calls', calls:names.map(tool=>({tool,arguments:{}}))});
function fixture(overrides={}) {
  const deck=['old0','old1','old2','old3','old4'];
  const executed=[];
  const handlers={
    add_slide(){deck.splice(1,0,'new');return {slidesCount:6,slideIndex:1};},
    move_slide(){deck.push(...deck.splice(1,1));return {fromIndex:1,toIndex:5};},
    read_presentation(){return {slidesCount:deck.length,texts:[...deck]};},
    read_slide(){return {text:deck.at(-1)};}
  };
  const registry=createRegistry(Object.keys(handlers).map(name=>({
    name,kind:name.startsWith('read_')?'read':'mutate',editors:['slide'],policy:'auto',requires:[],
    description:'Slide fixture',schema:{type:'object',additionalProperties:false,required:[],properties:{}},
    precondition:()=>null,execute:()=>{executed.push(name);return overrides[name]?.()??{ok:true,data:handlers[name]()};}
  })));
  return {deck,executed,options:{registry,editor:'slide',mode:'EDIT',capabilities:['document.read','document.write'],request:'Добавь слайд new в конец; проверь порядок и текст.',settings:{},uuid:'fixture'}};
}
async function run(f,sequence,extra={}) {
  const sent=[];let index=0;
  const result=await runAgent({...f.options,...extra,transport:async messages=>{
    sent.push(messages);return {content:JSON.stringify(sequence[Math.min(index++,sequence.length-1)])};
  }});
  return {result,sent};
}
test('candidate Slide final is reviewed, repairs placement, then verifies structure and text without creating twice',async()=>{
  const f=fixture();const {result,sent}=await run(f,[calls('add_slide'),calls('read_slide'),final('premature'),calls('read_presentation'),calls('move_slide'),calls('read_presentation','read_slide'),final('verified')]);
  assert.equal(result.message,'verified');assert.equal(result.status,'FINAL');
  assert.deepEqual(f.deck,['old0','old1','old2','old3','old4','new']);
  assert.equal(f.executed.filter(x=>x==='add_slide').length,1);
  assert.match(sent[3].at(-1).content,/исходного запроса/);
  assert.ok(!sent[3].some(x=>x.content.includes('premature')),'candidate prose does not evict tool evidence');
});
test('reads before the review cannot justify an immediate repeated final',async()=>{
  const f=fixture();const {result}=await run(f,[calls('add_slide'),calls('read_presentation','read_slide'),final('premature'),final('still premature')]);
  assert.equal(result.status,'INCOMPLETE');assert.equal(result.message,null);assert.equal(result.toolCalls,3);
});
test('a corrective mutation invalidates review readbacks until both are refreshed',async()=>{
  const f=fixture();const {result}=await run(f,[calls('add_slide'),final('candidate'),calls('read_presentation','read_slide'),calls('move_slide'),final('stale')]);
  assert.equal(result.status,'INCOMPLETE');assert.equal(result.toolCalls,4);
});
for(const [name,value] of [['failed',{ok:false,code:'TOOL_ERROR'}],['unserializable',{ok:true,data:1n}]]) {
  test(`${name} review result cannot justify a final`,async()=>{
    const f=fixture({read_presentation:()=>value});const {result}=await run(f,[calls('add_slide'),final('candidate'),calls('read_presentation','read_slide'),final('unproved')]);
    assert.equal(result.status,'INCOMPLETE');
  });
}
test('reading text alone in review does not prove slide order',async()=>{
  const f=fixture();const {result}=await run(f,[calls('add_slide'),final('candidate'),calls('read_slide'),final('unproved')]);
  assert.equal(result.status,'INCOMPLETE');
});
test('uncertain mutation stops before completion review and never retries',async()=>{
  const f=fixture({add_slide:()=>({ok:false,code:'TOOL_UNCERTAIN'})});const {result,sent}=await run(f,[calls('add_slide'),final('candidate')]);
  assert.equal(result.status,'UNCERTAIN');assert.equal(sent.length,1);assert.equal(f.executed.length,1);
});
test('completion review uses existing step and call budgets',async()=>{
  for(const guardrails of [{maxSteps:2},{maxToolCalls:1}]) {
    const f=fixture();const {result}=await run(f,[calls('add_slide'),final('candidate'),calls('read_presentation','read_slide'),final('done')],{guardrails});
    assert.equal(result.status,'LIMIT');assert.equal(result.toolCalls,1);
  }
});
test('ASK and read-only Slide runs do not incur an edit completion review',async()=>{
  for(const mode of ['ASK','EDIT']) {
    const f=fixture();const {result,sent}=await run(f,[calls('read_presentation'),final('answer')],{mode});
    assert.equal(result.status,'FINAL');assert.equal(sent.length,2);
  }
});
for(const type of ['cancel','deadline']) {
  test(`${type} during final transport cannot publish success`,async()=>{
    const f=fixture();const controller=new AbortController();let time=0;
    const result=await runAgent({...f.options,signal:controller.signal,now:()=>time,transport:async()=>{
      if(type==='cancel')controller.abort();else time=200000;
      return {content:JSON.stringify(final('late'))};
    }});
    assert.equal(result.status,type==='cancel'?'CANCELLED':'LIMIT');assert.equal(result.message,null);
  });
}

for (const names of [['move_slide','move_slide'],['add_slide','read_slide'],['read_presentation','add_slide'],['read_presentation','move_slide','read_slide']]) {
  test(`structural Slide batch ${names.join('+')} is refused before any action`,async()=>{
    const f=fixture();const {result,sent}=await run(f,[calls(...names),final('cannot proceed')]);
    assert.equal(result.toolCalls,0);assert.deepEqual(f.executed,[]);
    const refusal=JSON.parse(sent[1].at(-1).content);
    assert.equal(refusal.results[0].code,'TOOL_ERROR');
    assert.match(refusal.results[0].message,/индекс/);
    assert.equal(result.repairs,0,'dependency refusal does not consume protocol repair');
  });
}

test('multiple ordinary Slide reads retain batching',async()=>{
  const f=fixture();const {result}=await run(f,[calls('read_presentation','read_slide'),final('answer')]);
  assert.equal(result.status,'FINAL');assert.equal(result.toolCalls,2);
});
