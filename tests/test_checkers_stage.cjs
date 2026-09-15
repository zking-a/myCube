'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const C=require('../public/checkers/checkers_core.js'),E=require('../public/checkers/checkers_ai_engine.js');
const cells=new Map(C.BOARD_CELLS.map(c=>[c.key,c]));
function reference(p,from) {
 const origin=cells.get(from);if(!origin||!p[from])return[];
 const occupied={...p};delete occupied[from];const found=new Set(),seen=new Set([from]),queue=[from];
 for(const [r,u]of C.DIRECTIONS){const k=C.keyOf(origin.row+r,origin.unit+u);if(cells.has(k)&&!p[k])found.add(k);}
 for(let i=0;i<queue.length;i++){const c=cells.get(queue[i]);for(const [r,u]of C.DIRECTIONS){
  const mid=C.keyOf(c.row+r,c.unit+u),to=C.keyOf(c.row+2*r,c.unit+2*u);
  if(occupied[mid]&&cells.has(to)&&!occupied[to]&&!seen.has(to)){found.add(to);seen.add(to);queue.push(to);}
 }}return [...found].sort();
}
test('121 holes, six disjoint 10-hole camps',()=>{
 assert.equal(cells.size,121);const all=C.CAMP_IDS.flatMap(c=>C.CAMP_KEYS[c]);assert.equal(all.length,60);assert.equal(new Set(all).size,60);
});
test('Independent rule fuzz: 1200 positions, 2–6 players, paths and immutability',()=>{
 const random=E.rng(49021);let positions=0,comparisons=0;
 for(let g=0;g<15;g++){
  const n=2+g%5,seats=C.seatColorsFor(C.SEAT_LAYOUTS[n]);let p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[n]);
  for(let ply=0;ply<80;ply++){
   positions++;for(const k of Object.keys(p)){assert.deepEqual([...new Set(C.getLegalMoves(p,k).all)].sort(),reference(p,k));comparisons++;}
   const actor=seats[ply%n],moves=C.listMoves(p,actor);if(!moves.length)continue;
   const m=moves[Math.floor(random()*moves.length)],before=JSON.stringify(p),r=C.applyMove(p,actor,m.from,m.target);
   assert.ok(r);assert.equal(JSON.stringify(p),before);assert.equal(Object.keys(r.pieces).length,n*10);
   assert.equal(r.path[0],m.from);assert.equal(r.path.at(-1),m.target);p=r.pieces;
  }
 }assert.equal(positions,1200);assert.equal(comparisons,48000);
});
test('All bundled replay moves remain legal',()=>{
 const replays=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/checkers/training/latest.json'))).replays;
 for(const replay of replays){let p=C.createInitialPieces();for(const m of replay.actions){const r=C.applyMove(p,m.player,m.from,m.target);assert.ok(r,JSON.stringify(m));p=r.pieces;}}
});
test('All six camps have equal initial evaluation and forward move scores',()=>{
 const p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);
 const scores=C.COLORS.map(c=>E.positionScore(p,c));for(const s of scores)assert.ok(Math.abs(s-scores[0])<1e-7);
 const baseline=C.listMoves({'8:0':'red'},'red').map(m=>C.moveScore({'8:0':'red'},'red',m)).sort((a,b)=>a-b);
 for(const color of C.COLORS){const b={'8:0':color};const xs=C.listMoves(b,color).map(m=>C.moveScore(b,color,m)).sort((a,b)=>a-b);xs.forEach((x,i)=>assert.ok(Math.abs(x-baseline[i])<1e-7));}
 const green={'8:0':'green'};assert.ok(C.moveScore(green,'green',{from:'8:0',target:'9:-1',kind:'step'})>C.moveScore(green,'green',{from:'8:0',target:'7:-1',kind:'step'}));
});
test('Opening/contact are state-triggered; six-player turn one is already near-contact',()=>{
 assert.equal(E.detectStage(C.createInitialPieces(),'red',['red','blue']).name,'opening');
 const p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);assert.equal(E.detectStage(p,'green',C.seatColorsFor(C.SEAT_LAYOUTS[6])).name,'contact');
});
test('Immediate winning move is not lost to width=1 pruning, all six colors',()=>{
 for(const actor of C.COLORS){
  const goals=C.goalFor(actor);let target,from;
  for(const k of goals){const c=cells.get(k);for(const [dr,du]of C.DIRECTIONS){const f=C.keyOf(c.row+dr,c.unit+du);if(cells.has(f)&&!goals.has(f)){target=k;from=f;break;}}if(from)break;}
  const enemy=C.COLORS.find(c=>c!==actor),p={};for(const k of goals)if(k!==target)p[k]=actor;p[from]=actor;
  for(const c of C.BOARD_CELLS.filter(c=>!c.camp&&!p[c.key]).slice(0,10))p[c.key]=enemy;
  const result=E.chooseMove(p,actor,{seats:[actor,enemy],level:'hard',rootWidth:1,width:1,maxNodes:0,timeLimitMs:1});
  assert.equal(result.stats.algorithm,'direct-win');assert.equal(C.applyMove(p,actor,result.move.from,result.move.target).winner,actor);
 }
});
test('Budget interruption returns last completed iteration, not partial root scores',()=>{
 const p=C.createInitialPieces(),opts={seats:['red','blue'],level:'hard',forceAlgorithm:'alpha-beta',timeLimitMs:0,width:6,rootWidth:20};
 const base=E.chooseMove(p,'red',{...opts,maxNodes:10000,maxDepth:1});
 const cut=E.chooseMove(p,'red',{...opts,maxNodes:base.stats.nodes+3,maxDepth:5});
 assert.equal(cut.stats.completedDepth,1);assert.deepEqual(cut.move,base.move);assert.deepEqual(cut.candidates,base.candidates);
 const zero=E.chooseMove(p,'red',{...opts,maxNodes:0,maxDepth:5});
 assert.equal(zero.stats.completedDepth,0);assert.equal(zero.stats.reliable,false);assert.ok(C.applyMove(p,'red',zero.move.from,zero.move.target));
});
test('Equal fixed-node options and seed reproduce exact move/stats excluding clock',()=>{
 const p=C.createInitialPieces(),o={seats:['red','blue'],level:'hard',timeLimitMs:0,maxNodes:2400,maxDepth:3};
 const a=E.chooseMove(p,'red',o),b=E.chooseMove(p,'red',o);assert.deepEqual(a.move,b.move);assert.equal(a.stats.nodes,b.stats.nodes);
});
test('Multiplayer PUCT has one utility per player, no fake two-player conversion',()=>{
 const seats=C.seatColorsFor(C.SEAT_LAYOUTS[6]),p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);
 for(const actor of seats){const r=E.chooseMove(p,actor,{seats,level:'hard',timeLimitMs:0,maxNodes:5000,iterations:40,rolloutPlies:4});
  assert.equal(r.stats.algorithm,'multiplayer-puct');assert.equal(p[r.move.from],actor);assert.ok(r.stats.simulations>0);
  for(const c of r.candidates){assert.equal(c.utilities.length,6);assert.ok(Math.abs(c.utilities.reduce((x,y)=>x+y,0)-1)<1e-8);}
 }
});
test('Invalid seat order is rejected, not silently coerced to blue',()=>{
 assert.throws(()=>E.chooseMove(C.createInitialPieces(),'green',{seats:['red','blue']}));
 assert.throws(()=>E.chooseMove(C.createInitialPieces(),'red',{seats:['red','red']}));
});
test('Real worker script accepts green and rejects invalid boards',()=>{
 const sandbox={self:null,performance,console};sandbox.self=sandbox;sandbox.globalThis=sandbox;let posted;
 sandbox.postMessage=x=>posted=x;
 const ctx=vm.createContext(sandbox);
 sandbox.importScripts=(...urls)=>{for(const url of urls)vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/checkers',url.split('?')[0]),'utf8'),ctx);};
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/checkers/checkers_ai_worker.js'),'utf8'),ctx);
 const seats=C.seatColorsFor(C.SEAT_LAYOUTS[6]),p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);
 sandbox.onmessage({data:{requestId:1,pieces:p,player:'green',seats,level:'easy'}});
 assert.ok(!posted.error);assert.equal(p[posted.move.from],'green');
 sandbox.onmessage({data:{requestId:2,pieces:{'8:0':'green'},player:'green',seats,level:'hard'}});assert.ok(posted.error);
});
test('Trained exported model agrees with Python inference; multiplayer model is gated off',()=>{
 const file=path.join(__dirname,'fixtures/checkers-stage/candidate_model.json'),fixtureFile=path.join(__dirname,'fixtures/checkers-stage/model_parity_fixture.json');
 assert.ok(fs.existsSync(file),'Train the model before running full release tests');
 const m=JSON.parse(fs.readFileSync(file)),fixture=JSON.parse(fs.readFileSync(fixtureFile));
 fixture.input.forEach((x,i)=>assert.ok(Math.abs(E.predict(x,m.policy)-fixture.expected[i])<2e-5));
 const p=C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);
 const r=E.chooseMove(p,'green',{seats:C.seatColorsFor(C.SEAT_LAYOUTS[6]),level:'easy',model:m,useModel:true});assert.equal(r.stats.modelUsed,false);
});

test('Legacy public chooseAiMove API also uses the repaired stage engine',()=>{
 const p=C.createInitialPieces(),opts={timeLimitMs:0,maxNodes:500,maxDepth:2,seed:777};
 assert.deepEqual(C.chooseAiMove(p,'red','hard',null,opts),E.chooseMove(p,'red',{...opts,level:'hard'}).move);
 const a=C.analyzeAiMoves(p,'red','hard',opts);assert.equal(a.diagnostics.version,E.VERSION);
});
