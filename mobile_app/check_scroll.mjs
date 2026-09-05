import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));

  await page.goto('http://localhost:5173/login');
  await page.evaluate((t) => localStorage.setItem('obd_token', t), process.env.TOKEN);
  await page.goto('http://localhost:5173/dashboard');
  await page.waitForTimeout(2000);

  // Click a MiniGraph tile to open the graph detail modal (RPM graph)
  const rpmGraph = page.getByText('ОБЕРТИ', { exact: false }).first();
  await rpmGraph.click({ timeout: 5000 }).catch(() => console.log('could not click RPM graph tile'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'shots/graph_modal.png' });

  // Check: does the modal's content div have overflow-y set and no visible scrollbar width?
  const info = await page.evaluate(() => {
    const modal = document.querySelector('.overflow-y-auto.overscroll-contain');
    if (!modal) return { found: false };
    const cs = getComputedStyle(modal);
    return {
      found: true,
      overflowY: cs.overflowY,
      overscrollBehaviorY: cs.overscrollBehaviorY || cs.overscrollBehavior,
      scrollHeight: modal.scrollHeight,
      clientHeight: modal.clientHeight,
      scrollbarWidth: cs.scrollbarWidth,
    };
  });
  console.log('MODAL_SCROLL_INFO:', JSON.stringify(info));

  // Check global scrollbar-hiding is active on #root
  const rootInfo = await page.evaluate(() => {
    const el = document.getElementById('root');
    const cs = getComputedStyle(el);
    return { scrollbarWidth: cs.scrollbarWidth };
  });
  console.log('ROOT_SCROLL_INFO:', JSON.stringify(rootInfo));

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
}
main().catch(e => { console.error('DRIVER ERROR:', e.message); process.exit(1); });
