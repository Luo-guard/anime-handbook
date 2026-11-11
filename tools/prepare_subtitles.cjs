// Cross-platform entry point. npm ci verifies package-lock tarball integrity.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = path.join(__dirname, 'subtitles');
function run(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, { cwd, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!args.includes('--check')) {
  // cmd.exe is needed for npm.cmd on Windows; no user input is passed to the shell.
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund']);
  else run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}
run(process.execPath, [path.join(cwd, 'build.cjs'), ...args]);
