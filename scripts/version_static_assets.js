'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '..', 'public');

function walkHtml(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(target, out);
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(target);
  });
  return out;
}

function assetHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function versionHtml(file) {
  const dir = path.dirname(file);
  const source = fs.readFileSync(file, 'utf8');
  const updated = source.replace(/((?:src|href)=["'])([^"'?#]+\.(?:js|css))(?:\?v=[^"']*)?(["'])/g,
    function (match, prefix, assetUrl, suffix) {
      if (/^(?:https?:|\/\/|data:)/.test(assetUrl)) return match;
      const assetPath = path.resolve(dir, assetUrl);
      if (!assetPath.startsWith(publicDir + path.sep) || !fs.existsSync(assetPath)) return match;
      return prefix + assetUrl + '?v=' + assetHash(assetPath) + suffix;
    });
  if (updated !== source) fs.writeFileSync(file, updated);
}

walkHtml(publicDir, []).forEach(versionHtml);
console.log('[assets] refreshed content-hash versions');
