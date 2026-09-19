'use strict';
// Requires Playwright. Set PLAYWRIGHT_MODULE to the bundled module path if it is not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const port = 36000 + Math.floor(Math.random() * 1000);
const base = 'http://127.0.0.1:' + port;
const output = process.env.BIRTHDAY_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'birthday-ui-'));
const server = spawn(process.execPath, ['server.js'], { cwd:path.join(__dirname,'..'), env:{...process.env,PORT:String(port)}, stdio:'ignore' });
let browser, passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log('PASS ' + name); }
(async function () {
  try {
    for (let i=0;i<80;i++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      await new Promise(r=>setTimeout(r,50));
    }
    browser = await chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({viewport:{width:1024,height:800}});
    await context.addInitScript(() => {
      const Native = window.AudioContext;
      window.__birthdayAudio = []; window.__birthdayNotes = [];
      if (Native) window.AudioContext = class extends Native {
        constructor(...args) { super(...args); window.__birthdayAudio.push(this); }
        createOscillator() {
          const voice=super.createOscillator(), start=voice.start.bind(voice);
          voice.start=time=>{window.__birthdayNotes.push({time,scheduledAt:this.currentTime});return start(time);};
          return voice;
        }
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto(base + '/checkers/play.html?mode=local&birthday=1&intent=new');
    await page.locator('#birthdayStartBtn').waitFor({state:'visible'});
    check('帷幕打开前不允许走子或自动播放音乐', await page.evaluate(()=>birthdayOpening()&&!canAct()&&window.__birthdayAudio.length===0));
    for (const width of [375,414,768,1024,1440]) {
      await page.setViewportSize({width,height:800});
      check(width+'px 帷幕与按钮完整可见', await page.evaluate(()=>{
        const d=document.querySelector('.bd-intro'),b=document.getElementById('birthdayStartBtn').getBoundingClientRect();
        return d.scrollWidth<=d.clientWidth&&b.top>=0&&b.bottom<=innerHeight;
      }));
    }
    await page.setViewportSize({width:1024,height:800});
    await page.screenshot({path:path.join(output,'curtain.png')});
    await page.locator('#birthdayStartBtn').click();
    await page.waitForTimeout(900);
    await page.screenshot({path:path.join(output,'curtain-opening.png')});
    await page.waitForFunction(()=>!window.__checkersBirthday.opening);
    check('拉开帷幕后恢复棋盘操作', await page.evaluate(()=>canAct()&&!document.querySelector('.bd-intro').open));
    await page.evaluate(()=>{gameOver='red';showWinner('red');});
    await page.locator('#birthdayBlowBtn').waitFor({state:'visible'});
    check('结局显示五根蜡烛与生日祝福，背景不可操作', await page.evaluate(()=>document.querySelectorAll('.bd-candle').length===5&&document.querySelector('main').inert&&document.getElementById('winnerTitle').textContent.includes('生日快乐')));
    for (const width of [375,414,768,1024,1440]) {
      await page.setViewportSize({width,height:800});
      check(width+'px 蛋糕弹窗无横向溢出', await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.winner-card').scrollWidth<=document.querySelector('.winner-card').clientWidth));
    }
    await page.setViewportSize({width:414,height:800});
    await page.waitForTimeout(700);
    await page.screenshot({path:path.join(output,'cake-mobile.png')});
    await page.locator('#birthdayBlowBtn').click();
    check('吹蜡烛先弯曲火苗，期间防止重复触发',await page.evaluate(()=>document.querySelector('.bd-cake').classList.contains('is-blowing')&&document.getElementById('birthdayBlowBtn').disabled&&getComputedStyle(document.querySelector('.bd-flame')).animationName==='bd-flame-out'));
    await page.waitForTimeout(260);
    await page.screenshot({path:path.join(output,'candles-blowing.png')});
    await page.locator('.bd-cake.is-blown').waitFor({state:'visible'});
    await page.screenshot({path:path.join(output,'candles-out.png')});
    await page.waitForFunction(()=>document.getElementById('birthdayMusicBtn').getAttribute('aria-pressed')==='true');
    check('音乐在熄灭动作之后接入，而非点击瞬间抢先播放',await page.evaluate(()=>window.__birthdayNotes[0].time-window.__birthdayNotes[0].scheduledAt>=.85));
    check('点击吹蜡烛才启动真实 AudioContext，蜡烛熄灭', await page.evaluate(()=>document.querySelector('.bd-cake').classList.contains('is-blown')&&window.__birthdayAudio.length===1&&window.__birthdayAudio[0].state==='running'));
    await page.evaluate(()=>showWinner('red'));
    check('重复胜利通知不会重置蜡烛或重复启动音乐', await page.evaluate(()=>document.querySelector('.bd-cake').classList.contains('is-blown')&&window.__birthdayAudio.length===1));
    await page.locator('#birthdayMusicBtn').click();
    await page.waitForFunction(()=>window.__birthdayAudio[0].state==='suspended');
    check('停止音乐按钮立即停播', true);
    await page.evaluate(()=>{closeWinner();showWinner('blue');});
    check('下一局生日标题仍存在，蜡烛重新点亮', await page.evaluate(()=>!document.querySelector('.bd-cake').classList.contains('is-blown')&&document.getElementById('winnerTitle').textContent.includes('生日快乐')));
    await page.locator('#birthdayBlowBtn').click();
    await page.waitForFunction(()=>document.getElementById('birthdayMusicBtn').getAttribute('aria-pressed')==='true');
    await page.locator('#winnerNewBtn').click();
    await page.locator('#birthdayStartBtn').waitFor({state:'visible'});
    await page.waitForFunction(()=>window.__birthdayAudio[0].state==='suspended');
    check('重开停止音乐与彩屑，重新拉幕', await page.evaluate(()=>document.querySelectorAll('.bd-confetti').length===0&&birthdayOpening()));
    await page.keyboard.press('Escape');
    check('Escape 可跳过开场', await page.evaluate(()=>!birthdayOpening()&&canAct()));

    const reduced = await browser.newContext({viewport:{width:375,height:800},reducedMotion:'reduce'});
    const rp = await reduced.newPage();
    await rp.goto(base+'/checkers/play.html?mode=local&birthday=1&intent=new');
    await rp.locator('#birthdayStartBtn').click();
    check('减少动态效果时立即揭幕', await rp.evaluate(()=>!birthdayOpening()));
    await rp.evaluate(()=>{gameOver='red';showWinner('red');});
    await rp.locator('#birthdayBlowBtn').click();
    check('减少动态效果时不撒花、不闪烁烛火', await rp.evaluate(()=>document.querySelectorAll('.bd-confetti').length===0&&getComputedStyle(document.querySelector('.bd-flame')).animationName==='none'));
    await reduced.close();

    const quiet = await browser.newContext();
    await quiet.addInitScript(()=>{window.AudioContext=undefined;window.webkitAudioContext=undefined;});
    const qp = await quiet.newPage();
    await qp.goto(base+'/checkers/play.html?mode=local&birthday=1&intent=new');
    await qp.locator('#birthdaySkipBtn').click();
    await qp.evaluate(()=>{gameOver='red';showWinner('red');});
    await qp.locator('#birthdayBlowBtn').click();
    await qp.locator('.bd-cake.is-blown').waitFor({state:'visible'});
    check('不支持音频仍能吹灭蜡烛和再来一局', await qp.evaluate(()=>document.querySelector('.bd-cake').classList.contains('is-blown')&&document.getElementById('birthdayCandleStatus').textContent.includes('暂不支持')));
    await quiet.close();

    const finishedSave = await page.evaluate(()=>{
      const p={};Core.BOTTOM_CAMP.forEach(k=>p[k]='red');
      Core.BOARD_CELLS.filter(c=>!c.camp).slice(0,10).forEach(c=>p[c.key]='blue');
      return {pieces:p,turn:'red',moveNumber:90,winner:'red',seats:[{color:'red',isAI:false},{color:'blue',isAI:false}]};
    });
    const resumed = await browser.newContext();
    await resumed.addInitScript(save=>localStorage.setItem('chinese_checkers_save_v2_local',JSON.stringify(save)),finishedSave);
    const savedPage = await resumed.newPage();
    await savedPage.goto(base+'/checkers/play.html?mode=local&birthday=1&intent=resume');
    await savedPage.locator('#birthdayBlowBtn').waitFor({state:'visible'});
    check('恢复已结束存档直接显示蛋糕，帷幕不遮挡结局',await savedPage.evaluate(()=>!birthdayOpening()&&!document.querySelector('.bd-intro').open&&document.getElementById('winnerTitle').textContent.includes('生日快乐')));
    await resumed.close();

    await page.goto(base+'/checkers/play.html?mode=local&birthday=0&intent=new');
    await page.evaluate(()=>{gameOver='red';showWinner('red');});
    check('普通模式保留原获胜弹窗，没有帷幕、蛋糕或音乐', await page.evaluate(()=>!document.querySelector('.bd-intro')&&!document.querySelector('.bd-cake')&&document.getElementById('winnerTitle').textContent==='红方获胜！'));
    check('真实浏览器无脚本异常', errors.length===0);
    console.log('Birthday UI: '+passed+' checks passed. Screenshots: '+output);
  } finally { if(browser) await browser.close();server.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
