/* Birthday presentation: curtains, candles and a locally synthesized music-box melody. */
(function () {
  'use strict';
  if (!window.__checkersBirthday || !window.__checkersBirthday.active) return;
  let intro, openingTimer, autoOpeningTimer, blowTimer, musicTimer, audioContext, playing = false, musicEpoch = 0;
  let cake, blowButton, musicButton, status, result, shown = false, blown = false, blowing = false;
  const voices = new Map(), particles = new Map();
  const preference = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = function () { return !!(preference && preference.matches); };
  const $ = function (id) { return document.getElementById(id); };
  const person = Array.from((new URLSearchParams(location.search).get('name') || '玫玫').trim()).slice(0, 24).join('') || '玫玫';

  function finishOpening(restoreFocus) {
    if (!intro || !window.__checkersBirthday.opening) return;
    clearTimeout(openingTimer);
    clearTimeout(autoOpeningTimer);
    window.__checkersBirthday.opening = false;
    if (intro.open) intro.close();
    document.documentElement.classList.remove('bd-reveal');
    document.dispatchEvent(new CustomEvent('checkers:opening-end'));
    if (restoreFocus) {
      const focus = document.querySelector('#board [tabindex="0"]');
      if (focus) focus.focus({ preventScroll: true });
    }
  }
  function openCurtains() {
    if (!intro || intro.classList.contains('is-opening')) return;
    if (reduced()) { finishOpening(true); return; }
    intro.classList.add('is-opening');
    document.documentElement.classList.add('bd-reveal');
    openingTimer = setTimeout(function () { finishOpening(true); }, 2300);
  }
  function showOpening(options) {
    if (!intro || $('winnerOverlay').classList.contains('active')) return;
    const automatic = !!(options && options.automatic);
    $('birthdayStartBtn').hidden = automatic;
    intro.classList.remove('is-opening');
    window.__checkersBirthday.opening = true;
    if (typeof intro.showModal === 'function') {
      if (!intro.open) intro.showModal();
      (automatic ? $('birthdaySkipBtn') : $('birthdayStartBtn')).focus();
      if (automatic) {
        if (reduced()) finishOpening(true);
        else autoOpeningTimer = setTimeout(openCurtains, 650);
      }
    } else window.__checkersBirthday.opening = false;
  }

  function clearConfetti() {
    particles.forEach(function (timer, node) { clearTimeout(timer); node.remove(); });
    particles.clear();
  }
  function celebrate() {
    clearConfetti();
    if (reduced()) return;
    const colors = ['#ed769a', '#e8bf78', '#af8cdd', '#94cdb7'];
    const origin = cake.getBoundingClientRect(), spread = Math.min(window.innerWidth * .85, 600);
    for (let i = 0; i < 32; i++) {
      const node = document.createElement('i'); node.className = 'bd-confetti';
      node.setAttribute('aria-hidden', 'true');
      node.style.left = (origin.left + origin.width / 2) + 'px'; node.style.top = (origin.top + 65) + 'px';
      node.style.background = colors[i % colors.length];
      node.style.setProperty('--dx', (Math.random() - .5) * spread + 'px');
      node.style.setProperty('--rise', (-65 - Math.random() * 110) + 'px');
      node.style.setProperty('--spin', ((Math.random() - .5) * 1000) + 'deg');
      const duration = 2400 + Math.random() * 1200, delay = Math.random() * 400;
      node.style.animationDuration = duration + 'ms'; node.style.animationDelay = delay + 'ms';
      const remove = function () { clearTimeout(particles.get(node)); particles.delete(node); node.remove(); };
      node.addEventListener('animationend', remove, { once: true });
      particles.set(node, setTimeout(remove, duration + delay + 100)); document.body.appendChild(node);
    }
  }

  // Traditional Happy Birthday tune; generated notes, no recording or network request.
  const melody = [
    [67,.5],[67,.5],[69,1],[67,1],[72,1],[71,2],
    [67,.5],[67,.5],[69,1],[67,1],[74,1],[72,2],
    [67,.5],[67,.5],[79,1],[76,1],[72,1],[71,1],[69,2],
    [77,.5],[77,.5],[76,1],[72,1],[74,1],[72,2.5]
  ];
  function stopMusic() {
    musicEpoch++; clearTimeout(musicTimer); playing = false;
    voices.forEach(function (gain, voice) {
      voice.onended = null;
      try { voice.stop(); } catch (_) {}
      voice.disconnect(); gain.disconnect();
    });
    voices.clear();
    if (audioContext && audioContext.state === 'running') audioContext.suspend().catch(function () {});
    if (musicButton) { musicButton.textContent = '播放生日歌'; musicButton.setAttribute('aria-pressed', 'false'); }
  }
  async function playMusic(leadSeconds) {
    stopMusic();
    const epoch = musicEpoch, Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) { status.textContent = '愿望已经送达。这台设备暂不支持播放音乐。'; return; }
    try {
      if (!audioContext || audioContext.state === 'closed') audioContext = new Audio();
      await audioContext.resume();
      if (epoch !== musicEpoch || !shown || !blown) return;
      playing = true;
      musicButton.textContent = '停止音乐'; musicButton.setAttribute('aria-pressed', 'true');
      if (!blowing) status.textContent = '生日快乐！愿你的每一个愿望，都慢慢实现。';
      let at = audioContext.currentTime + (leadSeconds || .04);
      melody.forEach(function (note) {
        const duration = note[1] * .43, gain = audioContext.createGain();
        gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.075, at + .014);
        gain.gain.exponentialRampToValueAtTime(.001, at + duration * .94); gain.connect(audioContext.destination);
        const voice = audioContext.createOscillator(); voice.type = 'triangle';
        voice.frequency.value = 440 * Math.pow(2, (note[0] - 69) / 12); voice.connect(gain); voices.set(voice, gain);
        voice.onended = function () { voices.delete(voice); voice.disconnect(); gain.disconnect(); };
        voice.start(at); voice.stop(at + duration); at += duration;
      });
      musicTimer = setTimeout(function () {
        stopMusic();
        if (shown) { musicButton.textContent = '再听一次'; status.textContent = '把这份快乐留住，我们再来一局。'; }
      }, Math.ceil((at - audioContext.currentTime) * 1000) + 100);
    } catch (_) {
      if (epoch === musicEpoch) { stopMusic(); status.textContent = '蜡烛已经吹灭，点“播放生日歌”再试一次。'; }
    }
  }
  function blowCandles() {
    if (!shown || blown) return;
    blown = true; blowing = true;
    cake.classList.add('is-blowing');
    blowButton.disabled = true; blowButton.textContent = '呼——愿望正在启程';
    status.textContent = '轻轻一吹，把愿望送向星光。';
    // Resume audio in the click gesture, but start the melody after the flames have gone out.
    if (typeof soundEnabled !== 'undefined' && !soundEnabled) status.textContent = '愿望已送达。音效已关闭，想听音乐可以点击播放。';
    else playMusic(reduced() ? .04 : .9);
    if (reduced()) finishBlowing();
    else blowTimer = setTimeout(finishBlowing, 850);
  }
  function finishBlowing() {
    if (!shown || !blowing) return;
    clearTimeout(blowTimer); blowing = false;
    cake.classList.remove('is-blowing'); cake.classList.add('is-blown');
    cake.setAttribute('aria-label', '蜡烛已吹灭的生日蛋糕');
    blowButton.hidden = true; blowButton.disabled = false; blowButton.textContent = '许好愿了，吹蜡烛';
    musicButton.hidden = false; musicButton.focus({ preventScroll: true });
    if (playing) status.textContent = '生日快乐！愿你的每一个愿望，都慢慢实现。';
    celebrate();
  }
  function presentWinner(detail) {
    if (!cake) return;
    finishOpening(false);
    if (!shown) {
      shown = true; blown = false; blowing = false; clearTimeout(blowTimer);
      stopMusic(); clearConfetti(); cake.classList.remove('is-blown', 'is-blowing');
      blowButton.disabled = false; blowButton.textContent = '许好愿了，吹蜡烛';
      cake.setAttribute('aria-label', '点着五根蜡烛的生日蛋糕'); blowButton.hidden = false; musicButton.hidden = true;
    }
    $('winnerTitle').textContent = person + '，生日快乐！';
    $('winnerText').textContent = '这一刻，胜负让位给祝福。';
    result.textContent = (detail && detail.label ? detail.label : '本局') + '完成了这场对局';
    if (!blown) status.textContent = '闭上眼许个愿，再一起吹灭蜡烛。';
    const main = document.querySelector('main'); if (main) main.inert = true;
  }
  function dismissWinner() {
    shown = false; blown = false; blowing = false; clearTimeout(blowTimer); stopMusic(); clearConfetti();
    const main = document.querySelector('main'); if (main) main.inert = false;
  }
  function cakeArt() {
    // A single lightweight vector illustration stays crisp at every viewport size.
    const pearls = [64,83,102,121,140,160,180,199,218,237,256].map(function (x) {
      const y = 184 + 10 * (1 - Math.pow((x - 160) / 100, 2));
      return '<circle cx="' + x + '" cy="' + y.toFixed(1) + '" r="3" fill="#fff7e7" stroke="#dca886" stroke-width=".6"/>';
    }).join('');
    return '<svg class="bd-cake-art" viewBox="0 0 320 230" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="bd-rose" x2="1" y2="0"><stop stop-color="#d57792"/><stop offset=".35" stop-color="#f3b5c2"/><stop offset=".7" stop-color="#eaa0b5"/><stop offset="1" stop-color="#c66d87"/></linearGradient>' +
      '<linearGradient id="bd-cream" x2="1" y2="0"><stop stop-color="#e8cbb0"/><stop offset=".42" stop-color="#fff1d9"/><stop offset="1" stop-color="#e5c0a2"/></linearGradient>' +
      '<linearGradient id="bd-gold" x2="0" y2="1"><stop stop-color="#f7dfb2"/><stop offset=".55" stop-color="#c79c62"/><stop offset="1" stop-color="#ead1a2"/></linearGradient>' +
      '<radialGradient id="bd-icing"><stop stop-color="#fffdf3"/><stop offset="1" stop-color="#f6e2c9"/></radialGradient></defs>' +
      '<ellipse cx="160" cy="214" rx="128" ry="11" fill="#b4767320"/>' +
      '<ellipse cx="160" cy="207" rx="143" ry="18" fill="url(#bd-gold)"/><ellipse cx="160" cy="203" rx="140" ry="15" fill="#fff2d9" stroke="#d5af79"/>' +
      '<path d="M43 125 Q160 155 277 125 V177 C277 210 43 210 43 177Z" fill="url(#bd-rose)"/>' +
      '<path d="M44 165 Q160 191 276 165" fill="none" stroke="#fbdfcd" stroke-width="5"/>' +
      '<path d="M44 170 Q160 195 276 170" fill="none" stroke="#cfa077" stroke-width="1"/>' +
      '<ellipse cx="160" cy="125" rx="117" ry="25" fill="url(#bd-icing)"/>' +
      '<path d="M43 125 C50 143 59 141 68 139 Q68 158 77 158 Q86 158 87 144 Q99 148 110 148 Q110 167 120 168 Q131 168 132 151 L160 153 Q160 165 168 165 Q177 165 177 152 L204 149 Q204 165 213 164 Q222 163 222 145 Q247 140 249 140 Q250 154 258 151 Q266 149 264 135 Q274 132 277 125 Q160 155 43 125Z" fill="#fff4e2"/>' + pearls +
      '<ellipse cx="160" cy="128" rx="81" ry="15" fill="#b37c6820"/>' +
      '<path d="M78 77 H242 V113 C242 139 78 139 78 113Z" fill="url(#bd-cream)"/>' +
      '<path d="M79 112 Q160 138 241 112" fill="none" stroke="#cba271" stroke-width="2"/>' +
      '<ellipse cx="160" cy="77" rx="82" ry="18" fill="url(#bd-icing)"/>' +
      '<path d="M78 77 Q84 91 99 91 Q100 101 106 101 Q113 101 113 93 Q147 99 180 96 Q181 108 188 107 Q195 106 195 94 Q232 90 242 77 Q160 104 78 77Z" fill="#fff8e9"/>' +
      '<path d="M160 120 C151 114 146 110 150 105 C154 101 158 105 160 107 C164 102 169 102 171 107 C173 112 165 117 160 120Z" fill="#b65f77" stroke="#f9e0c0" stroke-width="1.5"/>' +
      '<g fill="#c55877"><ellipse cx="68" cy="115" rx="11" ry="9" transform="rotate(-20 68 115)"/><ellipse cx="245" cy="115" rx="11" ry="9" transform="rotate(20 245 115)"/></g>' +
      '<g fill="#91af99"><path d="M68 109q-14-16-18-6q8 9 18 6M68 109q2-15 11-13q1 9-11 13M245 109q14-16 18-6q-8 9-18 6M245 109q-2-15-11-13q-1 9 11 13"/></g>' +
      '<g fill="#fff0d3"><circle cx="65" cy="114" r="1"/><circle cx="71" cy="118" r="1"/><circle cx="242" cy="113" r="1"/><circle cx="247" cy="118" r="1"/></g></svg>';
  }
  function boot() {
    const overlay = $('winnerOverlay'), card = overlay && overlay.querySelector('.winner-card');
    if (!card) return;
    const banner = document.createElement('p'); banner.className = 'bd-board-wish';
    banner.textContent = '献给 ' + person + ' · 愿今天的快乐，一直延续';
    document.querySelector('.game-topbar').after(banner);
    intro = document.createElement('dialog'); intro.className = 'bd-intro';
    intro.setAttribute('aria-labelledby', 'birthdayIntroTitle');
    intro.innerHTML = '<div class="bd-stage-light" aria-hidden="true"></div><div class="bd-curtain bd-curtain-left" aria-hidden="true"></div><div class="bd-curtain bd-curtain-right" aria-hidden="true"></div><div class="bd-valance" aria-hidden="true"></div>' +
      '<button type="button" class="bd-skip" id="birthdaySkipBtn">跳过开场</button><div class="bd-invitation">' +
      '<p class="bd-eyebrow">A LITTLE CELEBRATION, JUST FOR YOU</p><span class="bd-star" aria-hidden="true">✧</span>' +
      '<h1 id="birthdayIntroTitle"></h1><p class="bd-invitation-copy">帷幕之后，是一盘甜甜的祝福。</p>' +
      '<button type="button" class="bd-start" id="birthdayStartBtn">拉开帷幕 <span aria-hidden="true">↗</span></button>' +
      '<p class="bd-invitation-foot">愿你被爱包围，自由又闪亮。</p></div>';
    document.body.appendChild(intro); $('birthdayIntroTitle').textContent = person + '，生日快乐';
    $('birthdayStartBtn').addEventListener('click', openCurtains);
    $('birthdaySkipBtn').addEventListener('click', function () { finishOpening(true); });
    intro.addEventListener('cancel', function (event) { event.preventDefault(); finishOpening(true); });
    intro.querySelector('.bd-curtain-left').addEventListener('transitionend', function (event) {
      if (event.propertyName === 'transform' && intro.classList.contains('is-opening')) finishOpening(true);
    });

    const ceremony = document.createElement('section'); ceremony.className = 'bd-ceremony';
    ceremony.innerHTML = '<div class="bd-cake" role="img"><div class="bd-cake-halo" aria-hidden="true"></div>' + cakeArt() + '<div class="bd-candles">' +
      [35,43,47,41,34].map(function (height, i) { return '<span class="bd-candle" style="--i:' + i + ';--height:' + height + 'px"><i class="bd-wick"></i><i class="bd-candle-glow"></i><i class="bd-flame"></i><i class="bd-smoke"></i></span>'; }).join('') +
      '</div><div class="bd-wish-sparkles" aria-hidden="true">✧<span>✦</span>✧</div></div>' +
      '<p class="bd-candle-status" id="birthdayCandleStatus" role="status" aria-live="polite"></p>' +
      '<button type="button" class="bd-blow" id="birthdayBlowBtn">许好愿了，吹蜡烛</button>' +
      '<button type="button" class="bd-music" id="birthdayMusicBtn" aria-pressed="false" hidden>播放生日歌</button><p class="bd-result"></p>';
    card.insertBefore(ceremony, $('winnerNewBtn'));
    cake = ceremony.querySelector('.bd-cake'); result = ceremony.querySelector('.bd-result');
    blowButton = $('birthdayBlowBtn'); musicButton = $('birthdayMusicBtn'); status = $('birthdayCandleStatus');
    blowButton.addEventListener('click', blowCandles);
    musicButton.addEventListener('click', function () {
      if (playing) { stopMusic(); status.textContent = '音乐已停止，祝福还在。'; }
      else {
        if (typeof soundEnabled !== 'undefined' && !soundEnabled && typeof toggleSound === 'function') toggleSound();
        playMusic();
      }
    });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'bd-close';
    close.textContent = '×'; close.setAttribute('aria-label', '返回棋盘');
    close.addEventListener('click', function () { closeWinner(); $('newGameBtn').focus(); }); card.prepend(close);
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close.click(); return; }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(card.querySelectorAll('button')).filter(function (b) { return !b.hidden && !b.disabled; });
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    $('soundBtn').addEventListener('click', function () { if (typeof soundEnabled !== 'undefined' && !soundEnabled) stopMusic(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { stopMusic(); finishOpening(false); } });
    document.addEventListener('checkers:winner', function (event) { presentWinner(event.detail); });
    document.addEventListener('checkers:winner-close', dismissWinner);
    document.addEventListener('checkers:newgame', function () { showOpening(); });
    document.addEventListener('checkers:room-opening', function () {
      if (!document.hidden) showOpening({ automatic: true });
    });
    if (preference && preference.addEventListener) preference.addEventListener('change', function () {
      if (reduced()) { clearConfetti(); if (intro.classList.contains('is-opening')) finishOpening(true); if (blowing) finishBlowing(); }
    });
    window.addEventListener('beforeunload', function () {
      clearTimeout(openingTimer); clearTimeout(autoOpeningTimer); clearTimeout(blowTimer); stopMusic(); clearConfetti();
      if (audioContext) audioContext.close().catch(function () {});
    });
    if (overlay.classList.contains('active')) presentWinner();
    else if (window.__checkersTest.mode !== 'online') showOpening();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
