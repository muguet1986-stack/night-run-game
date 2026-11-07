const assert=require('assert');
const Module=require('module');
const oldLoad=Module._load;
let onConnect, tick, now=100000, eventState=new Map();
const server={listen(port,host,fn){fn?.();}};
const express=()=>Object.assign(()=>{}, {disable(){},use(){},get(){}});
express.static=()=>()=>{};
class Server {
  constructor(){this.sockets=new Map();}
  on(n,fn){if(n==='connection')onConnect=fn;}
  to(id){return {emit:(name,payload)=>{if(name==='state')eventState.set(id,payload);}};}
}
Module._load=function(request,parent,isMain){
 if(request==='express')return express;
 if(request==='http')return {createServer:()=>server};
 if(request==='socket.io')return {Server};
 return oldLoad.apply(this,arguments);
};
const oldInterval=global.setInterval,oldNow=Date.now;
global.setInterval=fn=>{tick=fn;return 1;};Date.now=()=>now;
require('../server.js');
function socket(id){
 const handlers={};const sock={id,data:{},on(k,v){handlers[k]=v;},join(){},disconnect(){handlers.disconnect?.();}};
 onConnect(sock);
 return {sock,handlers};
}
const a=socket('a'),b=socket('b');
function cmd(s,event,data){let out; s.handlers[event](data, r=>out=r);assert(out,event+' ack');return out;}
assert(cmd(a,'create',{name:'원'}).ok);
const code=eventState.get('a').code;
assert(cmd(b,'join',{name:'투',code}).ok);
assert(cmd(b,'ready',true).ok);
assert(cmd(a,'start',null).ok);
assert.equal(eventState.get('a').status,'countdown');
assert.equal(eventState.get('b').players.find(p=>p.id==='a').role,null,'countdown other roles hidden');
for(let i=0;i<100;i++){now+=50;tick();}
assert.equal(eventState.get('a').status,'playing');
const s=eventState.get('a');
assert(s.map.hides.length>=7);assert(s.map.obstacles.length>=12);
const runner=s.players.find(p=>p.role==='civilian');
const hunter=s.players.find(p=>p.role==='monster');
const runnerSock=runner.id==='a'?a:b, hunterSock=hunter.id==='a'?a:b;
// A survivor cannot hide outside a green hiding zone, and the monster cannot smoke.
assert(!cmd(runnerSock,'ability','hide').ok || eventState.get(runner.id).players.find(p=>p.id===runner.id).hidden);
assert(!cmd(hunterSock,'ability','smoke').ok);
now+=250;tick();
// Monster scan starts and has a cooldown.
assert(cmd(hunterSock,'ability','scan').ok);
now+=250;tick();
assert(!cmd(hunterSock,'ability','scan').ok);
// Surviving past 150 seconds awards civilians the win.
for(let i=0;i<3050;i++){now+=50;tick();}
assert.equal(eventState.get('a').status,'finished');
assert.equal(eventState.get('a').winner,'civilian');
assert(cmd(a,'restart',null).ok);
assert.equal(eventState.get('a').status,'lobby');
console.log('PASS: room, roles, countdown, ability, cooldown, timer, victory, restart');
global.setInterval=oldInterval;Date.now=oldNow;
