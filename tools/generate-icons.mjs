import fs from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
function chunk(type, bytes) {
  const label = Buffer.from(type), out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length); label.copy(out, 4); bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([label, bytes])), out.length - 4); return out;
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size - .5, ny = y / size - .5;
    const radius = Math.hypot(nx, ny);
    const angle = Math.atan2(ny, nx);
    const hex = .285 / Math.cos(((angle + Math.PI * 4) % (Math.PI / 3)) - Math.PI / 6);
    const white = Math.abs(radius - hex) < .012 || radius < .047;
    const t = (x + y) / (size * 2);
    const i = y * (size * 4 + 1) + 1 + x * 4;
    raw[i] = white ? 255 : Math.round(35 + t * 115);
    raw[i+1] = white ? 255 : Math.round(80 - t * 40);
    raw[i+2] = white ? 255 : Math.round(205 - t * 65);
    raw[i+3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
fs.mkdirSync('public/icons', { recursive: true }); fs.mkdirSync('build', { recursive: true });
for (const size of [192,512]) fs.writeFileSync(`public/icons/icon-${size}.png`,icon(size));
fs.writeFileSync('build/icon.png',icon(512));
const png = icon(256), head = Buffer.alloc(22); head.writeUInt16LE(1,2); head.writeUInt16LE(1,4); head[6]=0;head[7]=0;head.writeUInt16LE(1,10);head.writeUInt16LE(32,12);head.writeUInt32LE(png.length,14);head.writeUInt32LE(22,18);
fs.writeFileSync('build/icon.ico', Buffer.concat([head,png]));
console.log('Generated app/PWA icons.');
