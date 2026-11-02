import puppeteer from 'puppeteer-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 400)); });
await page.goto('http://localhost:18090/dev.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-spw-shelf] [data-value]', { timeout: 15000 });
const read = () => page.evaluate(() => window.__SPW_SHELF_STATE__ ? window.__SPW_SHELF_STATE__() : null);
for (let i = 0; i < 45; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const s = await read();
  console.log(i + 's', JSON.stringify(s));
}
console.log('--- close/reopen cycle ---');
await page.evaluate(() => document.querySelector('[data-spw-settings-ui] [aria-label="返回"]')?.click());
await new Promise(r => setTimeout(r, 1500));
console.log('closed', JSON.stringify(await read()));
await page.evaluate(() => document.querySelector('[data-spw-chrome="settings"]')?.click());
await new Promise(r => setTimeout(r, 2000));
console.log('reopened', JSON.stringify(await read()));
await new Promise(r => setTimeout(r, 6000));
console.log('after reopen settle', JSON.stringify(await read()));
console.log('--- errors ---');
for (const e of errors) console.log(e);
await browser.close();
