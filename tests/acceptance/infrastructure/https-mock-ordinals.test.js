import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { startMock, SYNTHETIC_KEY } from './https-mock.mjs';
import { tlsFixture } from './tls-fixture.mjs';

const ids = [1, 2, 3].map(n => `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`);
const body = JSON.stringify({model:'qwen', messages:[{role:'system',content:'Synthetic only'},{role:'user',content:'Synthetic input'}],max_tokens:1024,temperature:0.2});
async function fixture(options, run) {
 const tls = await tlsFixture(); let mock;
 const config = {keyPath:tls.keyPath,certPath:tls.certPath,listenAddress:'127.0.0.1',port:0,prefix:'/ordinal',profile:'final',corsOrigin:'null',delayMs:100,...options};
 try { mock = await startMock(config); await run(mock,tls,config); }
 finally { try { if(mock) await mock.close(); } finally { await tls.cleanup(); } }
}
function post(mock,tls,id,override={}) {
 return new Promise((resolve,reject) => {
  const req=https.request({hostname:'127.0.0.1',port:mock.port,path:'/ordinal/v1/chat/completions',method:'POST',agent:false,ca:tls.ca,headers:{Authorization:`Bearer ${SYNTHETIC_KEY}`,'Content-Type':'application/json','X-Session-ID':id,...override}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));res.on('error',reject);});
  req.on('error',reject);req.end(body);
 });
}

test('opt-in ordinals attribute accepted ASK/Test/NewChat identity sequence without identifiers',async()=>{
 await fixture({sessionOrdinalLimit:8},async(mock,tls)=>{
  for(const index of [0,0,1,0,2]) assert.equal(await post(mock,tls,ids[index]),200);
  const stats=mock.stats();
  assert.deepEqual(stats.acceptedSessionOrdinals,[1,1,2,1,3]);
  assert.equal(stats.sessionOrdinalCapacityReached,false);
  assert.equal(stats.sessions,3);assert.equal(stats.repeatedSessions,2);
  const serialized=JSON.stringify(stats);
  for(const id of ids) {
   assert.equal(serialized.includes(id),false);
   assert.equal(serialized.includes(createHash('sha256').update(id).digest('hex')),false);
  }
  assert.equal(serialized.includes('Synthetic input'),false);
  assert.equal(serialized.includes(SYNTHETIC_KEY),false);
 });
});
test('default stats contract omits all ordinal diagnostics',async()=>{
 await fixture({},async(mock,tls)=>{
  assert.equal(await post(mock,tls,ids[0]),200);
  assert.equal(Object.hasOwn(mock.stats(),'acceptedSessionOrdinals'),false);
  assert.equal(Object.hasOwn(mock.stats(),'sessionOrdinalCapacityReached'),false);
 });
});
test('rejected posts never allocate an ordinal or append a sample',async()=>{
 await fixture({sessionOrdinalLimit:8},async(mock,tls)=>{
  assert.equal(await post(mock,tls,ids[1],{Authorization:'Bearer PUBLIC-WRONG-SYNTHETIC'}),401);
  assert.equal(await post(mock,tls,'not-a-uuid'),400);
  assert.equal(await post(mock,tls,ids[0]),200);
  assert.deepEqual(mock.stats().acceptedSessionOrdinals,[1]);
  assert.equal(mock.stats().sessions,1);
 });
});
test('ordinal samples are bounded, immutable snapshots and survive owned close as integers only',async()=>{
 await fixture({sessionOrdinalLimit:2},async(mock,tls,config)=>{
  config.sessionOrdinalLimit=64; // Trusted config must be snapshotted.
  assert.equal(await post(mock,tls,ids[0]),200);
  const first=mock.stats();assert.deepEqual(first.acceptedSessionOrdinals,[1]);
  assert.equal(Object.isFrozen(first.acceptedSessionOrdinals),true);
  assert.throws(()=>first.acceptedSessionOrdinals.push(9),TypeError);
  for(const index of [0,1,0,2]) assert.equal(await post(mock,tls,ids[index]),200);
  const last=mock.stats();assert.deepEqual(last.acceptedSessionOrdinals,[1,1]);
  assert.equal(last.sessionOrdinalCapacityReached,true);
  assert.deepEqual(first.acceptedSessionOrdinals,[1]);
  assert.equal(last.accepted,5);assert.equal(last.sessions,3);
  await mock.close();assert.deepEqual(mock.stats().acceptedSessionOrdinals,[1,1]);
 });
});
test('upper ordinal bound saturates with session storage and never emits a zero or identifier',async()=>{
 await fixture({sessionOrdinalLimit:64},async(mock,tls)=>{
  for(let n=1;n<=65;n++) assert.equal(await post(mock,tls,`12345678-1234-4123-8123-${String(n).padStart(12,'0')}`),200);
  const stats=mock.stats();
  assert.deepEqual(stats.acceptedSessionOrdinals,Array.from({length:64},(_,i)=>i+1));
  assert.equal(stats.sessionOrdinalCapacityReached,true);
  assert.equal(stats.sessionCapacityReached,true);assert.equal(stats.sessions,64);assert.equal(stats.accepted,65);
 });
});
test('lower bound admits one sample and session UUID matching stays case-insensitive',async()=>{
 await fixture({sessionOrdinalLimit:1},async(mock,tls)=>{
  const id='12345678-abcd-4123-8123-123456789abc';
  assert.equal(await post(mock,tls,id),200);assert.equal(await post(mock,tls,id.toUpperCase()),200);
  assert.deepEqual(mock.stats().acceptedSessionOrdinals,[1]);
  assert.equal(mock.stats().sessionOrdinalCapacityReached,true);
  assert.equal(mock.stats().sessions,1);assert.equal(mock.stats().repeatedSessions,1);
 });
});
test('ordinal limits require explicit bounded integers; unknown request toggles cannot opt in',async()=>{
 const tls=await tlsFixture();
 try {
  const base={keyPath:tls.keyPath,certPath:tls.certPath,listenAddress:'127.0.0.1',port:0,prefix:'/ordinal',profile:'final',corsOrigin:'null',delayMs:100};
  for(const limit of [0,-1,65,1.5,Infinity,null,undefined,false,'8']) await assert.rejects(startMock({...base,sessionOrdinalLimit:limit}),{message:'MOCK_CONFIG_INVALID'});
  await assert.rejects(startMock({...base,sessionOrdinals:true}),{message:'MOCK_CONFIG_INVALID'});
 }finally{await tls.cleanup();}
});
