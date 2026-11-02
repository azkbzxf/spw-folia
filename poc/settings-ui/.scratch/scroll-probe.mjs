import puppeteer from 'puppeteer-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 848, height: 515 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:18090/dev.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-spw-shelf] [data-value]', { timeout: 20000 });
const read = () => page.evaluate(() => window.__SPW_SHELF_STATE__());
const tiles = () => page.evaluate(() => [...document.querySelectorAll('[data-spw-shelf] [data-value]')].map(t => {
  const stage = t.querySelector('span')?.querySelector('[data-picture]');
  return { value: t.dataset.value, kind: stage ? stage.getAttribute('data-picture') : 'glyph' };
}));
const gridInfo = () => page.evaluate(() => { const g = document.querySelector('[data-spw-shelf] [role="radiogroup"]'); return { scrollHeight: g.scrollHeight, clientHeight: g.clientHeight, scrollTop: g.scrollTop }; });
// settle
for (let i = 0; i < 40; i++) { const s = await read(); if (s.images >= 17) break; await new Promise(r => setTimeout(r, 700)); }
console.log('settled', JSON.stringify(await read()));
console.log('grid', JSON.stringify(await gridInfo()));
console.log('tiles-before', JSON.stringify(await tiles()));
// scroll to bottom, wait for newly visible tiles to make images
// step through the grid the way a person scrolls, letting each row become visible
for (let step = 0; step < 8; step++) {
  await page.evaluate(() => { const g = document.querySelector('[data-spw-shelf] [role="radiogroup"]'); g.scrollTop = g.scrollTop + g.clientHeight * 0.6; });
  for (let i = 0; i < 12; i++) { const s = await read(); if (s.making === 0 && s.images >= 17) break; await new Promise(r => setTimeout(r, 600)); }
}
for (let i = 0; i < 20; i++) { const s = await read(); if (s.images >= 17 && s.making === 0) break; await new Promise(r => setTimeout(r, 700)); }
console.log('after-scroll', JSON.stringify(await read()));
console.log('tiles-after', JSON.stringify(await tiles()));
console.log('errors', JSON.stringify(errors));
await browser.close();
