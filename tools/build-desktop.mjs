import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tempBase=process.env.ARENA_BUILD_DIR || os.tmpdir();
// NSIS launches an intermediate uninstaller; some Windows setups reject Unicode output paths.
if(process.platform==='win32' && /[^\x00-\x7F]/.test(tempBase)) throw new Error('Set ARENA_BUILD_DIR to a writable ASCII path before building Windows installers.');
fs.mkdirSync(tempBase,{recursive:true});
const output=fs.mkdtempSync(path.join(tempBase,'science-arena-build-'));
const cli=path.join(path.dirname(require.resolve('electron-builder/package.json')),'out','cli','cli.js');
const result=spawnSync(process.execPath,[cli,'--win','nsis','zip','--x64','--publish','never',`--config.directories.output=${output}`],{cwd:root,stdio:'inherit',env:process.env});
if(result.status!==0) {console.error(`Build failed; diagnostics retained at ${output}`);process.exit(result.status||1);}
const release=path.join(root,'release');fs.mkdirSync(release,{recursive:true});
const artifacts=fs.readdirSync(output).filter(name=>/^Science-Arena-.*\.(exe|zip|blockmap)$/.test(name));
if(!artifacts.length) throw new Error('No installer artifacts generated');
for(const name of artifacts) fs.copyFileSync(path.join(output,name),path.join(release,name));
fs.writeFileSync(path.join(release,'windows-build.json'),JSON.stringify({builtAt:new Date().toISOString(),output,artifacts},null,2));
console.log(`Windows artifacts copied to ${release}`);
