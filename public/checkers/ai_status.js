'use strict';
fetch('release-summary.json?v=20260915stage1',{cache:'no-store'}).then(function(response){
  if(!response.ok)throw new Error('HTTP '+response.status);return response.json();
}).then(function(data){
  document.getElementById('version').textContent=data.release+' · '+data.modelVersion;
  document.getElementById('decision').textContent=data.decision;
  document.getElementById('data').textContent=data.training.games+' 盘搜索自对弈，'+data.training.positions.toLocaleString()+' 个局面，'+data.training.actionRows.toLocaleString()+' 条候选走法。训练方式：'+data.training.method+'。';
  data.arenas.forEach(function(a){const row=document.createElement('tr');[a.name,a.wins,a.losses,a.draws,a.games].forEach(function(v){const cell=document.createElement('td');cell.textContent=v;row.appendChild(cell);});document.getElementById('arenaRows').appendChild(row);});
  data.limitations.forEach(function(text){const li=document.createElement('li');li.textContent=text;document.getElementById('limits').appendChild(li);});
}).catch(function(error){document.getElementById('decision').textContent='无法加载交付报告：'+error.message+'。请刷新页面重试。';});
