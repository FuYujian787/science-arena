import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=path.join(root,'.release-stage','science-arena');
const directories=['src','public','prompts','desktop','build','.github','site','dify'];
const files=['server.mjs','cli.mjs','package.json','package-lock.json','.gitignore','.env.example','Dockerfile','.dockerignore',
  'deploy/compose.public.yml','deploy/Caddyfile.public','deploy/public.env.example',
  'tools/test.mjs','tools/test-http-e2e.mjs','tools/test-dify-e2e.mjs','tools/test-distribution.mjs','tools/mock-dify.mjs','tools/generate-icons.mjs','tools/prepare-release.mjs','tools/start-personal.mjs','tools/build-desktop.mjs',
  'README.distribution.md','docs/跨平台发布方案.md','docs/跨平台发布状态.md'];
const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]);
for(const dir of directories) files.push(...walk(dir));
// Never reveal secrets in diagnostics: compare only in memory against local environment values.
const env=fs.existsSync(path.join(root,'.env'))?fs.readFileSync(path.join(root,'.env'),'utf8'):'';
const secrets=env.split(/\r?\n/).filter(line=>/^\s*(?:DEEPSEEK_API_KEY|DIFY_APP_KEY)\s*=/.test(line)).map(line=>line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'')).filter(value=>value.length>12);
const manifest=[];
for(const relative of [...new Set(files)]) {
  const source=path.join(root,relative);
  if(!fs.existsSync(source)) throw new Error(`Missing release input: ${relative}`);
  const bytes=fs.readFileSync(source);
  if(secrets.some(secret=>bytes.includes(secret))) throw new Error(`Secret detected in release input: ${relative}`);
  manifest.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
// Delete only our explicitly resolved staging directory; never the source workspace.
if(path.dirname(stage)!==path.join(root,'.release-stage')||path.basename(stage)!=='science-arena') throw new Error('Invalid staging target');
fs.mkdirSync(stage,{recursive:true});
const previousManifest=path.join(stage,'release-manifest.json');
if(fs.existsSync(previousManifest)) {
  const old=JSON.parse(fs.readFileSync(previousManifest,'utf8'));
  const allowed=new Set(manifest.map(item=>item.path));
  for(const item of old.files || []) {
    const stale=path.resolve(stage,item.path);
    if(!stale.startsWith(stage+path.sep)) throw new Error('Invalid prior manifest path');
    if(!allowed.has(item.path)) fs.rmSync(stale,{force:true});
  }
}
for(const item of manifest) { const target=path.join(stage,item.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,item.path),target); }
fs.copyFileSync(path.join(root,'README.distribution.md'),path.join(stage,'README.md'));
fs.writeFileSync(path.join(stage,'release-manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),files:manifest},null,2));
console.log(`Release source prepared: ${stage}\n${manifest.length} allowlisted files; no local credentials or research histories copied.`);
