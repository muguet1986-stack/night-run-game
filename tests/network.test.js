const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {io}=require('socket.io-client');
const port=32149, url=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function connect(){return new Promise((resolve,reject)=>{const s=io(url,{transports:['websocket'],reconnection:false});s.on('connect',()=>resolve(s));s.on('connect_error',reject);s.on('state',v=>s.state=v);});}
function cmd(s,event,value){return new Promise((resolve,reject)=>s.timeout(2500).emit(event,value,(err,v)=>err?reject(err):resolve(v)));}
(async()=>{let all=[];try {
 await new Promise(resolve=>server.stdout.once('data',resolve));
 const tokens=[];const host=await connect();all.push(host);
 const created=await cmd(host,'create',{name:'Host'});assert(created.ok);tokens.push(created.token);
 for(let i=0;i<6;i++){const s=await connect();all.push(s);const joined=await cmd(s,'join',{name:`P${i}`,code:created.code});assert(joined.ok);tokens.push(joined.token);assert((await cmd(s,'ready',true)).ok);}
 assert((await cmd(host,'start',null)).ok);await wait(300);
 assert.equal(host.state.status,'countdown');assert.equal(host.state.players.filter(p=>p.role==='monster').length <= 1,true);
 await wait(4300);assert.equal(host.state.status,'playing');
 // Every client receives its own role; across seven clients there must be exactly two monsters.
 assert.equal(all.filter(s=>s.state.players.find(p=>p.id===s.id)?.role==='monster').length,2);
 const original=all[1], before=original.state.players.find(p=>p.id===original.id), role=before.role;
 original.disconnect();await wait(200);
 const resumed=await connect();all.push(resumed);
 const result=await cmd(resumed,'resume',{code:created.code,token:original.joinToken||tokens[1]});
 assert(result.ok,JSON.stringify(result));await wait(200);
 const after=resumed.state.players.find(p=>p.id===resumed.id);assert.equal(after.role,role);assert.equal(after.alive,before.alive);
 const x=after.x,y=after.y;resumed.emit('input',{x:1,y:0,boost:false});await wait(300);
 const moved=resumed.state.players.find(p=>p.id===resumed.id);assert(Math.hypot(moved.x-x,moved.y-y)>0,'server movement');
 console.log('PASS real sockets: 7 players, ready, countdown, 2 monsters, reconnect, movement');
 }finally{for(const s of all)s.disconnect();server.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
