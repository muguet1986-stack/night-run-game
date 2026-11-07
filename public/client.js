(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const socket = io({ reconnection: true, reconnectionAttempts: 18, timeout: 12000 });
  const canvas = $('gameCanvas'), ctx = canvas.getContext('2d',{alpha:false});
  const screens = ['homeView','lobbyView','countdownView','resultView'];
  const world = { w:1440,h:960,obstacles:[],hides:[],id:'forest',name:'안개숲',color:'#142a2b' };
  const control = {x:0,y:0,boost:false}, pressedKeys = new Set();
  const rendered = new Map();
  let state=null,myId=null,joinedCode='',sessionToken='',nickname='',status='',lastLobby='',lastResults='';
  let viewWidth=1,viewHeight=1,scale=1,dpr=1,lastFrame=0,joyPointer=null;
  let camera={x:720,y:480},spectateIndex=0,toastTimeout=0,soundEnabled=false,audioContext=null;
  let dust=[],effects=[],lastTimeTick=0,previousAlive=true;

  const clamp=(x,min,max)=>Math.min(max,Math.max(min,x));
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const self=()=>state?.players?.find(p=>p.id===myId);
  const clock=seconds=>`${String(Math.floor(Math.max(0,seconds)/60)).padStart(2,'0')}:${String(Math.max(0,seconds)%60).padStart(2,'0')}`;
  const numberSeconds=ms=>`${Math.ceil(Math.max(0,ms)/1000)}초`;
  const safeText=text=>String(text||'').slice(0,60);
  const activePlayer=p=>!p.spectator&&p.alive;

  function showScreen(id) {
    for (const screen of screens) $(screen).hidden=screen!==id;
  }
  function toast(message) {
    if(!message)return;
    const target=$('toast');target.textContent=safeText(message);target.hidden=false;
    clearTimeout(toastTimeout);
    toastTimeout=setTimeout(()=>{target.hidden=true;},2700);
  }
  function buzz(duration=22) { if(navigator.vibrate) navigator.vibrate(duration); }
  function playNote(type='tap') {
    if(!soundEnabled)return;
    try {
      audioContext ||= new (window.AudioContext||window.webkitAudioContext)();
      if(audioContext.state==='suspended') audioContext.resume().catch(()=>{});
      const now=audioContext.currentTime,osc=audioContext.createOscillator(),gain=audioContext.createGain();
      osc.type=type==='alert'?'sawtooth':'sine';
      const notes={tap:[480,640,.1],ready:[360,680,.17],alert:[190,85,.3],win:[490,880,.3],scan:[210,440,.24]};
      const [from,to,len]=notes[type]||notes.tap;
      osc.frequency.setValueAtTime(from,now);osc.frequency.exponentialRampToValueAtTime(to,now+len);
      gain.gain.setValueAtTime(.065,now);gain.gain.exponentialRampToValueAtTime(.001,now+len);
      osc.connect(gain);gain.connect(audioContext.destination);osc.start(now);osc.stop(now+len+.02);
    }catch(_e){}
  }
  $('soundBtn').addEventListener('click',()=>{
    soundEnabled=!soundEnabled;
    $('soundBtn').textContent=soundEnabled?'♪':'♪̸';
    $('soundBtn').setAttribute('aria-label',soundEnabled?'사운드 끄기':'사운드 켜기');
    if(soundEnabled)playNote('ready');
  });

  function request(event,data,onSuccess,errorId='homeError') {
    if(!socket.connected) {toast('서버에 연결되지 않았습니다.');return;}
    socket.timeout(5500).emit(event,data,(err,response)=>{
      if(err||!response?.ok) {
        const msg=err?'서버 응답이 지연되고 있습니다.':response?.error||'요청을 처리하지 못했습니다.';
        if(errorId && $(errorId)) $(errorId).textContent=msg;
        toast(msg);
        return;
      }
      if(errorId&&$(errorId))$(errorId).textContent='';
      onSuccess?.(response);
    });
  }
  function saveName() {
    nickname=$('nickname').value.trim().slice(0,12)||'익명';
    try{sessionStorage.setItem('nightRunName',nickname);}catch(_e){}
    return nickname;
  }
  function entered(response) {
    joinedCode=response.code;
    myId=response.id;sessionToken=response.token||sessionToken;
    try{sessionStorage.setItem('nightRunSession',JSON.stringify({code:joinedCode,token:sessionToken}));}catch(_e){}
    try{
      const url=new URL(location.href);url.searchParams.set('room',joinedCode);
      history.replaceState({},'',url);
    }catch(_e){}
    playNote('ready');buzz();
  }
  $('createBtn').addEventListener('click',()=>request('create',{name:saveName()},entered));
  $('joinBtn').addEventListener('click',()=>{
    const code=$('joinCode').value.trim().toUpperCase();
    if(!/^[A-Z2-9]{6}$/.test(code))return toast('6자리 초대 코드를 입력하세요.');
    request('join',{name:saveName(),code},entered);
  });
  $('joinCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('joinBtn').click();});
  $('nickname').addEventListener('keydown',e=>{if(e.key==='Enter')e.target.blur();});
  $('readyBtn').addEventListener('click',()=>{
    const value=!self()?.ready;
    request('ready',value,()=>playNote('tap'),'lobbyError');
  });
  $('startBtn').addEventListener('click',()=>request('start',null,()=>playNote('ready'),'lobbyError'));
  $('restartBtn').addEventListener('click',()=>request('restart',null,()=>{},null));
  function leave() {
    if(socket.connected)socket.emit('leave');
    joinedCode='';sessionToken='';try{sessionStorage.removeItem('nightRunSession');}catch(_e){}
    state=null;rendered.clear();lastLobby='';lastResults='';status='';
    try{const url=new URL(location.href);url.searchParams.delete('room');history.replaceState({},'',url);}catch(_e){}
    socket.disconnect();socket.connect();showScreen('homeView');$('hud').hidden=true;
    $('controls').hidden=true;$('spectator').hidden=true;toast('방에서 나왔습니다.');
  }
  $('exitBtn').addEventListener('click',leave);
  $('resultExitBtn').addEventListener('click',leave);

  async function shareRoom() {
    const url=new URL(location.href);url.searchParams.set('room',joinedCode);
    const text=`NIGHT RUN 같이 하자! 방 코드: ${joinedCode}`;
    if(navigator.share) {
      try {await navigator.share({title:'NIGHT RUN 초대',text,url:url.toString()});return;}
      catch(e) {if(e.name==='AbortError')return;}
    }
    try {await navigator.clipboard.writeText(url.toString());toast('초대 링크를 복사했습니다!');}
    catch(_e) {toast(`초대 코드 ${joinedCode}를 친구에게 알려주세요.`);}
  }
  $('inviteBtn').addEventListener('click',shareRoom);

  socket.on('connect',()=>{
    myId=socket.id;
    $('connectionDot').classList.add('online');$('connectionText').textContent='LIVE';
    if(!joinedCode){try{const saved=JSON.parse(sessionStorage.getItem('nightRunSession'));if(saved?.code&&saved?.token){joinedCode=saved.code;sessionToken=saved.token;}}catch(_e){}}
    if(joinedCode && sessionToken) {
      socket.timeout(5500).emit('resume',{code:joinedCode,token:sessionToken},(err,response)=>{
        if(!err&&response?.ok){entered(response);return;}
        joinedCode='';sessionToken='';try{sessionStorage.removeItem('nightRunSession');}catch(_e){} state=null;rendered.clear();status='';
        showScreen('homeView');$('hud').hidden=true;$('controls').hidden=true;$('spectator').hidden=true;
        try{const url=new URL(location.href);url.searchParams.delete('room');history.replaceState({},'',url);}catch(_e){}
        toast('기존 방에 재접속하지 못했습니다. 새 방에 입장해 주세요.');
      });
    }
  });
  socket.on('disconnect',()=>{
    $('connectionDot').classList.remove('online');$('connectionText').textContent='재연결 중';
    control.x=control.y=0;control.boost=false;
  });
  socket.on('connect_error',()=>{$('connectionText').textContent='연결 실패';});
  socket.on('gameEvent',data=>{
    if(data?.message)toast(data.message);
    if(data?.type==='caught'){playNote('alert');buzz([30,40,40]);}
    if(data?.type==='scan'){playNote('scan');buzz(18);}
  });

  // World data changes only at the beginning of each round.
  function setWorld(map) {
    if(!map||!Array.isArray(map.obstacles))return;
    if(world.id!==map.id||world.obstacles.length!==map.obstacles.length){
      dust=Array.from({length:180},(_,i)=>{
        const seed=i*37+map.id.length*103;
        return {x:(seed*71)%map.w,y:(seed*173)%map.h,r:1+(seed%5)*.36,twinkle:(seed%9)*.45};
      });
    }
    Object.assign(world,map);
  }
  function playerRow(p,host) {
    const row=document.createElement('div');row.className='lobby-person';
    const avatar=document.createElement('div');avatar.className='lobby-avatar';avatar.textContent=p.spectator?'👁':p.ready?'😎':'🙂';
    const name=document.createElement('div');name.className='lobby-person-name';
    name.textContent=`${host===p.id?'👑 ':''}${p.name}${p.id===myId?' (나)':''}`;
    const info=document.createElement('span');info.className=`lobby-person-status ${p.ready?'ready':''}`;
    info.textContent=p.connected===false?'재연결 대기':p.spectator?'관전자':host===p.id?'방장':p.ready?'✓ 준비 완료':'준비 중';
    row.append(avatar,name,info);return row;
  }
  function renderLobby(s) {
    const list=s.players.filter(p=>!p.spectator);
    const digest=JSON.stringify(list.map(p=>[p.id,p.ready,p.name,p.connected]).concat(s.players.filter(p=>p.spectator).map(p=>[p.id,p.name])));
    if(lastLobby!==digest) {
      lastLobby=digest;
      $('lobbyPlayers').replaceChildren(...s.players.map(p=>playerRow(p,s.host)));
    }
    $('lobbyCode').textContent=s.code;$('lobbyCount').textContent=`${list.length} / 12`;
    const host=s.host===myId;
    $('readyBtn').hidden=host||!!self()?.spectator;
    $('startBtn').hidden=!host;
    $('readyBtn').textContent=self()?.ready?'준비 취소':'준비 완료 ✓';
    const canStart=list.length>=2&&list.every(p=>p.connected!==false&&(p.id===s.host||p.ready));
    $('startBtn').disabled=!canStart;
    $('startBtn').textContent=canStart?'게임 시작하기 →':'모두 준비하면 시작 가능';
  }
  function renderCountdown(s) {
    const me=self(),isMonster=me?.role==='monster';
    $('secretEmoji').textContent=isMonster?'👹':me?.spectator?'👁️':'🏃';
    $('secretRole').textContent=me?.spectator?'관전자':isMonster?'괴물':'일반인';
    $('secretRole').classList.toggle('monster',isMonster);
    $('secretDescription').textContent=me?.spectator?'경기를 관전할 수 있습니다.':isMonster?'모든 일반인을 잡으면 승리!':'단 한 명이라도 살아남으면 승리!';
    $('countNumber').textContent=String(s.countdown);
    $('mapPreview').textContent=`${s.map.icon} ${s.map.name}`;
  }
  function renderResults(s) {
    const digest=JSON.stringify([s.winner,s.players.map(p=>[p.id,p.catches,p.survived,p.alive])]);
    if(digest===lastResults)return;
    lastResults=digest;
    const monsters=s.players.filter(p=>p.role==='monster'&&!p.spectator);
    const civilians=s.players.filter(p=>p.role==='civilian'&&!p.spectator);
    const alive=civilians.filter(p=>p.alive).length;
    const count=monsters.reduce((sum,p)=>sum+p.catches,0);
    const mvp=(s.winner==='monster'?[...monsters].sort((a,b)=>b.catches-a.catches):[...civilians].sort((a,b)=>b.survived-a.survived))[0];
    $('resultEmoji').textContent=s.winner==='civilian'?'🏆':'👹';
    $('resultTitle').textContent=s.winner==='civilian'?'일반인 승리!':'괴물 승리!';
    $('resultTitle').classList.toggle('monster',s.winner==='monster');
    $('resultReason').textContent=s.endReason;
    $('resultSurvivors').textContent=`${alive}명`;$('resultCatches').textContent=`${count}회`;
    $('resultMvp').textContent=mvp?.name||'—';
    $('resultPlayers').replaceChildren(...[...monsters,...civilians].map(p=>{
      const line=document.createElement('div');line.className='result-person';
      const icon=document.createElement('span');icon.className='res-icon';icon.textContent=p.role==='monster'?'👹':p.alive?'🏃':'👻';
      const name=document.createElement('b');name.className='res-name';name.textContent=p.name+(p.id===myId?' (나)':'');
      const stat=document.createElement('span');stat.className='res-detail';stat.textContent=p.role==='monster'?`포획 ${p.catches}명`:`생존 ${clock(p.survived||0)}`;
      line.append(icon,name,stat);return line;
    }));
    $('restartBtn').hidden=s.host!==myId;
    $('waitingRestart').hidden=s.host===myId;
  }
  function renderHUD(s) {
    const p=self();if(!p)return;
    const isMonster=p.role==='monster';
    const isWatching=p.spectator||!p.alive;
    $('hud').hidden=false;
    $('mapName').textContent=`${s.map.icon} ${s.map.name}`;
    $('roomTag').textContent=`#${s.code}`;
    $('roleTag').className=`role-tag ${isMonster?'monster-tag':'runner-tag'}`;
    $('roleTag').innerHTML=`<span>${p.spectator?'👁️':isMonster?'👹':'🏃'}</span> ${p.spectator?'관전자':isMonster?'괴물':'일반인'}`;
    $('timerText').textContent=clock(s.timeLeft);
    $('timerText').parentElement.classList.toggle('urgent',s.timeLeft<=20&&s.status==='playing');
    $('aliveText').textContent=`${s.stats.survivors} 생존`;
    $('staminaNumber').textContent=`${p.stamina??100}%`;
    $('staminaFill').style.width=`${p.stamina??100}%`;
    $('meter').hidden=isWatching;
    $('controls').hidden=isWatching;
    $('spectator').hidden=!isWatching;
    const isPlaying=s.status==='playing';
    $('controls').hidden=!isPlaying||isWatching;
    $('spectator').hidden=!isPlaying||!isWatching;
    $('statusBanner').hidden=true;
    if(!isWatching && isPlaying) {
      if(p.hidden){$('statusBanner').textContent=`🌿 은신 중 · ${numberSeconds(p.hiddenMs)} (이동하면 해제)`;$('statusBanner').hidden=false;}
      else if(p.role==='civilian'&&p.inHide){$('statusBanner').textContent='🌿 여기서 숨을 수 있습니다';$('statusBanner').hidden=false;}
      if(isMonster&&p.scanning){$('statusBanner').textContent='👁 주변 생존자를 탐지 중!';$('statusBanner').hidden=false;}
    }
    $('skillIcon').textContent=isMonster?'👁️':'🌿';
    $('skillName').textContent=isMonster?'탐지':p.hidden?'나오기':'숨기';
    $('skillBtn').classList.toggle('monster-skill',isMonster);
    const ms=isMonster?p.scanMs:p.hideMs;
    $('skillInfo').textContent=ms>0&&!p.hidden?numberSeconds(ms):isMonster?'주변 탐색':p.hidden?'은신 해제':p.inHide?'지금 가능':'은신 구역';
    $('skillBtn').disabled=isMonster?ms>0:!p.hidden&&(!p.inHide||ms>0);
    $('skillBtn').classList.toggle('cooling',ms>0&&!p.hidden);
    $('itemInfo').textContent=`× ${p.smoke??0}`;
    $('itemBtn').disabled=isMonster||!(p.smoke>0);
    $('itemBtn').hidden=isMonster;
    $('sprintBtn').disabled=(p.stamina??0)<1;
  }
  function watchingTargets() {return(state?.players||[]).filter(p=>activePlayer(p));}
  function watchingTarget() {
    const targets=watchingTargets();if(!targets.length)return self();
    return targets[((spectateIndex%targets.length)+targets.length)%targets.length];
  }
  function renderWatcher() {
    const target=watchingTarget();
    $('watchingName').textContent=target?`${target.role==='monster'?'👹':'🏃'} ${target.name}`:'경기 종료 대기';
  }
  $('prevTarget').addEventListener('click',()=>{spectateIndex--;renderWatcher();playNote();});
  $('nextTarget').addEventListener('click',()=>{spectateIndex++;renderWatcher();playNote();});
  function onState(s) {
    state=s;setWorld(s.map);
    for(const p of s.players) if(p.x!==null&&p.y!==null) {
      if(!rendered.has(p.id))rendered.set(p.id,{x:p.x,y:p.y});
    }
    for(const key of rendered.keys()) if(!s.players.some(p=>p.id===key))rendered.delete(key);
    const prior=status;status=s.status;
    if(s.status==='lobby') {showScreen('lobbyView');renderLobby(s);}
    else if(s.status==='countdown') {showScreen('countdownView');renderCountdown(s);}
    else if(s.status==='playing') {showScreen('');renderHUD(s);if(self()?.spectator||!self()?.alive)renderWatcher();}
    else if(s.status==='finished') {showScreen('resultView');renderResults(s);$('hud').hidden=true;$('controls').hidden=true;$('spectator').hidden=true;}
    if(s.status!=='playing') {$('controls').hidden=true;$('spectator').hidden=true;}
    if(s.status==='lobby'||s.status==='countdown')$('hud').hidden=true;
    if(s.status!==prior) {
      if(s.status==='playing') {toast(self()?.role==='monster'?'괴물이 되었습니다! 모두 잡으세요!':'추격 시작! 끝까지 살아남으세요!');playNote('ready');buzz(60);}
      if(s.status==='finished') {playNote(s.winner===self()?.role?'win':'alert');buzz([70,50,70]);}
      if(s.status==='lobby')lastResults='';
    }
    if(s.status==='playing'&&previousAlive&&!self()?.alive&&!self()?.spectator){toast('잡혔습니다. 이제 관전합니다.');playNote('alert');buzz([80,60,80]);spectateIndex=0;}
    previousAlive=self()?.alive??true;
  }
  socket.on('state',onState);
  try{$('nickname').value=sessionStorage.getItem('nightRunName')||'';}catch(_e){}
  const queryCode=new URLSearchParams(location.search).get('room');
  if(queryCode){$('joinCode').value=queryCode.toUpperCase().slice(0,6);}

  function activate(action) {
    const p=self();if(state?.status!=='playing'||!p?.alive||p.spectator)return;
    request('ability',action,()=>{playNote('tap');buzz(25);},null);
  }
  $('skillBtn').addEventListener('click',()=>activate(self()?.role==='monster'?'scan':'hide'));
  $('itemBtn').addEventListener('click',()=>activate('smoke'));

  function resetControls() {
    control.x=control.y=0;control.boost=false;
    $('joystickKnob').style.transform='translate(-50%,-50%)';
    $('sprintBtn').classList.remove('pressed');
  }
  function moveJoy(e) {
    const rect=$('joystick').getBoundingClientRect();
    const dx=e.clientX-rect.left-rect.width/2,dy=e.clientY-rect.top-rect.height/2;
    const radius=rect.width*.32,mag=Math.hypot(dx,dy);
    control.x=mag>radius?dx/mag:dx/radius;
    control.y=mag>radius?dy/mag:dy/radius;
    $('joystickKnob').style.transform=`translate(calc(-50% + ${control.x*radius}px),calc(-50% + ${control.y*radius}px))`;
  }
  const joystick=$('joystick');
  joystick.addEventListener('pointerdown',e=>{if(joyPointer!==null)return;joyPointer=e.pointerId;joystick.setPointerCapture(e.pointerId);moveJoy(e);e.preventDefault();});
  joystick.addEventListener('pointermove',e=>{if(e.pointerId===joyPointer)moveJoy(e);});
  function releaseJoy(e) {if(e.pointerId!==joyPointer)return;joyPointer=null;control.x=control.y=0;$('joystickKnob').style.transform='translate(-50%,-50%)';}
  joystick.addEventListener('pointerup',releaseJoy);joystick.addEventListener('pointercancel',releaseJoy);
  const sprint=$('sprintBtn');
  sprint.addEventListener('pointerdown',e=>{control.boost=true;sprint.classList.add('pressed');sprint.setPointerCapture(e.pointerId);e.preventDefault();});
  for(const evt of ['pointerup','pointercancel','lostpointercapture'])sprint.addEventListener(evt,()=>{control.boost=false;sprint.classList.remove('pressed');});
  window.addEventListener('keydown',e=>{
    if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
    const key=e.key.toLowerCase();
    if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(key))e.preventDefault();
    if(!pressedKeys.has(key)){
      if(key==='e')activate(self()?.role==='monster'?'scan':'hide');
      if(key==='q')activate('smoke');
    }
    pressedKeys.add(key);
  },{passive:false});
  window.addEventListener('keyup',e=>pressedKeys.delete(e.key.toLowerCase()));
  window.addEventListener('blur',()=>{pressedKeys.clear();resetControls();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pressedKeys.clear();resetControls();}});
  setInterval(()=>{
    if(state?.status!=='playing'||!socket.connected)return;
    let x=control.x,y=control.y;
    if(pressedKeys.has('a')||pressedKeys.has('arrowleft'))x-=1;
    if(pressedKeys.has('d')||pressedKeys.has('arrowright'))x+=1;
    if(pressedKeys.has('w')||pressedKeys.has('arrowup'))y-=1;
    if(pressedKeys.has('s')||pressedKeys.has('arrowdown'))y+=1;
    const mag=Math.hypot(x,y);if(mag>1){x/=mag;y/=mag;}
    socket.volatile.emit('input',{x,y,boost:control.boost||pressedKeys.has('shift')||pressedKeys.has(' ')});
  },50);

  function resize() {
    const box=canvas.getBoundingClientRect();viewWidth=box.width;viewHeight=box.height;
    dpr=Math.min(2,window.devicePixelRatio||1);canvas.width=Math.round(box.width*dpr);canvas.height=Math.round(box.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    scale=clamp(viewWidth/435,.78,1.22);
  }
  window.addEventListener('resize',resize);
  if(window.visualViewport)window.visualViewport.addEventListener('resize',resize);
  resize();
  function rect(x,y,w,h,r,color) {
    ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,Math.max(0,r));ctx.fill();
  }
  function circle(x,y,r,color) {ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  function line(x1,y1,x2,y2,color,width=2) {ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  function worldBackground(t) {
    const palette=world.id==='forest'?['#112a2b','#173739','#265147','#416d55']:world.id==='school'?['#1f2435','#2c354b','#3d4b5a','#6b6d77']:['#14243a','#24344b','#35506a','#4b7b83'];
    ctx.fillStyle=palette[0];ctx.fillRect(0,0,world.w,world.h);
    ctx.lineWidth=1;ctx.strokeStyle=world.id==='forest'?'#7fddae0a':'#b3cce512';ctx.beginPath();
    for(let x=0;x<world.w;x+=68){ctx.moveTo(x,0);ctx.lineTo(x,world.h);}
    for(let y=0;y<world.h;y+=68){ctx.moveTo(0,y);ctx.lineTo(world.w,y);}ctx.stroke();
    for(const p of dust) {
      const alpha=.12+.11*Math.sin(t/1300+p.twinkle);
      ctx.globalAlpha=alpha;circle(p.x,p.y,p.r,palette[3]);
    }ctx.globalAlpha=1;
    if(world.id==='forest') {
      for(let i=0;i<26;i++) {
        const x=(i*257+61)%world.w,y=(i*163+130)%world.h;
        ctx.strokeStyle='#96ce9318';ctx.lineWidth=2;ctx.beginPath();
        ctx.arc(x,y,12+(i%4)*4,0,Math.PI*1.5);ctx.stroke();
      }
    }else if(world.id==='school'){
      for(let i=0;i<22;i++) {
        const x=(i*163+98)%world.w,y=(i*349+210)%world.h;
        line(x,y,x+22+(i%3)*9,y,'#9ba8bf18',2);
      }
    }else {
      for(let i=0;i<20;i++){
        const x=(i*337+34)%world.w,y=(i*191+74)%world.h;
        rect(x,y,16,6,2,'#51bcac27');
      }
    }
    // Safe hiding areas are decorative floor spots, not solid walls.
    for(const h of world.hides||[]) {
      const g=ctx.createRadialGradient(h.x,h.y,4,h.x,h.y,h.r);
      g.addColorStop(0,'#64cd9d57');g.addColorStop(.65,'#57be8c26');g.addColorStop(1,'#72dcb000');
      circle(h.x,h.y,h.r,g);
      ctx.strokeStyle='#89e8b05b';ctx.lineWidth=2;ctx.setLineDash([9,8]);
      ctx.beginPath();ctx.arc(h.x,h.y,h.r-8,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
      for(let i=0;i<9;i++) {
        const a=(i*2.399)+h.x, rr=(i%3)*13+15, x=h.x+Math.cos(a)*rr,y=h.y+Math.sin(a)*rr;
        line(x,y+8,x+3,y-5,'#7dcc9a7b',2);line(x+3,y-5,x+8,y+3,'#7dcc9a66',2);
      }
    }
    ctx.strokeStyle='#70b3b23a';ctx.lineWidth=26;ctx.strokeRect(10,10,world.w-20,world.h-20);
    ctx.strokeStyle='#102329';ctx.lineWidth=17;ctx.strokeRect(10,10,world.w-20,world.h-20);
    for(const o of world.obstacles||[]) {
      ctx.shadowColor='#020b16aa';ctx.shadowBlur=24;ctx.shadowOffsetY=12;
      rect(o.x+2,o.y+3,o.w,o.h,13,'#081321');
      ctx.shadowBlur=0;ctx.shadowOffsetY=0;
      rect(o.x,o.y,o.w,o.h,13,palette[2]);
      rect(o.x+7,o.y+7,o.w-14,o.h-14,9,palette[1]);
      ctx.strokeStyle=palette[3]+'8a';ctx.lineWidth=3;
      ctx.beginPath();ctx.roundRect(o.x+12,o.y+12,o.w-24,o.h-24,5);ctx.stroke();
      rect(o.x+11,o.y+10,o.w-22,5,3,'#c1dcd122');
      if(world.id==='forest') {
        for(let i=0;i<3;i++){let px=o.x+18+i*(o.w-36)/3;circle(px,o.y+25,12,'#35675255');}
      }else if(world.id==='school') {
        for(let j=0;j<Math.floor(o.w/40);j++)rect(o.x+15+j*40,o.y+18,21,12,2,'#91a2b52c');
      }else {
        rect(o.x+15,o.y+18,Math.min(60,o.w-30),13,3,'#53c9c138');
      }
    }
  }
  function drawPickups(t){
    for(const p of state?.pickups||[]){
      const offset=Math.sin(t/400+p.x)*3;
      ctx.shadowColor=p.type==='smoke'?'#afc2ff':'#ffe29c';ctx.shadowBlur=13;
      circle(p.x,p.y+offset,15,p.type==='smoke'?'#6d9ff0':'#edbc67');ctx.shadowBlur=0;
      circle(p.x-4,p.y-4+offset,5,'#ffffff8a');
      ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='17px sans-serif';
      ctx.fillText(p.type==='smoke'?'☁':'⚡',p.x,p.y+offset+1);
    }
  }
  function drawTracks(t){
    for(const p of state?.tracks||[]) {
      ctx.save();ctx.globalAlpha=clamp(p.ttl/4700,0,.55);
      circle(p.x-4,p.y-4,4,'#ffb3a0');circle(p.x+4,p.y+3,4,'#ffb3a0');
      ctx.restore();
    }
  }
  function drawSmokes(t){
    for(const s of state?.smokes||[]) {
      const alpha=clamp(s.until/5500,0,.52);
      const grad=ctx.createRadialGradient(s.x,s.y,12,s.x,s.y,s.r);
      grad.addColorStop(0,`rgba(192,216,240,${alpha})`);
      grad.addColorStop(.7,`rgba(160,186,218,${alpha*.74})`);
      grad.addColorStop(1,'rgba(160,186,218,0)');
      circle(s.x,s.y,s.r,grad);
      for(let i=0;i<5;i++)circle(s.x+Math.cos(i*2.4+t/1300)*s.r*.45,s.y+Math.sin(i*1.9+t/1200)*s.r*.38,24,'#d4e2ee0c');
    }
  }
  const outfits=['#7fe3b8','#8ecbf7','#f9d27f','#dcabea','#a3dfa1','#f39e96'];
  const hash=text=>{let total=0;for(let i=0;i<text.length;i++)total=(total*31+text.charCodeAt(i))>>>0;return total;};
  function drawRunner(p,t,isSelf,moving) {
    const color=outfits[hash(p.name)%outfits.length];
    const bob=moving?Math.sin(t/92+p.x*.03)*3:Math.sin(t/450+p.y*.02)*1;
    ctx.save();ctx.translate(p.x,p.y+bob);
    const feet=moving?Math.sin(t/105+p.x*.04)*7:0;
    rect(-17,16+feet,12,13,5,'#293c52');rect(5,16-feet,12,13,5,'#293c52');
    ctx.shadowColor=color;ctx.shadowBlur=isSelf?16:7;
    circle(0,0,20,color);ctx.shadowBlur=0;
    // Small ears, hair tuft, face and blush.
    circle(-14,-15,8,color);circle(14,-15,8,color);
    ctx.fillStyle='#e6f9ef';ctx.beginPath();ctx.ellipse(0,8,10,7,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#213c4a';ctx.beginPath();ctx.arc(-7,-2,3.1,0,Math.PI*2);ctx.arc(7,-2,3.1,0,Math.PI*2);ctx.fill();
    circle(-12,6,3,'#f09a9f99');circle(12,6,3,'#f09a9f99');
    ctx.strokeStyle='#315669';ctx.lineWidth=1.8;ctx.beginPath();ctx.arc(0,5,5,.15,Math.PI-.15);ctx.stroke();
    if(p.hidden) {
      ctx.globalAlpha=.65;ctx.font='22px sans-serif';ctx.textAlign='center';ctx.fillText('🌿',0,-31);
    }
    ctx.restore();
  }
  function drawMonster(p,t,isSelf,moving) {
    const bob=moving?Math.sin(t/96+p.y*.02)*3:Math.sin(t/400)*1.5;
    ctx.save();ctx.translate(p.x,p.y+bob);
    const feet=moving?Math.sin(t/93+p.x*.01)*6:0;
    circle(-11,19+feet,10,'#763045');circle(11,19-feet,10,'#763045');
    ctx.shadowColor='#ff618a';ctx.shadowBlur=isSelf?21:11;
    ctx.fillStyle='#fa6e98';ctx.beginPath();ctx.arc(0,0,25,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    ctx.fillStyle='#e45280';ctx.beginPath();ctx.moveTo(-20,-13);ctx.lineTo(-27,-35);ctx.lineTo(-5,-22);ctx.closePath();ctx.fill();
    ctx.beginPath();ctx.moveTo(20,-13);ctx.lineTo(27,-35);ctx.lineTo(5,-22);ctx.closePath();ctx.fill();
    circle(-9,-4,6,'#452239');circle(9,-4,6,'#452239');
    circle(-10,-7,2.4,'#fff6f6');circle(8,-7,2.4,'#fff6f6');
    ctx.fillStyle='#64243c';ctx.beginPath();ctx.roundRect(-9,9,18,7,3);ctx.fill();
    ctx.fillStyle='#fff7e6';ctx.beginPath();ctx.moveTo(-6,10);ctx.lineTo(-3,15);ctx.lineTo(0,10);ctx.moveTo(2,10);ctx.lineTo(5,15);ctx.lineTo(8,10);ctx.fill();
    if(p.scanning) {
      ctx.strokeStyle='#ff8dadd9';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(0,0,55+(t/15)%55,0,Math.PI*2);ctx.stroke();
    }
    ctx.restore();
  }
  function drawPlayer(p,t,isSelf){
    if(p.x===null||p.y===null||p.spectator||!p.alive)return;
    const pos=rendered.get(p.id)||p,moving=pos.moving||false;
    const character={...p,x:pos.x,y:pos.y};
    ctx.save();
    if(character.hidden&&!isSelf)ctx.globalAlpha=.66;
    ctx.fillStyle='#000b1e85';ctx.beginPath();ctx.ellipse(character.x,character.y+23,22,8,0,0,Math.PI*2);ctx.fill();
    if(p.role==='monster')drawMonster(character,t,isSelf,moving);
    else drawRunner(character,t,isSelf,moving);
    if(isSelf) {
      ctx.strokeStyle='#fff1ab';ctx.lineWidth=2.8;ctx.beginPath();ctx.arc(pos.x,pos.y,33,0,2*Math.PI);ctx.stroke();
    }
    const label=p.name.length>10?p.name.slice(0,10)+'…':p.name;
    ctx.font='800 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    const w=Math.max(47,ctx.measureText(label).width+19);
    rect(pos.x-w/2,pos.y-60,w,23,8,isSelf?'#edf9cbe5':'#071525e5');
    ctx.fillStyle=isSelf?'#213e40':'#ecf4f5';ctx.fillText(label,pos.x,pos.y-48);
    ctx.restore();
  }
  function drawAmbient(t){
    const glow=ctx.createRadialGradient(viewWidth*.5,viewHeight*.52,viewWidth*.05,viewWidth*.5,viewHeight*.52,Math.max(viewWidth,viewHeight)*.66);
    glow.addColorStop(0,'#050b1200');glow.addColorStop(.68,'#050b120b');glow.addColorStop(1,'#050b12c8');
    ctx.fillStyle=glow;ctx.fillRect(0,0,viewWidth,viewHeight);
    if(state?.status==='playing') {
      const p=self();
      if(p?.role==='monster') {
        const edge=ctx.createLinearGradient(0,0,0,viewHeight);
        edge.addColorStop(0,'#fa6d9220');edge.addColorStop(.25,'transparent');edge.addColorStop(.8,'transparent');edge.addColorStop(1,'#fa6d921b');
        ctx.fillStyle=edge;ctx.fillRect(0,0,viewWidth,viewHeight);
      }
    }
  }
  function cameraFocus() {
    if(state?.status==='playing') {
      const p=self();if(p?.alive&&!p.spectator)return rendered.get(p.id)||p;
      const target=watchingTarget();return target&&(rendered.get(target.id)||target);
    }
    return {x:720,y:480};
  }
  function renderFrame(t) {
    const dt=Math.min(.1,(t-lastFrame)/1000||.016);lastFrame=t;
    for(const p of state?.players||[]) {
      if(p.x===null||p.y===null)continue;
      let pos=rendered.get(p.id);if(!pos){pos={x:p.x,y:p.y};rendered.set(p.id,pos);}
      const ox=pos.x,oy=pos.y;
      const ease=1-Math.exp(-dt*14);
      pos.x+=(p.x-pos.x)*ease;pos.y+=(p.y-pos.y)*ease;
      pos.moving=Math.hypot(pos.x-ox,pos.y-oy)>dt*12;
    }
    const focus=cameraFocus();
    if(focus?.x!=null&&focus?.y!=null){const ease=1-Math.exp(-dt*7);camera.x+=(focus.x-camera.x)*ease;camera.y+=(focus.y-camera.y)*ease;}
    const halfW=viewWidth/scale/2,halfH=viewHeight/scale/2;
    const camX=halfW>=world.w/2?world.w/2:clamp(camera.x,halfW,world.w-halfW);
    const camY=halfH>=world.h/2?world.h/2:clamp(camera.y,halfH,world.h-halfH);
    ctx.fillStyle='#08121c';ctx.fillRect(0,0,viewWidth,viewHeight);
    ctx.save();ctx.translate(viewWidth/2-camX*scale,viewHeight/2-camY*scale);ctx.scale(scale,scale);
    worldBackground(t);
    if(state?.status==='playing'||state?.status==='finished'||state?.status==='countdown') {
      drawPickups(t);drawTracks(t);
      for(const p of state.players.filter(p=>p.id!==myId))drawPlayer(p,t,false);
      const me=self();if(me)drawPlayer(me,t,true);
      drawSmokes(t);
    }
    ctx.restore();drawAmbient(t);
    requestAnimationFrame(renderFrame);
  }
  requestAnimationFrame(renderFrame);
})();
