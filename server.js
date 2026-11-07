'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'NIGHT RUN MOBILE' }));
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, cors: { origin: false }, maxHttpBufferSize: 12000 });

const WIDTH = 1440, HEIGHT = 960;
const GAME_SECONDS = 150, TICK_MS = 50, MAX_PLAYERS = 12;
const RECONNECT_MS = 60000;
const RADIUS = 20, HIDE_DURATION = 8000, HIDE_COOLDOWN = 16000;
const SCAN_COOLDOWN = 22000, SCAN_DURATION = 3300;
const rooms = new Map();

// Game map geometry is authoritative on the server. Green hiding zones are traversable.
const MAPS = [
  { id: 'forest', name: '안개숲', icon: '🌲', color: '#142a2b',
    obstacles: [
      [245,165,125,115],[490,100,95,190],[755,165,175,100],[1110,120,108,170],
      [170,405,210,90],[510,380,130,170],[800,385,135,140],[1075,440,180,105],
      [280,705,145,115],[585,725,180,92],[915,670,115,160],[1190,700,110,130]
    ],
    hides: [[150,220,70],[690,285,64],[1030,310,68],[360,610,66],[740,610,70],[1245,600,68],[155,780,62],[1110,800,66]]
  },
  { id: 'school', name: '폐교', icon: '🏫', color: '#252639',
    obstacles: [
      [230,135,135,220],[485,145,240,90],[900,110,95,250],[1140,170,140,150],
      [200,480,205,90],[520,385,130,225],[760,460,185,80],[1090,440,125,200],
      [260,725,205,90],[610,735,100,135],[850,715,175,85],[1170,765,120,95]
    ],
    hides: [[140,330,62],[430,335,67],[790,250,67],[1070,335,66],[460,635,68],[995,620,70],[180,800,65],[800,865,65]]
  },
  { id: 'lab', name: '비밀 연구소', icon: '🧪', color: '#192439',
    obstacles: [
      [210,140,145,185],[485,135,125,130],[750,115,195,115],[1090,140,155,150],
      [190,425,185,135],[505,425,110,190],[760,375,145,185],[1110,455,160,100],
      [245,725,175,115],[560,745,155,95],[875,700,120,150],[1170,700,105,140]
    ],
    hides: [[155,350,63],[435,330,62],[680,280,65],[1005,360,61],[410,630,67],[730,625,63],[1070,620,68],[790,840,63]]
  }
].map(m => ({ ...m,
  w: WIDTH, h: HEIGHT,
  obstacles: m.obstacles.map(([x,y,w,h]) => ({ x,y,w,h })),
  hides: m.hides.map(([x,y,r]) => ({ x,y,r }))
}));

