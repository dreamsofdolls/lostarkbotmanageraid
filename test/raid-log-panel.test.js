"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { RaidLogError } = require('../bot/services/raid-log/errors');
const { createRaidInteractionRouter } = require('../bot/app/interaction-router-registry');

const { fixture, logEntry, captures, controls } = require("./helpers/raid-log-fixture");

test('public panel has exactly three dropdowns then Bracketed and disabled Detail in every locale',async()=>{
 for(const lang of ['vi','en','jp']) {
  const f=fixture({lang});await f.run();
  assert.equal(f.events[0],'ack');
  const rows=f.payload.components.map(row=>row.toJSON());
  assert.deepEqual(rows.map(row=>row.components.map(c=>c.type)),[[3],[3],[3],[2,2]]);
  assert.deepEqual(rows[0].components[0].options.map(o=>o.label),['Damage','Party Buffs','Self Buffs','Shields','Tanked']);
  assert.deepEqual(rows[1].components[0].options.map(o=>o.value),['kazeros','serca']);
  assert.deepEqual(rows[2].components[0].options.map(o=>o.value),['new','old']);
  assert.equal(rows[3].components[0].label,'Bracketed: ON');assert.equal(rows[3].components[1].disabled,true);
  assert.doesNotMatch(JSON.stringify(f.payload),/raid-log\.controls|raid-log\.character/);
 }
});

test('another member can change tabs and Bracketed, with immediate ACK before privacy and rendering',async()=>{
 const f=fixture();await f.run();const old=f.component('tab','party_buffs');f.events.length=0;
 await f.click(old);
 assert.deepEqual(f.events.slice(0,2),['ack-update','verify']);
 assert.equal(captures(f)[0][2].tab,'party_buffs');assert.equal(captures(f)[0][2].useCache,true);
 assert.equal(controls(f)[0].options.find(x=>x.default).value,'party_buffs');
 await f.click(f.component('bracketed'));
 assert.equal(captures(f).at(-1)[2].bracketed,false);
 assert.match(controls(f)[3].label,/OFF.*Normalized/);
 await f.click(old);assert.match(f.events.at(-1)[1].content,/cập nhật/);
 assert.equal(f.events.at(-1)[1].flags,MessageFlags.Ephemeral);
});

test('raid selection chooses its latest log, confines the log menu to that raid and rejects forged values',async()=>{
 const f=fixture();await f.run();
 await f.click(f.component('raid','serca'));
 assert.equal(captures(f).at(-1)[1],'https://lostark.bible/logs/serca');
 assert.deepEqual(controls(f)[2].options.map(x=>x.value),['serca']);
 const before=captures(f).length;
 await f.click(f.component('log','new'));assert.equal(captures(f).length,before);
 await f.click(f.component('raid','empty-raid'));assert.equal(captures(f).length,before);
 await f.click(f.component('detail'));assert.equal(captures(f).length,before);
 await f.click(f.component('tab','damage',{channelId:'different'}));assert.equal(captures(f).length,before);
 await f.click(f.component('tab','damage',{message:{id:'different'}}));assert.equal(captures(f).length,before);
});

test('load-more and menu pagination preserve the displayed image without recapturing or uploading',async()=>{
 const f=fixture({logs:Array.from({length:25},(_,i)=>logEntry(`l${i}`,'kazeros',100-i)),hasMore:true});await f.run();
 assert.ok(controls(f)[2].options.length<=25);
 assert.equal(controls(f)[2].options.at(-1).value,'__next');
 await f.click(f.component('log','__next'));
 assert.deepEqual(controls(f)[2].options.map(x=>x.value),['l22','l23','l24','__prev']);
 await f.click(f.component('log','l23'));assert.equal(captures(f).at(-1)[1],'https://lostark.bible/logs/l23');
 const before=captures(f).length;
 await f.click(f.component('raid','__more'));
 assert.equal(captures(f).length,before);
 assert.ok(controls(f)[1].options.some(x=>x.value==='horizon'));
 assert.ok(!controls(f)[1].options.some(x=>x.value==='__more'));
});

