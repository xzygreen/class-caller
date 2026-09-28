'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file));
const icon = read('public/favicon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const images = sizes.map((size, i) => {
  const entry = 6 + i * 16;
  const offset = icon.readUInt32LE(entry + 12);
  const length = icon.readUInt32LE(entry + 8);
  return { size, entry, offset, length, data: icon.subarray(offset, offset + length) };
});

test('Caller 图标保留本地 SVG 源文件和 180px 手机书签 PNG', () => {
  const svg = read('public/favicon.svg').toString();
  assert.match(svg, /viewBox="0 0 128 128"/);
  assert.match(svg, /<title>Caller<\/title>/);
  assert.match(svg, /#0E1420/);
  assert.match(svg, /#F0B429/);
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|\bhref=/i);
  const png = read('public/apple-touch-icon.png');
  assert.deepEqual(png.subarray(0, 8), pngSignature);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
});

test('ICO 包含 16–256px 七种尺寸、32 位透明小图及 Windows 7 支持的 PNG 大图', () => {
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), sizes.length);
  let end = 6 + 16 * sizes.length;
  for (const { size, entry, offset, length, data } of images) {
    assert.equal(icon[entry] || 256, size);
    assert.equal(icon[entry + 1] || 256, size);
    assert.equal(icon.readUInt16LE(entry + 4), 1);
    assert.equal(icon.readUInt16LE(entry + 6), 32);
    assert.equal(offset, end, `${size}px 图像不可缺失或重叠`);
    assert.equal(data.length, length);
    end += length;
    if (size >= 128) {
      assert.deepEqual(data.subarray(0, 8), pngSignature);
      assert.equal(data.readUInt32BE(16), size);
      assert.equal(data.readUInt32BE(20), size);
      continue;
    }
    const maskStride = Math.ceil(size / 32) * 4;
    assert.equal(data.readUInt32LE(0), 40);
    assert.equal(data.readInt32LE(4), size);
    assert.equal(data.readInt32LE(8), size * 2);
    assert.equal(data.readUInt16LE(12), 1);
    assert.equal(data.readUInt16LE(14), 32);
    assert.equal(data.readUInt32LE(16), 0);
    assert.equal(data.length, 40 + size * size * 4 + maskStride * size);
    assert.equal(data[43], 0, '圆角外保持透明');
    assert.equal(data[40 + ((size >> 1) * size + (size >> 1)) * 4 + 3], 255, '图案中心不能透明');
    assert.ok(data[40 + size * size * 4] & 0x80, 'AND mask 必须标记透明角');
    let ivory = 0, gold = 0;
    for (let p = 40; p < 40 + size * size * 4; p += 4) {
      if (data[p + 3] < 240) continue;
      if (data[p] > 200 && data[p + 1] > 220 && data[p + 2] > 220) ivory++;
      if (data[p] < 150 && data[p + 1] > 150 && data[p + 2] > 220) gold++;
    }
    assert.ok(ivory >= size && gold >= size / 3, `${size}px 仍须保留浅色 C 和金色呼叫信号`);
  }
  assert.equal(end, icon.length);
  assert.ok(icon.length < 128 * 1024, '大尺寸使用 PNG，避免 favicon 和 EXE 资源膨胀');
});

