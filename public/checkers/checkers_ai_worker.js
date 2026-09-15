'use strict';
const BUILD_ID = '20260915stage1';
importScripts('checkers_core.js?v=' + BUILD_ID, 'checkers_ai_engine.js?v=' + BUILD_ID);
try { importScripts('checkers_ai_model_v3.js?v=' + BUILD_ID); } catch (e) { self.CheckersStageModel = null; }
self.onmessage = function (event) {
  const message = event && event.data || {}, requestId = Number(message.requestId);
  try {
    if (!Number.isSafeInteger(requestId)) throw new Error('Invalid request ID');
    const clean = self.CheckersCore.sanitizeState({pieces:message.pieces,turn:message.player,moveNumber:message.moveNumber,winner:''});
    if (!clean || Object.keys(clean.pieces).length !== Object.keys(message.pieces).length) throw new Error('Invalid board');
    const result = self.CheckersAI.chooseMove(clean.pieces, clean.turn, {
      seats:message.seats,level:message.level,seed:message.seed,model:self.CheckersStageModel,
      recentPositions:Array.isArray(message.recentPositions)?message.recentPositions.filter(k=>typeof k==='string'&&k.length<140).slice(-40):[]
    });
    self.postMessage({requestId:requestId,move:result.move,stats:result.stats});
  } catch(error) { self.postMessage({requestId:requestId,move:null,error:String(error && error.message || error)}); }
};
