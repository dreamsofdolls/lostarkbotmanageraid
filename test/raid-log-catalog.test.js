"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRaidLogCatalog, normalizeCatalogLogs } = require('../bot/services/raid-log/catalog');
const { raidLogErrorCode } = require('../bot/services/raid-log/errors');
const { createImageCache } = require('../bot/services/raid-log/image-cache');
const row = (id, boss='Death Incarnate Kazeros', timestamp=100) => ({ id, boss, timestamp, name:'Qiylyn', difficulty:'Hard' });

test('catalog groups known gates, preserves unknown raids and rejects malformed or wrong-character rows',()=>{
 const logs = normalizeCatalogLogs([row('g2'), row('g1','Abyss Lord Kazeros'), row('other','Unknown boss')], 'Qiylyn');
 assert.deepEqual(logs.slice(0,2).map(x=>[x.raidKey,x.gate]),[['kazeros','G2'],['kazeros','G1']]);
 assert.equal(logs[2].raidLabel,'Unknown boss');
 assert.match(logs[2].raidKey,/^boss-/);
 assert.equal(normalizeCatalogLogs([row('yes'),{...row('no'),name:'Other'}],'qiylyn').length,1);
 for(const item of [{...row('x'),timestamp:1e30},{...row('x'),timestamp:null},row('../bad')]) assert.throws(()=>normalizeCatalogLogs([item],'Qiylyn'),{code:'unavailable'});
 assert.throws(()=>normalizeCatalogLogs([row('x')],'Other'),{code:'character_mismatch'});
});

test('catalog opens one page, loads older pages lazily, deduplicates and checks privacy on every verification',async()=>{
 const calls=[]; let privateLogs=false;
 const catalog=createRaidLogCatalog({client:{
  fetchBibleCharacterProfileWithLimiter:async name=>{calls.push(['profile',name]);return {name:'Qiylyn',cid:1,sn:'s',rid:2,className:'Aeromancer'};},
  fetchBibleLogsWithLimiter:async args=>{
   calls.push(['logs',args.page]);
   if(privateLogs) throw Object.assign(new Error('Logs not enabled'),{status:403,bodyText:'{"error":"Logs not enabled"}'});
   return args.page===1 ? Array.from({length:25},(_,i)=>row(`a${i}`,undefined,100-i)) : [row('a24'),row('old','Witch of Agony, Serca',5)];
  },
 }});
 const first=await catalog.open('qiylyn');
 assert.deepEqual(calls,[['profile','qiylyn'],['logs',1]]);
 assert.equal(first.logs.length,25); assert.equal(first.hasMore,true);
 const more=await catalog.more(first);
 assert.equal(more.logs.length,26);assert.equal(more.hasMore,false);assert.equal(first.logs.length,25);
 await catalog.verify(more);
 assert.deepEqual(calls.at(-1),['logs',1]);
 privateLogs=true;
 await assert.rejects(catalog.verify(more),error=>raidLogErrorCode(error)==='logs_private');
 await assert.rejects(catalog.more(more),{code:'invalid_selection'});
});

test('empty or mismatching catalog never becomes a selectable panel',async()=>{
 let reads=0;
 const client={fetchBibleCharacterProfileWithLimiter:async()=>({name:'Other'}),fetchBibleLogsWithLimiter:async()=>{reads++;return [];}};
 await assert.rejects(createRaidLogCatalog({client}).open('Qiylyn'),{code:'character_mismatch'});
 assert.equal(reads,0);
 client.fetchBibleCharacterProfileWithLimiter=async()=>({name:'Qiylyn'});
 await assert.rejects(createRaidLogCatalog({client}).open('Qiylyn'),{code:'no_logs'});
});

test('repeated source pages stop loading without claiming extra history, and history stops at its page budget',async()=>{
 const rows=Array.from({length:25},(_,i)=>row(`a${i}`,undefined,100-i));
 let reads=0;
 const catalog=createRaidLogCatalog({client:{
  fetchBibleCharacterProfileWithLimiter:async()=>({name:'Qiylyn'}),
  fetchBibleLogsWithLimiter:async()=>{reads++;return rows;},
 }});
 const first=await catalog.open('Qiylyn');
 const repeated=await catalog.more(first);
 assert.equal(repeated.hasMore,false);assert.equal(repeated.logs.length,25);
 await assert.rejects(catalog.more(repeated),{code:'invalid_selection'});
 await assert.rejects(catalog.more({...first,page:10}),{code:'invalid_selection'});
 assert.equal(reads,2);
});

test('image cache enforces byte budget, LRU and TTL without retaining oversized images',()=>{
 let now=0;
 const cache=createImageCache({maxBytes:6,ttlMs:10,now:()=>now});
 const result=id=>({id,buffer:Buffer.alloc(3)});
 cache.set('a',result('a'));cache.set('b',result('b'));cache.get('a');cache.set('c',result('c'));
 assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a').id,'a');
 cache.set('huge',{buffer:Buffer.alloc(7)});assert.equal(cache.get('huge'),undefined);
 now=10;assert.equal(cache.get('a'),undefined);assert.equal(cache.get('c'),undefined);
 cache.set('d',result('d'));assert.equal(cache.get('d').id,'d');
});