const rand = (a, b) => a + Math.random() * (b - a);
const distance = (a,b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (n,low,high) => Math.min(high, Math.max(low,n));
const active = room => [...room.players.values()].filter(p => !p.spectator);
const findRoom = socket => {
  const room = rooms.get(socket.data.room);
  return room && room.players.has(socket.id) ? [room, room.players.get(socket.id)] : null;
};
const cleanName = value => String(value ?? '').trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,12) || '익명';
const reply = (ack, ok, error = '', extra = {}) => { if (typeof ack === 'function') ack({ ok, ...(error ? { error } : {}), ...extra }); };
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length:6 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function playerFor(socket,name,spectator=false) {
  return { id:socket.id, token:crypto.randomBytes(24).toString('hex'), disconnectedAt:0, name:cleanName(name), spectator, ready:false,
    role:null, alive:true, x:WIDTH/2, y:HEIGHT/2, dx:0, dy:0, boost:false,
    stamina:100, hidden:false, hideUntil:0, hideReadyAt:0, scanUntil:0, scanReadyAt:0,
    smoke:1, catches:0, caughtAt:0, movingTime:0, survived:0, trackAt:0 };
}
function collide(map,x,y,r=RADIUS) {
  if (x - r < 22 || x + r > map.w - 22 || y - r < 22 || y + r > map.h - 22) return true;
  return map.obstacles.some(o => {
    const px=clamp(x,o.x,o.x+o.w), py=clamp(y,o.y,o.y+o.h);
    return (px-x)**2+(py-y)**2 < r*r;
  });
}
function insideHide(map,p) { return map.hides.some(h=>Math.hypot(p.x-h.x,p.y-h.y)<h.r-10); }
function spawn(map,positioned,role) {
  const corners = [[90,90],[1350,870],[1350,90],[90,870]];
  if (role === 'monster') {
    for (const [x,y] of corners) {
      if (!collide(map,x,y,28) && positioned.every(p=>Math.hypot(p.x-x,p.y-y)>450)) return {x,y};
    }
  }
  for(let i=0;i<280;i++) {
    const point={x:rand(100,1340),y:rand(100,860)};
    if (collide(map,point.x,point.y,30)) continue;
    if (positioned.some(p=>distance(p,point)<125)) continue;
    if (positioned.some(p=>p.role==='monster' && distance(p,point)<370)) continue;
    return point;
  }
  for(let i=0;i<400;i++) {
    const point={x:rand(80,1360),y:rand(80,880)};
    if (!collide(map,point.x,point.y,30) && positioned.every(p=>distance(p,point)>65)) return point;
  }
  return {x:WIDTH/2,y:HEIGHT/2};
}
function newPickups(room) {
  room.pickups=[];
  for (let i=0;i<5;i++) addPickup(room);
}
function addPickup(room) {
  for(let i=0;i<50;i++) {
    const p={id:crypto.randomUUID(), x:rand(85,1355), y:rand(85,875), type:Math.random()<.46?'smoke':'energy'};
    if (collide(room.map,p.x,p.y,32) || room.pickups.some(item=>distance(item,p)<130)) continue;
    room.pickups.push(p); return;
  }
}
function intersectsRectangle(x1,y1,x2,y2,r) {
  // Liang–Barsky clipping: true if the sight segment crosses the box.
  let t0=0,t1=1;
  const dx=x2-x1, dy=y2-y1;
  const v=[[-dx,x1-r.x],[dx,r.x+r.w-x1],[-dy,y1-r.y],[dy,r.y+r.h-y1]];
  for(const [p,q] of v) {
    if (p===0) { if (q<0) return false; }
    else { const z=q/p; if(p<0) t0=Math.max(t0,z); else t1=Math.min(t1,z); if(t0>t1) return false; }
  }
  return true;
}
function clearSight(map,a,b) {
  return !map.obstacles.some(o=>intersectsRectangle(a.x,a.y,b.x,b.y,{x:o.x-4,y:o.y-4,w:o.w+8,h:o.h+8}));
}
function visible(room,viewer,target,now) {
  if (viewer.id===target.id) return true;
  if (viewer.spectator || !viewer.alive || room.status!=='playing') return true;
  if (!target.alive || target.spectator) return false;
  const d=distance(viewer,target);
  if (viewer.role===target.role) return d<630;
  if (viewer.role==='monster') {
    if (d<42) return true;
    if (viewer.scanUntil>now && d<560) return true;
    if (target.hidden) return false;
    if (room.smokes.some(s=>distance(s,target)<s.r) && d>66) return false;
    return d<350 && clearSight(room.map,viewer,target);
  }
  return d<390 && clearSight(room.map,viewer,target);
}
function snap(room,viewer) {
  const now=Date.now();
  const viewerPlayer=room.players.get(viewer);
  const reveal = room.status==='finished' || room.status==='lobby';
  const roundPlayers=[...room.players.values()];
  const payload={
    code:room.code, host:room.host, status:room.status,
    timeLeft:room.status==='playing' ? Math.max(0,Math.ceil((room.roundEndsAt-now)/1000)) : GAME_SECONDS,
    countdown:room.status==='countdown' ? Math.max(0,Math.ceil((room.startAt-now)/1000)) : 0,
    winner:room.winner, endReason:room.endReason, map:room.map,
    stats: { survivors:roundPlayers.filter(p=>!p.spectator&&p.role==='civilian'&&p.alive).length,
      hunters:roundPlayers.filter(p=>!p.spectator&&p.role==='monster'&&p.alive).length },
    players: roundPlayers.map(p=>{
      const canSee = reveal || (room.status==='countdown' ? p.id===viewer : visible(room,viewerPlayer,p,now));
      return {
        id:p.id,name:p.name,ready:p.ready,bot:!!p.bot,connected:!p.disconnectedAt,spectator:p.spectator,alive:p.alive,
        // Never leak a hidden player position to the opposing team.
        role:room.status==='countdown'&&p.id!==viewer ? null : p.role,
        x:canSee?Math.round(p.x):null, y:canSee?Math.round(p.y):null,
        hidden:canSee&&p.hidden, stamina:p.id===viewer?Math.round(p.stamina):undefined,
        catches:p.catches, survived:Math.floor(p.survived),
        smoke:p.id===viewer?p.smoke:undefined,
        inHide:p.id===viewer?insideHide(room.map,p):undefined,
        hideMs:p.id===viewer?Math.max(0,p.hideReadyAt-now):undefined,
        hiddenMs:p.id===viewer&&p.hidden?Math.max(0,p.hideUntil-now):undefined,
        scanMs:p.id===viewer?Math.max(0,p.scanReadyAt-now):undefined,
        scanning:p.id===viewer&&p.scanUntil>now
      };
    }),
    pickups:room.status==='playing' ? room.pickups : [],
    smokes:room.smokes.filter(s=>s.until>now).map(s=>({x:s.x,y:s.y,r:s.r,until:s.until-now})),
    tracks:viewerPlayer?.role==='monster'||viewerPlayer?.spectator||!viewerPlayer?.alive ?
      room.tracks.filter(t=>t.until>now && (!viewerPlayer?.alive || viewerPlayer.spectator || distance(t,viewerPlayer)<570))
        .map(t=>({x:t.x,y:t.y,ttl:t.until-now})) : []
  };
  return payload;
}
function broadcast(room) {
  for (const p of room.players.values()) io.to(p.id).emit('state',snap(room,p.id));
}
function finish(room,winner,reason) {
  if(room.status==='finished') return;
  room.status='finished'; room.winner=winner; room.endReason=reason;
  for(const p of room.players.values()) { p.dx=0; p.dy=0; p.boost=false; p.hidden=false; }
  broadcast(room);
}
function checkWinner(room,now=Date.now()) {
  if(room.status!=='playing') return;
  const players=active(room);
  if(!players.some(p=>p.role==='monster'&&p.alive)) return finish(room,'civilian','괴물이 모두 퇴장했습니다.');
  if(!players.some(p=>p.role==='civilian'&&p.alive)) return finish(room,'monster','모든 일반인이 잡혔습니다!');
  if(now>=room.roundEndsAt) return finish(room,'civilian','제한시간 동안 생존자가 남았습니다!');
}
function startRound(room) {
  const list=active(room), monsters=list.length>=7?2:1;
  room.map=MAPS[crypto.randomInt(MAPS.length)];
  const selected=new Set();
  while(selected.size<monsters) selected.add(crypto.randomInt(list.length));
  list.forEach((p,i)=> {
    p.role=room.practice ? (p.id===room.host ? room.practiceRole : (i===1 && room.practiceRole==='civilian' ? 'monster' : 'civilian')) : (selected.has(i)?'monster':'civilian');p.alive=true;p.hidden=false;
    p.dx=0;p.dy=0;p.boost=false;p.stamina=100;p.catches=0;p.caughtAt=0;
    p.hideUntil=0;p.hideReadyAt=0;p.scanUntil=0;p.scanReadyAt=0;
    p.smoke=1;p.survived=0;p.trackAt=0;
  });
  const placed=[];
  for(const p of [...list].sort((a,b)=>Number(b.role==='monster')-Number(a.role==='monster'))) {
    Object.assign(p,spawn(room.map,placed,p.role));placed.push(p);
  }
  room.status='countdown';room.startAt=Date.now()+4200;room.roundEndsAt=0;
  room.winner=null;room.endReason='';room.smokes=[];room.tracks=[];
  newPickups(room); broadcast(room);
}
function resetRoom(room) {
  room.status='lobby';room.winner=null;room.endReason='';room.pickups=[];room.smokes=[];room.tracks=[];
  [...room.players.values()].forEach((p,i)=>{
    p.ready=!!p.bot;p.spectator=i>=MAX_PLAYERS;p.role=null;p.alive=true;p.hidden=false;
    p.dx=p.dy=0;p.stamina=100;p.catches=0;p.smoke=1;
    p.x=WIDTH/2;p.y=HEIGHT/2;
  });
  broadcast(room);
}
function useAbility(room,p,action,now) {
  if(room.status!=='playing'||p.spectator||!p.alive) return '현재 사용할 수 없습니다.';
  if(action==='hide') {
    if(p.role!=='civilian') return '일반인만 숨을 수 있습니다.';
    if(p.hidden) { p.hidden=false;p.hideUntil=0;return ''; }
    if(!insideHide(room.map,p)) return '초록색 은신 구역 안에서만 숨을 수 있습니다.';
    if(now<p.hideReadyAt) return '은신 재사용 시간이 남았습니다.';
    p.hidden=true;p.hideUntil=now+HIDE_DURATION;p.hideReadyAt=now+HIDE_COOLDOWN;
    p.dx=0;p.dy=0;p.boost=false;return '';
  }
  if(action==='smoke') {
    if(p.role!=='civilian') return '일반인만 연막탄을 사용할 수 있습니다.';
    if(p.smoke<1) return '연막탄이 없습니다. 맵에서 연막 아이템을 획득하세요.';
    p.smoke--;p.hidden=false;
    room.smokes.push({x:p.x,y:p.y,r:113,until:now+5500});return '';
  }
  if(action==='scan') {
    if(p.role!=='monster') return '괴물만 탐지할 수 있습니다.';
    if(now<p.scanReadyAt) return '탐지 재사용 시간이 남았습니다.';
    p.scanUntil=now+SCAN_DURATION;p.scanReadyAt=now+SCAN_COOLDOWN;
    io.to(room.code).emit('gameEvent',{type:'scan',message:'괴물이 탐지 능력을 사용했습니다!'});return '';
  }
  return '알 수 없는 능력입니다.';
}

