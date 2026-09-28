'use strict';

/**
 * 从 favicon.svg 生成网页与 Windows 共用图标；仅维护图标时需要本地 Chromium。
 * npm install --prefix /tmp/caller-icon-tools puppeteer-core
 * NODE_PATH=/tmp/caller-icon-tools/node_modules CHROME_BIN=/path/to/chrome node scripts/build-icons.js
 * 应用运行、npm test、EXE 构建直接使用已提交的图标，不依赖 Puppeteer。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function bitmap(size, rgba) {
  const maskStride = Math.ceil(size / 32) * 4;
  const pixels = size * size * 4;
  const data = Buffer.alloc(40 + pixels + maskStride * size);
  data.writeUInt32LE(40, 0);
  data.writeInt32LE(size, 4);
  data.writeInt32LE(size * 2, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(32, 14);
  data.writeUInt32LE(pixels + maskStride * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const row = size - 1 - y;
      const dst = 40 + (row * size + x) * 4;
      data[dst] = rgba[src + 2];
      data[dst + 1] = rgba[src + 1];
      data[dst + 2] = rgba[src];
      data[dst + 3] = rgba[src + 3];
      if (rgba[src + 3] === 0) data[40 + pixels + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return data;
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + i * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function main() {
  if (!process.env.CHROME_BIN) throw new Error('Set CHROME_BIN to a local Chromium/Chrome executable.');
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true });
  try {
    const page = await browser.newPage();
    const svg = fs.readFileSync(path.join(root, 'favicon.svg'), 'utf8');
    const images = [];
    for (const size of [...sizes, 180]) {
      const raster = await page.evaluate(async ({ svg, size }) => {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        // iOS supplies its own rounded mask; avoid transparent black corners on the home screen.
        if (size === 180) { ctx.fillStyle = '#0E1420'; ctx.fillRect(0, 0, size, size); }
        ctx.drawImage(image, 0, 0, size, size);
        return { rgba: Array.from(ctx.getImageData(0, 0, size, size).data), png: canvas.toDataURL('image/png').split(',')[1] };
      }, { svg, size });
      if (size === 180) fs.writeFileSync(path.join(root, 'apple-touch-icon.png'), Buffer.from(raster.png, 'base64'));
      else images.push({ size, data: size >= 128 ? Buffer.from(raster.png, 'base64') : bitmap(size, raster.rgba) });
    }
    fs.writeFileSync(path.join(root, 'favicon.ico'), ico(images));
    console.log('Generated favicon.ico (16–256px) and apple-touch-icon.png (180px).');
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
