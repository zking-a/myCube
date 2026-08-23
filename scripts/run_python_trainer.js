'use strict';

/**
 * Cross-platform launcher for the optional Python numerical backend.
 * Priority: PYTHON_BIN -> python -> python3 -> Windows py -> Codex bundled Python.
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forwarded = process.argv.slice(2);
const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const candidates = [];
if (process.env.PYTHON_BIN) candidates.push({ command: process.env.PYTHON_BIN, prefix: [] });
candidates.push({ command: 'python', prefix: [] }, { command: 'python3', prefix: [] });
if (process.platform === 'win32') candidates.push({ command: 'py', prefix: ['-3'] });
if (fs.existsSync(bundled)) candidates.push({ command: bundled, prefix: [] });

for (const candidate of candidates) {
  const probe = childProcess.spawnSync(candidate.command, candidate.prefix.concat(['--version']), { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) {
    const script = path.join(__dirname, 'train_policy_value_numpy.py');
    const result = childProcess.spawnSync(candidate.command, candidate.prefix.concat([script], forwarded), { stdio: 'inherit' });
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
}

console.error('未找到 Python 3。请安装 Python + NumPy，或通过 PYTHON_BIN 指定解释器。');
process.exit(1);