io.on('connection',socket=>{
  socket.on('create',(payload={},ack)=>{
    const {name} = payload && typeof payload==='object' ? payload : {};
    if(socket.data.room) return reply(ack,false,'이미 방에 참가했습니다.');
    const code=roomCode(),p=playerFor(socket,name);
    const room={code,host:socket.id,map:MAPS[0],players:new Map([[socket.id,p]]),
      status:'lobby',startAt:0,roundEndsAt:0,winner:null,endReason:'',pickups:[],tracks:[],smokes:[]};
    rooms.set(code,room);socket.data.room=code;socket.join(code);
    reply(ack,true,'',{code,id:socket.id,token:p.token});broadcast(room);
  });
  socket.on('practice',(payload={},ack)=>{
    if(socket.data.room) return reply(ack,false,'이미 방에 참가했습니다.');
    const role=payload?.role==='monster'?'monster':'civilian';
    const code=roomCode(),p=playerFor(socket,payload?.name);
    const room={code,host:socket.id,map:MAPS[0],players:new Map([[socket.id,p]]),
      practice:true,practiceRole:role,status:'lobby',startAt:0,roundEndsAt:0,winner:null,endReason:'',pickups:[],tracks:[],smokes:[]};
    for(let i=0;i<3;i++) {const id='bot-'+crypto.randomUUID();const bot=playerFor({id},`연습봇 ${i+1}`);bot.bot=true;bot.ready=true;room.players.set(id,bot);}
    rooms.set(code,room);socket.data.room=code;socket.join(code);
    reply(ack,true,'',{code,id:socket.id,token:p.token});startRound(room);
  });
  socket.on('join',(payload={},ack)=>{
    const {name,code} = payload && typeof payload==='object' ? payload : {};
    if(socket.data.room) return reply(ack,false,'이미 방에 참가했습니다.');
    const room=rooms.get(String(code||'').trim().toUpperCase());
    if(!room) return reply(ack,false,'방이 없거나 종료되었습니다.');
    if(room.practice) return reply(ack,false,'혼자 연습하는 방입니다.');
    if(room.players.size>=20) return reply(ack,false,'관전자 포함 최대 20명까지 입장할 수 있습니다.');
    const spectator=room.status!=='lobby'||active(room).length>=MAX_PLAYERS;
    const p=playerFor(socket,name,spectator);
    room.players.set(socket.id,p);socket.data.room=room.code;socket.join(room.code);
    reply(ack,true,'',{code:room.code,id:socket.id,spectator,token:p.token});broadcast(room);
  });
  socket.on('resume',(payload={},ack)=>{
    if(socket.data.room) return reply(ack,false,'이미 방에 참가했습니다.');
    const room=rooms.get(String(payload?.code||'').toUpperCase());
    const token=String(payload?.token||'');
    const p=room && [...room.players.values()].find(p=>p.token===token && token.length===48);
    if(!p || !p.disconnectedAt || Date.now()-p.disconnectedAt>RECONNECT_MS) return reply(ack,false,'재접속 시간이 지났거나 방이 종료되었습니다.');
    const oldId=p.id;room.players.delete(oldId);p.id=socket.id;p.disconnectedAt=0;
    room.players.set(p.id,p);if(room.host===oldId)room.host=p.id;
    socket.data.room=room.code;socket.join(room.code);
    reply(ack,true,'',{code:room.code,id:p.id,token:p.token});broadcast(room);
  });
  socket.on('ready',(value,ack)=>{
    const pair=findRoom(socket);if(!pair) return reply(ack,false,'방에 입장하지 않았습니다.');
    const [room,p]=pair;
    if(room.status!=='lobby'||p.spectator) return reply(ack,false,'대기실에서만 준비할 수 있습니다.');
    p.ready=!!value;reply(ack,true);broadcast(room);
  });
  socket.on('start',(_value,ack)=>{
    const pair=findRoom(socket);if(!pair) return reply(ack,false,'방에 입장하지 않았습니다.');
    const [room]=pair;
    if(room.host!==socket.id||room.status!=='lobby') return reply(ack,false,'방장만 대기실에서 시작할 수 있습니다.');
    const players=active(room);
    if(players.length<2) return reply(ack,false,'최소 2명이 필요합니다.');
    if(players.some(p=>p.disconnectedAt || (p.id!==room.host&&!p.ready))) return reply(ack,false,'모든 참가자가 준비해야 합니다.');
    startRound(room);reply(ack,true);
  });
  socket.on('restart',(_value,ack)=>{
    const pair=findRoom(socket);if(!pair) return reply(ack,false,'방에 입장하지 않았습니다.');
    const [room]=pair;
    if(room.host!==socket.id||room.status!=='finished') return reply(ack,false,'방장만 다음 판을 열 수 있습니다.');
    resetRoom(room);reply(ack,true);
  });
  socket.on('input',(msg={})=>{
    msg = msg && typeof msg==='object' ? msg : {};
    const pair=findRoom(socket);if(!pair) return;
    const [room,p]=pair;
    if(room.status!=='playing'||p.spectator||!p.alive) return;
    const x=Number(msg.x),y=Number(msg.y);
    p.dx=Number.isFinite(x)?clamp(x,-1,1):0;
    p.dy=Number.isFinite(y)?clamp(y,-1,1):0;
    p.boost=msg.boost===true;p.lastInputAt=Date.now();
  });
  socket.on('ability',(action,ack)=>{
    const pair=findRoom(socket);if(!pair) return reply(ack,false,'방에 입장하지 않았습니다.');
    const [room,p]=pair;
    const now=Date.now();
    if(p.lastAbilityAt&&now-p.lastAbilityAt<180) return reply(ack,false,'잠시 후 다시 시도하세요.');
    p.lastAbilityAt=now;
    const error=useAbility(room,p,String(action),now);
    reply(ack,!error,error);if(!error) broadcast(room);
  });
  socket.on('leave',()=>{socket.data.voluntary=true;socket.disconnect(true);});
  socket.on('disconnect',()=>{
    const room=rooms.get(socket.data.room);
    if(!room) return;
    const p=room.players.get(socket.id);if(!p)return;
    p.dx=p.dy=0;p.boost=false;
    if(socket.data.voluntary) removePlayer(room,p);
    else {p.disconnectedAt=Date.now();broadcast(room);}
  });
});

