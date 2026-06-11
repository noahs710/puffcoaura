const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGE ERROR: ' + err.message));

  // === MOBILE TEST (375x812) ===
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('http://127.0.0.1:8420/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);

  const checks = await page.evaluate(() => {
    const swiperDefined = typeof Swiper !== 'undefined';
    const views = document.getElementById('app-views');
    const tabBar = document.getElementById('app-tab-bar');
    const mobileViewConnect = document.getElementById('mobile-view-connect');
    const mobileHeader = document.querySelector('.mobile-swipe-header');
    const desktopContainer = document.querySelector('.app-container');
    const connectCard = document.getElementById('connect-card');

    return {
      swiperDefined,
      swiperInitialized: !!(views && views.swiper),
      appViewsDisplay: views ? window.getComputedStyle(views).display : 'not-found',
      tabBarDisplay: tabBar ? window.getComputedStyle(tabBar).display : 'not-found',
      mobileViewConnectPresent: !!mobileViewConnect,
      mobileViewConnectHasChildren: mobileViewConnect ? mobileViewConnect.children.length : 0,
      mobileHeaderPresent: !!mobileHeader,
      desktopContainerHidden: desktopContainer ? window.getComputedStyle(desktopContainer).display : 'not-found',
      connectCardPresent: !!connectCard,
      connectCardInMobileView: connectCard && mobileViewConnect ? mobileViewConnect.contains(connectCard) : false,
    };
  });

  console.log('=== Mobile Smoke Test (375x812) ===');
  for (const [k, v] of Object.entries(checks)) {
    const pass = v === true || (typeof v === 'number' && v > 0) || v === 'flex';
    console.log((pass ? 'PASS' : 'INFO') + ' ' + k + ': ' + JSON.stringify(v));
  }

  // === DESKTOP TEST (1200x800) ===
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(500);

  const desktopChecks = await page.evaluate(() => {
    const views = document.getElementById('app-views');
    const tabBar = document.getElementById('app-tab-bar');
    const desktopContainer = document.querySelector('.app-container');
    const connectCard = document.getElementById('connect-card');
    return {
      appViewsHidden: views ? window.getComputedStyle(views).display : 'not-found',
      tabBarHidden: tabBar ? window.getComputedStyle(tabBar).display : 'not-found',
      desktopContainerVisible: desktopContainer ? window.getComputedStyle(desktopContainer).display : 'not-found',
      connectCardInDesktopContainer: connectCard && desktopContainer ? desktopContainer.contains(connectCard) : false,
    };
  });

  console.log('\n=== Desktop Smoke Test (1200x800) ===');
  for (const [k, v] of Object.entries(desktopChecks)) {
    console.log('INFO ' + k + ': ' + JSON.stringify(v));
  }

  console.log('\n=== Console Errors ===');
  console.log(errors.length === 0 ? 'NONE' : errors.slice(0, 5).join('\n'));

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