test('private characters are blocked initially and changing to private revokes the existing panel before capture',async()=>{
 const initial=fixture();initial.verifyFailure=new RaidLogError('logs_private');await initial.run();
 assert.equal(captures(initial).length,0);assert.equal(initial.payload.components.length,1);assert.match(initial.events.at(-1)[1].content,/Public Log/);
 const f=fixture();await f.run();f.verifyFailure=new RaidLogError('logs_private');
 const action=f.component('tab','tanked');await f.click(action);
 assert.equal(captures(f).length,1);assert.deepEqual(f.payload.attachments,[]);assert.deepEqual(f.payload.embeds,[]);
 assert.ok(f.payload.components.every(row=>row.toJSON().components.every(c=>c.disabled)));
 await f.click(action);assert.match(f.events.at(-1)[1].content,/hết hạn/);
});

test('more than 25 raid choices paginate without losing raid selection or exposing unavailable logs',async()=>{
 const f=fixture({logs:Array.from({length:30},(_,i)=>logEntry(`l${i}`,`raid${i}`,100-i))});await f.run();
 assert.equal(controls(f)[1].options.length,23);
 await f.click(f.component('raid','__next'));
 assert.equal(captures(f).length,1);
 assert.equal(controls(f)[1].options.length,9);
 await f.click(f.component('raid','raid29'));
 assert.deepEqual(controls(f)[2].options.map(x=>x.value),['l29']);
 assert.equal(captures(f).at(-1)[1],'https://lostark.bible/logs/l29');
});

test('simultaneous clicks do not overlap; capture and Discord failures leave committed controls unchanged',async()=>{
 const f=fixture();await f.run();
 let release;f.beforeVerify=()=>new Promise(resolve=>{release=resolve;});
 const action=f.component('tab','self_buffs');const pending=f.click(action);
 await f.click(f.component('bracketed'));assert.match(f.events.find(event=>event[0]==='reply')[1].content,/đang xử lý/);
 await new Promise(resolve=>setImmediate(resolve));release();await pending;f.beforeVerify=null;
 const retry=f.component('bracketed');const current=controls(f)[3].label;
 f.failure=new RaidLogError('browser_crashed');await f.click(retry);assert.equal(controls(f)[3].label,current);
 f.failure=null;f.failEdit=true;await f.click(retry);assert.equal(controls(f)[3].label,current);
 f.failEdit=false;await f.click(retry);assert.notEqual(controls(f)[3].label,current);
});

test('expired and evicted panels retain their explicit limits',async()=>{
 let now=0;const f=fixture({sessionMs:100,now:()=>now,maxSessions:1});await f.run();const first=f.component('tab','tanked');
 await f.run();await f.click(first);assert.match(f.events.at(-1)[1].content,/hết hạn/);
 const second=f.component('tab','tanked');now=101;await f.click(second);assert.match(f.events.at(-1)[1].content,/hết hạn/);
});

test('every selection captures a full tab; Bracketed persists within a panel and starts ON for each new panel',async()=>{
 const f=fixture();await f.run();
 assert.equal(captures(f).at(-1)[2].bracketed,true);
 await f.click(f.component('bracketed'));
 for(const [action,value] of [['tab','party_buffs'],['log','old'],['raid','serca']]) {
  await f.click(f.component(action,value));
  assert.equal(captures(f).at(-1)[2].bracketed,false);
 }
 await f.run();
 assert.equal(captures(f).at(-1)[2].bracketed,true);
 assert.equal(captures(f).at(-1)[2].tab,'damage');
 assert.equal(captures(f).length,6);
 assert.ok(captures(f).every(([, , options])=>options.view==='full'));
});

test('global router dispatches both raid-log dropdowns and buttons to the panel handler',async()=>{
 let calls=0;const router=createRaidInteractionRouter({MessageFlags,handlers:{handleRaidLogComponent:async()=>{calls++;}}});
 for(const select of [true,false]) await router.handle({customId:'raid-log:id:0:tab',isChatInputCommand:()=>false,isAutocomplete:()=>false,isStringSelectMenu:()=>select,isButton:()=>!select});
 assert.equal(calls,2);
});
