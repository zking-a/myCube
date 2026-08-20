'use strict';

// 兼容拆分前发出的根路径邀请链接：/#r=ABCDE 或 /?r=ABCDE。
(function redirectLegacyInvite() {
  var invite = /[?&#]r=([A-Za-z0-9]{1,8})/.exec(location.search + location.hash);
  if (!invite) return;
  var target = new URL('24/', location.href);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
})();
