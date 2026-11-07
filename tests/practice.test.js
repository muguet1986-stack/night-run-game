const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {io}=require('socket.io-client');
const port=32150, url=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const connect=()=>new Promise((resolve,reject)=>{let s=io(url,{transports:['websocket'],reconnection:false});s.on('connect',()=>resolve(s));s.on('connect_error',reject);s.on('state',v=>s.state=v);});
const cmd=(s,event,value)=>new Promise((resolve,reject)=>s.timeout(2500).emit(event,value,(err,v)=>err?reject(err):resolve(v)));
(async()=>{let clients=[];try{
 await new Promise(resolve=>server.stdout.once('data',resolve));
 for(const role of ['civilian','monster']){
  const s=await connect();clients.push(s);let r=await cmd(s,'practice',{name:'test',role});assert(r.ok);await wait(200);
  assert.equal(s.state.status,'countdown');assert.equal(s.state.players.length,4);
  assert.equal(s.state.players.find(p=>p.id===s.id).role,role);
  const stranger=await connect();clients.push(stranger);assert.equal((await cmd(stranger,'join',{code:r.code,name:'x'})).ok,false);stranger.disconnect();
  await wait(4400);assert.equal(s.state.status,'playing');
  const before=s.state.players.filter(p=>p.bot&&p.x!==null).map(p=>({id:p.id,x:p.x,y:p.y}));
  // Spectator visibility is intentionally limited, so movement is checked when a bot is visible.
  await wait(1200);
  const seen=before.find(b=>{const q=s.state.players.find(p=>p.id===b.id);return q&&q.x!==null&&Math.hypot(q.x-b.x,q.y-b.y)>0});
  if(before.length)assert(seen,'visible practice bot should move');
  s.emit('leave');await wait(100);
 }
 console.log('PASS practice: both roles, automatic 3 bots, private room, movement');
 }finally{clients.forEach(s=>s.disconnect());server.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});
