'use strict';

// Local backport of microsoft/vscode#323980 and ProxyChannel's selective
// buffering option. Only the exact inspected VS Code 1.108.0 bundle is supported.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ORIGINAL_SHA256 = '2efe54d9fba3bbb597770f50cb94bc1d7cec1e7f9067de4befabb011ed473907';
const BUILD = '1.108.0-94e8ae2b28cb5cc932b86e1070569c4463565c37';
const PROCESS_EVENTS = [
  'onProcessData', 'onProcessReady', 'onProcessExit', 'onProcessReplay',
  'onDidChangeProperty', 'onProcessOrphanQuestion', 'onDidRequestDetach'
];
const REPLACEMENTS = [
  [
    'function e(n,o,a){const c=n,l=a?.disableMarshalling,h=new Map;for(const d in c)s(d)&&h.set(d,x.buffer(c[d],!0,void 0,o));',
    'function e(n,o,a){const c=n,l=a?.disableMarshalling,u=a?.unbufferedEvents?new Set(a.unbufferedEvents):void 0,h=new Map;for(const d in c)s(d)&&!u?.has(d)&&h.set(d,x.buffer(c[d],!0,void 0,o));'
  ],
  [
    'if(s(f))return h.set(f,x.buffer(c[f],!0,void 0,o)),h.get(f)',
    'if(s(f))return u?.has(f)?c[f]:(h.set(f,x.buffer(c[f],!0,void 0,o)),h.get(f))'
  ],
  [
    'const I=Ge.fromService(e.get(im),r);i.registerChannel(_o.LocalPty,I);',
    `const I=Ge.fromService(e.get(im),r,{unbufferedEvents:${JSON.stringify(PROCESS_EVENTS)}});i.registerChannel(_o.LocalPty,I);`
  ]
];

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function replaceExactlyOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error('Unsupported or partially patched VS Code bundle; no files were changed.');
  }
  return source.replace(before, after);
}

function patch(source) {
  if (sha256(source) !== ORIGINAL_SHA256) {
    throw new Error('Bundle hash differs from the inspected VS Code build; no files were changed.');
  }
  return REPLACEMENTS.reduce((text, [before, after]) => replaceExactlyOnce(text, before, after), source);
}

function originalFromPatched(source) {
  const restored = [...REPLACEMENTS].reverse().reduce(
    (text, [before, after]) => replaceExactlyOnce(text, after, before), source
  );
  if (sha256(restored) !== ORIGINAL_SHA256) {
    throw new Error('Patched bundle contains unexpected changes; refusing to overwrite it.');
  }
  return restored;
}

function validateSyntax(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source, encoding: 'utf8', windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Patched JavaScript failed syntax validation: ${result.error || result.stderr}`);
  }
}

function run(mode, appDir, backupDir) {
  if (!['--check', '--install', '--remove'].includes(mode)) {
    throw new Error('Usage: node scripts/fix-vscode-terminal-memory.cjs --check|--install|--remove');
  }
  const mainPath = path.join(appDir, 'out', 'main.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const product = JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8'));
  if (`${manifest.version}-${product.commit}` !== BUILD) {
    throw new Error('This backport only supports the inspected 1.108.0 build. Check newer builds for the upstream fix.');
  }
  const current = fs.readFileSync(mainPath, 'utf8');
  const installed = sha256(current) !== ORIGINAL_SHA256;
  const original = installed ? originalFromPatched(current) : current;
  const patched = patch(original);
  validateSyntax(patched);
  if (mode === '--check') {
    return { installed, mainPath, originalSha256: ORIGINAL_SHA256, patchedSha256: sha256(patched) };
  }
  const backupPath = path.join(backupDir, 'main.js.original');
  if (fs.existsSync(backupPath) && sha256(fs.readFileSync(backupPath)) !== ORIGINAL_SHA256) {
    throw new Error('Backup does not match this build; refusing to overwrite it.');
  }
  if (mode === '--install') {
    fs.mkdirSync(backupDir, { recursive: true });
    if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original, { flag: 'wx' });
  }
  if ((mode === '--install') !== installed) {
    // Atomic replacement: a failed write cannot leave a truncated application.
    const temporary = `${mainPath}.agent-attention-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, mode === '--install' ? patched : original, { flag: 'wx' });
      fs.renameSync(temporary, mainPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { installed: mode === '--install', mainPath, backupPath, restartRequired: true };
}

if (require.main === module) {
  try {
    const appDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app');
    const backupDir = path.join(os.homedir(), '.agent-attention', 'backups', 'vscode-main', BUILD);
    console.log(JSON.stringify(run(process.argv[2] || '--check', appDir, backupDir), null, 2));
    if (process.argv[2] === '--install' || process.argv[2] === '--remove') {
      console.log('Fully exit and reopen VS Code when ready. Reload Window does not restart the main process.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { patch, originalFromPatched, run, validateSyntax, sha256, ORIGINAL_SHA256, PROCESS_EVENTS, REPLACEMENTS, BUILD };
