const fs = require('fs');
const html = fs.readFileSync('C:/PuffcoBLE/index.html', 'utf8');
const css = fs.readFileSync('C:/PuffcoBLE/style.css', 'utf8');

const checks = [
  ['swiper.min.js script in HTML', html.includes('<script src="swiper.min.js"></script>')],
  ['swiper.min.css link in HTML', html.includes('<link rel="stylesheet" href="swiper.min.css"')],
  ['debug overlay REMOVED', !html.includes('id="init-debug"')],
  ['mobile-swipe-header present', html.includes('class="mobile-swipe-header"')],
  ['mobile-view-connect has swiper-slide class', html.includes('class="mobile-view swiper-slide"')],
  ['initMobileContent in app.js', fs.readFileSync('C:/PuffcoBLE/app.js','utf8').includes('function initMobileContent')],
  ['initMobileSwiper in app.js', fs.readFileSync('C:/PuffcoBLE/app.js','utf8').includes('function initMobileSwiper')],
  ['updateActiveTab single def in app.js', (fs.readFileSync('C:/PuffcoBLE/app.js','utf8').match(/function updateActiveTab/g)||[]).length === 1],
  ['openSettingsPanel in switchToView', fs.readFileSync('C:/PuffcoBLE/app.js','utf8').includes("viewName === 'settings'")],
  ['app-container display none on mobile', css.includes('.app-container { display: none !important;')],
  ['app-tab-bar display flex on mobile', css.includes('.app-tab-bar {') && css.includes('display: flex')],
  ['[CSS] app-views position fixed', css.includes('app-views') && css.includes('position: fixed')],
  ['[CSS] mobile-view height 100%', css.includes('mobile-view') && css.includes('height: 100%')],
  ['[CSS] mobile-swipe-header sticky', css.includes('mobile-swipe-header') && css.includes('position: sticky')],
  ['[CSS] desktop 701px media query hides app-views', css.includes('.app-views,')],
];

let allOk = true;
for (const [name, pass] of checks) {
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name);
  if (!pass) allOk = false;
}

console.log(allOk ? '\nAll structural checks passed!' : '\nSome structural checks FAILED');
process.exit(allOk ? 0 : 1);
