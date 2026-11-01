import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=path.join(root,'.release-stage','science-arena');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='.git'||e.isSymbolicLink()?[]:e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const locals=[],central=[];let offset=0;
const manifest=JSON.parse(fs.readFileSync(path.join(stage,'release-manifest.json'),'utf8'));
const allowed=new Set([...manifest.files.map(item=>item.path),'README.md','release-manifest.json']);
for(const full of walk(stage)) {
  const relative=path.relative(stage,full).split(path.sep).join('/');
  if(!allowed.has(relative)) continue;
  const name=Buffer.from('science-arena/'+relative),raw=fs.readFileSync(full),compressed=deflateRawSync(raw),crc=crc32(raw);
  const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(8,8);head.writeUInt16LE(33,12);head.writeUInt32LE(crc,14);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(raw.length,22);head.writeUInt16LE(name.length,26);
  locals.push(head,name,compressed);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(raw.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=head.length+name.length+compressed.length;
}
const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
const out=path.join(root,'release');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'Science-Arena-0.2.0-source-and-web-deploy.zip'),Buffer.concat([...locals,cd,end]));
const artifacts=fs.readdirSync(out).filter(name=>/^Science-Arena-.*\.(?:exe|zip|dmg)$/.test(name));
const sums=artifacts.map(name=>createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex')+'  '+name).join('\n')+'\n';
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),sums);
console.log(`Source/deployment ZIP created; checksums for ${artifacts.length} artifacts.`);