function removePlayer(room,p) {
  room.players.delete(p.id);
  if(!room.players.size || (room.practice && ![...room.players.values()].some(x=>!x.bot))){rooms.delete(room.code);return;}
  if(room.host===p.id) room.host=room.players.keys().next().value;
  if(room.status==='countdown'&&active(room).length<2) resetRoom(room);
  if(room.status==='playing') checkWinner(room);
  broadcast(room);
}
// Grid-based route planning lets practice opponents navigate around the same solid obstacles.
function botDirection(room,bot,target) {
  const cell=48,cols=Math.floor(WIDTH/cell),rows=Math.floor(HEIGHT/cell);
  const key=(x,y)=>y*cols+x, valid=(x,y)=>x>=0&&x<cols&&y>=0&&y<rows&&!collide(room.map,(x+.5)*cell,(y+.5)*cell,22);
  const sx=clamp(Math.floor(bot.x/cell),0,cols-1),sy=clamp(Math.floor(bot.y/cell),0,rows-1);
  const tx=clamp(Math.floor(target.x/cell),0,cols-1),ty=clamp(Math.floor(target.y/cell),0,rows-1);
  const queue=[[sx,sy]],prev=new Map([[key(sx,sy),null]]);let best=key(sx,sy),bestDist=Infinity;
  for(let n=0;n<queue.length;n++){const [x,y]=queue[n],k=key(x,y),d=(x-tx)**2+(y-ty)**2;
    if(d<bestDist){bestDist=d;best=k;} if(d===0)break;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy,nk=key(nx,ny);if(valid(nx,ny)&&!prev.has(nk)){prev.set(nk,k);queue.push([nx,ny]);}}
  }
  let k=best,first=k;while(prev.get(k)!=null){first=k;k=prev.get(k);}
  const point=best===key(sx,sy)?target:{x:(first%cols+.5)*cell,y:(Math.floor(first/cols)+.5)*cell};
  const dx=point.x-bot.x,dy=point.y-bot.y,len=Math.hypot(dx,dy);return len>5?{x:dx/len,y:dy/len}:{x:0,y:0};
}
function updateBot(room,bot,players,now){
  if(!bot.alive)return;
  const enemies=players.filter(p=>p.alive && p.role!==bot.role);
  enemies.sort((a,b)=>distance(bot,a)-distance(bot,b));
  const enemy=enemies[0];if(!enemy)return;
  if(now<(bot.nextThinkAt||0))return;
  bot.nextThinkAt=now+450;
  let target;
  if(bot.role==='monster') target=enemy;
  else if(distance(bot,enemy)<360){
    const dx=bot.x-enemy.x,dy=bot.y-enemy.y,len=Math.hypot(dx,dy)||1;
    target={x:clamp(bot.x+dx/len*350,45,WIDTH-45),y:clamp(bot.y+dy/len*350,45,HEIGHT-45)};
  } else {
    if(!bot.wander || distance(bot,bot.wander)<50 || now>(bot.wanderUntil||0)){bot.wander=spawn(room.map,[], 'civilian');bot.wanderUntil=now+5000;}
    target=bot.wander;
  }
  const dir=botDirection(room,bot,target);bot.dx=dir.x;bot.dy=dir.y;
  bot.boost=distance(bot,enemy)<240 && bot.stamina>25;bot.lastInputAt=now;
}
let ticks=0;
setInterval(()=>{
  const now=Date.now();ticks++;
  for(const room of rooms.values()) {
    for(const p of [...room.players.values()]) if(p.disconnectedAt && now-p.disconnectedAt>=RECONNECT_MS) removePlayer(room,p);
    if(!rooms.has(room.code)) continue;
    if(room.status==='countdown') {
      if(now>=room.startAt) { room.status='playing';room.roundEndsAt=now+GAME_SECONDS*1000; }
      if(ticks%2===0) broadcast(room);
      continue;
    }
    if(room.status!=='playing') continue;
    const players=active(room);
    const dt=TICK_MS/1000;
    for(const p of players)if(p.bot)updateBot(room,p,players,now);
    for(const p of players) {
      if(!p.alive) continue;
      if(p.lastInputAt && now-p.lastInputAt>600){p.dx=p.dy=0;p.boost=false;}
      if(p.role==='civilian') p.survived+=dt;
      if(p.hidden && (now>=p.hideUntil||!insideHide(room.map,p))) p.hidden=false;
      const mag=Math.hypot(p.dx,p.dy);
      if(p.hidden && mag>0.18) p.hidden=false;
      const boost=!p.hidden&&p.boost&&p.stamina>.5&&mag>.05;
      p.stamina=clamp(p.stamina+(boost?-33:19)*dt,0,100);
      const speed=p.role==='monster'?(boost?274:196):(boost?282:180);
      if(!p.hidden && mag>.04) {
        const vx=p.dx/mag*speed*dt,vy=p.dy/mag*speed*dt;
        if(!collide(room.map,p.x+vx,p.y))p.x+=vx;
        if(!collide(room.map,p.x,p.y+vy))p.y+=vy;
      }
      if(boost && p.role==='civilian' && now-p.trackAt>540) {
        p.trackAt=now;room.tracks.push({x:Math.round(p.x),y:Math.round(p.y),until:now+4700});
      }
      if(p.role==='civilian') for(let i=room.pickups.length-1;i>=0;i--) {
        const item=room.pickups[i];
        if(distance(p,item)<33) {
          if(item.type==='smoke') p.smoke=Math.min(2,p.smoke+1);
          else p.stamina=Math.min(100,p.stamina+48);
          room.pickups.splice(i,1);
          setTimeout(()=>{
            if(rooms.get(room.code)===room && room.status==='playing'&&room.pickups.length<5) addPickup(room);
          },11000);
        }
      }
    }
    room.tracks=room.tracks.filter(t=>t.until>now).slice(-140);
    room.smokes=room.smokes.filter(s=>s.until>now);
    if(now>=room.roundEndsAt-GAME_SECONDS*1000+3800) {
      for(const monster of players.filter(p=>p.role==='monster'&&p.alive)) {
        for(const civilian of players.filter(p=>p.role==='civilian'&&p.alive)) {
          if(distance(monster,civilian)<(civilian.hidden?33:40) && clearSight(room.map,monster,civilian)) {
            civilian.alive=false;civilian.hidden=false;civilian.dx=0;civilian.dy=0;
            civilian.caughtAt=now;monster.catches++;
            io.to(room.code).emit('gameEvent',{type:'caught',message:`${civilian.name}님이 잡혔습니다!`});
          }
        }
      }
    }
    checkWinner(room,now);
    if(room.status==='playing'&&ticks%2===0) broadcast(room);
  }
},TICK_MS);

const PORT=Number(process.env.PORT)||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`NIGHT RUN MOBILE listening on ${PORT}`));
