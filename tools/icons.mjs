// מייצר את קבצי ה-PNG של האייקון מתוך icon.svg (npm run icons)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const dir = new URL('../', import.meta.url).pathname;
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [out, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-180.png', 180]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0;background:transparent">${readFileSync(dir + 'icon.svg', 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: dir + out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await b.close();
console.log('icons written');