test('两个 Windows 程序的所有构建入口均嵌入同一份 ICO', () => {
  for (const [dir, rc, stem] of [
    ['windows-display', 'display', 'display'],
    ['windows-launcher', 'win7-launcher', 'launcher'],
  ]) {
    const resource = read(`${dir}/src/${rc}.rc`).toString();
    assert.match(resource, /ICON "\.\.\/\.\.\/public\/favicon\.ico"/);
    const shell = read(`${dir}/build-mingw-x86.sh`).toString();
    const cmd = read(`${dir}/build-mingw-x86.cmd`).toString();
    const msvc = read(`${dir}/build-msvc-x86.cmd`).toString();
    for (const script of [shell, cmd]) {
      assert.ok(script.includes(`--input ${rc}.rc`));
      assert.ok(script.includes('--target pe-i386'));
      assert.ok(script.includes(`${stem}-res.o`));
      assert.ok(script.includes('windres'));
    }
    assert.ok(shell.includes('cd "$ROOT/src"'), '资源路径按 src 目录解析，支持含空格的项目路径');
    assert.ok(cmd.includes('pushd src'));
    assert.ok(msvc.includes('pushd src'));
    assert.ok(msvc.includes(`rc.exe /nologo /fo ..\\build\\${stem}.res ${rc}.rc`));
    assert.ok(msvc.includes(`src\\${rc}.c build\\${stem}.res`));
  }
  const source = read('windows-display/src/display.c').toString();
  assert.match(source, /#include "resource\.h"/);
  assert.match(read('windows-display/src/resource.h').toString(), /#define IDI_CALLER 101/);
  assert.doesNotMatch(source, /IDI_APPLICATION/);
  assert.match(source, /wc\.hIcon = \(HICON\)LoadImageW\(instance, MAKEINTRESOURCEW\(IDI_CALLER\)/);
  assert.match(source, /wc\.hIconSm = \(HICON\)LoadImageW\(instance, MAKEINTRESOURCEW\(IDI_CALLER\)/);
});

/** 解析 PE 的资源目录，不靠在二进制中搜索字符串来猜图标是否成功链接。 */
function resources(binary) {
  const pe = binary.readUInt32LE(0x3c);
  const optional = pe + 24;
  assert.equal(binary.readUInt16LE(optional), 0x10b, 'PE32');
  const sectionTable = optional + binary.readUInt16LE(pe + 20);
  const sections = Array.from({ length: binary.readUInt16LE(pe + 6) }, (_, i) => {
    const s = sectionTable + i * 40;
    return { rva: binary.readUInt32LE(s + 12), size: binary.readUInt32LE(s + 16), offset: binary.readUInt32LE(s + 20) };
  });
  const locate = (rva) => {
    const section = sections.find((s) => rva >= s.rva && rva < s.rva + s.size);
    assert.ok(section, `资源 RVA ${rva.toString(16)} 必须位于文件内`);
    return section.offset + rva - section.rva;
  };
  const base = locate(binary.readUInt32LE(optional + 96 + 2 * 8));
  const directory = (offset) => {
    const at = base + offset;
    const count = binary.readUInt16LE(at + 12) + binary.readUInt16LE(at + 14);
    return Array.from({ length: count }, (_, i) => {
      const entry = at + 16 + i * 8;
      const target = binary.readUInt32LE(entry + 4);
      return { id: binary.readUInt32LE(entry), directory: !!(target & 0x80000000), offset: target & 0x7fffffff };
    });
  };
  const type = (id) => {
    const entry = directory(0).find((e) => e.id === id);
    assert.ok(entry && entry.directory, `缺少 RT_${id} 资源`);
    return directory(entry.offset);
  };
  const data = (entry) => {
    assert.ok(entry.directory);
    const leaf = directory(entry.offset)[0];
    assert.ok(leaf && !leaf.directory);
    const at = base + leaf.offset;
    const offset = locate(binary.readUInt32LE(at));
    const size = binary.readUInt32LE(at + 4);
    return binary.subarray(offset, offset + size);
  };
  return { type, data };
}

for (const [dir, exe] of [['windows-display', 'display.exe'], ['windows-launcher', 'win7-launcher.exe']]) {
  const file = path.join(root, dir, 'build', exe);
  test(`${exe} 编译产物的图标组包含全部七种尺寸且像素与网站图标一致`, { skip: !fs.existsSync(file) }, () => {
    const res = resources(fs.readFileSync(file));
    const group = res.type(14).find((e) => e.id === 101);
    assert.ok(group, '图标组 ID 必须与 LoadImage/资源定义一致');
    const data = res.data(group);
    assert.equal(data.readUInt16LE(2), 1);
    assert.equal(data.readUInt16LE(4), sizes.length);
    const icons = res.type(3);
    for (const [i, image] of images.entries()) {
      const entry = 6 + 14 * i;
      assert.equal(data[entry] || 256, image.size);
      assert.equal(data[entry + 1] || 256, image.size);
      assert.equal(data.readUInt32LE(entry + 8), image.length);
      const id = data.readUInt16LE(entry + 12);
      const iconResource = icons.find((e) => e.id === id);
      assert.ok(iconResource, `缺少 ${image.size}px 图标资源`);
      assert.deepEqual(res.data(iconResource), image.data);
    }
  });
}
