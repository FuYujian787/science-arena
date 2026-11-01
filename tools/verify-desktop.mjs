import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const record=JSON.parse(fs.readFileSync(path.join(root,'release','windows-build.json'),'utf8'));
const unpacked=path.join(record.output,'win-unpacked');
const archive=path.join(unpacked,'resources','app.asar');
const files=listPackage(archive).map(name=>name.replace(/^[\\/]/,''));
const banned=files.filter(name=> /(^|[\\/])(?:\.env|data|node_modules)(?:[\\/.]|$)/.test(name));
if(banned.length) throw new Error('Unexpected private/dependency files in desktop archive');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const changed=[];
for(const name of files) {
  const source=path.join(root,name);
  if(name==='package.json'||!fs.existsSync(source)||!fs.statSync(source).isFile()) continue;
  if(hash(fs.readFileSync(source))!==hash(extractFile(archive,name))) changed.push(name);
}
if(changed.length) throw new Error(`Desktop archive is stale: ${changed.join(', ')}`);
console.log('DESKTOP_ARCHIVE_OK: packaged sources match workspace; no local env or histories');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-desktop-check-'));
try {
  const result=spawnSync(path.join(unpacked,'Science Arena.exe'),[],{
    cwd:os.tmpdir(),encoding:'utf8',timeout:30000,
    env:{...process.env,ARENA_DESKTOP_SMOKE:'1',ARENA_DESKTOP_TEST_DIR:dir},
  });
  if(result.status!==0||!result.stdout?.includes('DESKTOP_SMOKE_OK')) throw new Error(`Desktop smoke failed: ${result.status}; ${result.error?.message||result.stderr||''}`);
  console.log(result.stdout.trim());
  fs.writeFileSync(path.join(root,'release','desktop-verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),archiveSourcesMatch:true,windowLoaded:true,backendReady:true,encryptedSettingsRoundtrip:true},null,2));
} finally {
  if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('arena-desktop-check-')) throw new Error('Invalid verification directory');
  fs.rmSync(dir,{recursive:true,force:true});
}
