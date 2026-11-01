// Reuse the explicit SSR fixture with current real App JSX/CSS; never requests media.
const fs = require('node:fs');
const source = fs.readFileSync('tests/frontend/conversation-layout.cjs','utf8')
  .replaceAll('task12-layout','task13-layout')
  .replace('src="/page.html#conversation-history"','src="/page.html"');
new Function('require',source)(require);
