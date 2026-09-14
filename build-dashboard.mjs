/**
 * Builds dashboard.js from dashboard.page.html.
 *
 * The page is served as one template literal, which is why this exists: a
 * template literal eats backslashes (\s becomes s, \n becomes a newline), so
 * every regex in the page would quietly stop being a regex. Doubling them by
 * hand in a 900-line string is how that goes wrong at six in the morning.
 *
 *   node src/build-dashboard.mjs
 *
 * Edit dashboard.page.html. Never edit dashboard.js.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'dashboard.page.html'), 'utf8');

for (const [ch, why] of [['`', 'backtick'], ['${', 'dollar-brace']]) {
  if (page.includes(ch)) {
    console.error(`dashboard.page.html contains a ${why}, which would end the template literal.`);
    process.exit(1);
  }
}

const header = readFileSync(join(here, 'dashboard.js'), 'utf8')
  .split('const PAGE = `')[0];

writeFileSync(join(here, 'dashboard.js'),
  header + 'const PAGE = `' + page.replaceAll('\\', '\\\\') + '`;\n\n' +
  'export const DASHBOARD_HTML = PAGE.split(\'__FONT__\').join(PAGELLA_WOFF2_B64);\n');

console.log('dashboard.js rebuilt from dashboard.page.html');
