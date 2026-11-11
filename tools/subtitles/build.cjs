// Build once on a connected machine; playback uses only the generated local files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const target = outputIndex < 0 ? path.join(root, 'static/vendor/jassub')
  : path.resolve(args[outputIndex + 1] || (() => { throw Error('--output requires a directory'); })());
if (args.some((arg, i) => arg !== '--check' && arg !== '--output' && !(outputIndex >= 0 && i === outputIndex + 1))) {
  throw Error('Usage: node build.cjs [--check] [--output DIRECTORY]');
}
const assets = [
  'jassub.bundle.js', 'jassub-worker.bundle.js', 'default.woff2', 'noto-sans-sc-400.woff2',
  'wasm/jassub-worker.js', 'wasm/jassub-worker-modern.js',
  'wasm/jassub-worker.wasm', 'wasm/jassub-worker-modern.wasm',
];
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function check(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'assets-manifest.json'), 'utf8'));
  for (const name of [...assets, 'LICENSES.txt']) {
    const data = fs.readFileSync(path.join(directory, name));
    if (!data.length || manifest.files[name] !== digest(data)) throw Error(`Invalid subtitle asset: ${name}`);
  }
}

async function build() {
  if (args.includes('--check')) {
    check(target);
    console.log('Subtitle assets verified.');
    return;
  }
  const esbuild = require('esbuild');
  const modules = path.join(__dirname, 'node_modules');
  const jassub = path.join(modules, 'jassub');
  const font = path.join(modules, '@fontsource/noto-sans-sc');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.jassub-build-'));
  let backup;
  let installed = false;
  try {
    await esbuild.build({
      stdin: { contents: "import JASSUB from 'jassub'; window.JASSUB = JASSUB;", resolveDir: __dirname },
      bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
      outfile: path.join(stage, 'jassub.bundle.js'),
    });
    await esbuild.build({
      entryPoints: [path.join(jassub, 'dist/worker/worker.js')],
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
      outfile: path.join(stage, 'jassub-worker.bundle.js'),
    });
    fs.mkdirSync(path.join(stage, 'wasm'));
    for (const name of assets.filter(name => name.startsWith('wasm/'))) {
      fs.copyFileSync(path.join(jassub, 'dist', name), path.join(stage, name));
    }
    fs.copyFileSync(path.join(jassub, 'dist/default.woff2'), path.join(stage, 'default.woff2'));
    fs.copyFileSync(path.join(font, 'files/noto-sans-sc-chinese-simplified-400-normal.woff2'),
      path.join(stage, 'noto-sans-sc-400.woff2'));
    // Preserve upstream notices for the renderer, fonts and bundled JS dependencies.
    const packages = ['jassub', '@fontsource/noto-sans-sc', 'abslink', 'lfa-ponyfill', 'rvfc-polyfill', 'throughput'];
    const notices = packages.map(name => {
      const folder = path.join(modules, name);
      const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')));
      const licenses = fs.readdirSync(folder).filter(file => /^(licen[sc]e|copying)(\.|$)/i.test(file));
      return `${name}@${pkg.version}\nLicense: ${pkg.license}\nSource: ${JSON.stringify(pkg.repository)}\n\n` +
        (licenses.length ? licenses.map(file => fs.readFileSync(path.join(folder, file), 'utf8')).join('\n')
          : 'Upstream npm package contains no separate license file.\n' + fs.readFileSync(path.join(folder, 'README.md'), 'utf8'));
    });
    notices.unshift('JASSUB 2.5.35 includes libass and native dependencies. Source and native build instructions:\nhttps://registry.npmjs.org/jassub/-/jassub-2.5.35.tgz\nhttps://github.com/ThaUnknown/jassub\nKeep upstream license obligations when redistributing these generated assets.\n');
    fs.writeFileSync(path.join(stage, 'LICENSES.txt'), notices.join('\n\n----------------\n\n'));
    const files = Object.fromEntries([...assets, 'LICENSES.txt'].map(name =>
      [name, digest(fs.readFileSync(path.join(stage, name)))]));
    fs.writeFileSync(path.join(stage, 'assets-manifest.json'), JSON.stringify({
      versions: JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'))).dependencies, files,
    }, null, 2) + '\n');
    check(stage);
    // Build failure leaves existing assets intact. Rename only a complete verified set.
    if (fs.existsSync(target)) {
      backup = fs.mkdtempSync(path.join(path.dirname(target), '.jassub-backup-'));
      fs.renameSync(target, path.join(backup, 'previous'));
    }
    try { fs.renameSync(stage, target); }
    catch (error) {
      if (backup) fs.renameSync(path.join(backup, 'previous'), target);
      throw error;
    }
    installed = true;
    console.log(`Subtitle assets built and verified: ${target}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (backup && !fs.existsSync(path.join(backup, 'previous'))) fs.rmSync(backup, { recursive: true, force: true });
    else if (backup && installed) fs.rmSync(backup, { recursive: true, force: true });
  }
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
