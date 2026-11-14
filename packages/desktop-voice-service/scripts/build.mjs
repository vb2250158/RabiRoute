import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
const require=createRequire(import.meta.url);
const {build}=require(process.env.VOICE_ESBUILD_PATH||'esbuild');
await build({entryPoints:['runtime/renderer.mjs'],bundle:true,outfile:'runtime/renderer.js',platform:'browser',format:'iife',target:'chrome120'});
const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0};
const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum])};
const pixels=Buffer.alloc(32*(1+32*4));
for(let y=0;y<32;y++)for(let x=0;x<32;x++){
  const mic=(x>=13&&x<=18&&y>=6&&y<=18)||((x===9||x===22)&&y>=14&&y<=20)||(y===23&&x>=12&&x<=19)||(x>=15&&x<=16&&y>=23&&y<=27)||(y===27&&x>=11&&x<=20);
  const at=y*129+1+x*4;pixels.set(mic?[80,230,197,255]:[16,29,48,255],at);
}
const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=6;
writeFileSync('runtime/voice.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
