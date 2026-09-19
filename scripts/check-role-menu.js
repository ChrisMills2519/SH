// Checks the phone "My role" menu without a browser.
//
//   1. Drives the real roleMenuHtml() from public/js/play.js for every role.
//   2. Compares it to the mirror in public/preview-play.html, so the preview
//      you eyeball can't drift from what ships.
//   3. Checks the escaping, and that every id/class the menu needs exists.
//
// Usage: node scripts/check-role-menu.js
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

const playJs = read('js/play.js');
const preview = read('preview-play.html');
const playHtml = read('play.html');
const css = read('css/style.css');

const fail = [];
const ok = [];
const check = (cond, msg) => (cond ? ok.push(msg) : fail.push(msg));

// --- pull a top-level function out of a source file -------------------------
function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`no function ${name}()`);
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(`unterminated ${name}()`);
  return src.slice(start, end + 2);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Both files must expose the same template.
const playMenu = new Function('myRole', 'myTeammates', 'escapeHtml', sliceFn(playJs, 'roleMenuHtml') + '\nreturn roleMenuHtml();');
const previewMenu = new Function('role', 'ROLES', 'esc', sliceFn(preview, 'roleMenuHtml') + '\nreturn roleMenuHtml();');

// Whitespace is formatted differently in each file (template literal vs string
// concat), so compare with inter-tag whitespace collapsed.
const norm = (h) => h.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

const HOSTILE = 'Bobby <script>alert(1)</script> "quoted" & \'amp\'';

const CASES = [
  { label: 'liberal', role: 'liberal', mates: [] },
  { label: 'fascist', role: 'fascist', mates: ['Boris', 'Clara'] },
  { label: 'hitler', role: 'hitler', mates: ['Boris'] },
  { label: 'fascist, hostile name', role: 'fascist', mates: ['Boris', HOSTILE] },
];

console.log('role menu template\n');
for (const c of CASES) {
  const ship = playMenu(c.role, c.mates.map((name, i) => ({ uid: 'u' + i, name })), esc);
  const prev = previewMenu(c.role, { [c.role]: { mates: c.mates } }, esc);
  const same = norm(ship) === norm(prev);
  check(same, `preview mirrors play.js for ${c.label}`);
  const classes = [...ship.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
  console.log(`  ${c.label.padEnd(22)} ${ship.replace(/\s+/g, ' ').trim().slice(0, 78)}…`);
  if (!same) {
    console.log(`      shipped: ${norm(ship)}`);
    console.log(`      preview: ${norm(prev)}`);
  }
  // Escaping: a player name goes straight into innerHTML.
  if (c.mates.includes(HOSTILE)) {
    check(!ship.includes('<script'), 'hostile name is not injected as markup');
    check(ship.includes('&lt;script&gt;'), 'hostile name is entity-escaped');
    check(!/<img[^>]*alt="[^"]*<script/.test(ship), 'alt text is not attacker-controlled');
  }
  check(classes.length > 0, `${c.label}: emits styled classes`);
}

// Every class the template emits must have a rule (so nothing is unstyled).
const emitted = new Set();
for (const c of CASES) {
  const html = playMenu(c.role, [], esc);
  for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((x) => emitted.add(x));
}
for (const cl of emitted) check(new RegExp('\\.' + cl + '[\\s,{:.]').test(css), `style.css defines .${cl}`);

// Copy rules: the app cannot say which ally is Hitler, so it must not imply it.
const fascistHtml = playMenu('fascist', [{ uid: 'b', name: 'B' }], esc);
check(/does not mark which is Hitler/.test(fascistHtml), 'fascist copy does not overclaim who Hitler is');
check(/Your allies/.test(fascistHtml), 'fascist sees an "allies" heading');
check(/Your Fascists/.test(playMenu('hitler', [{ uid: 'b', name: 'B' }], esc)), 'hitler sees a "Your Fascists" heading');
check(/know nobody/.test(playMenu('liberal', [], esc)), 'liberal is told they know nobody');
check(/Waiting for the host/.test(playMenu(null, [], esc)), 'no role yet -> a waiting message, not an empty card');

// Markup contract between play.html and play.js.
for (const id of ['roleMenu', 'roleMenuBody', 'roleMenuClose', 'roleMenuBtn']) {
  check(new RegExp(`id="${id}"`).test(playHtml), `play.html has #${id}`);
}
check(/class="play-topbar"/.test(playHtml), 'play.html has .play-topbar');
check(/id="soundBtn"/.test(playHtml), 'play.html still has #soundBtn (sound.js uses getElementById only)');
// The menu sits outside .board-wrap so a re-render of #main can't wipe it.
const menuPos = playHtml.indexOf('id="roleMenu"');
const wrapEnd = playHtml.indexOf('id="main"');
check(menuPos > wrapEnd, '#roleMenu is rendered outside #main (survives a re-render)');
// roleMenuBtn must start hidden and be revealed by initRoleMenu() after a join.
check(/id="roleMenuBtn"[^>]*display:none/.test(playHtml), '#roleMenuBtn starts hidden until a seat has joined');
check(/initRoleMenu\(\)/.test(playJs), 'play.js calls initRoleMenu()');

// Preview harness must offer the screen and the mirror.
check(/data-s="menu"/.test(preview), 'preview-play.html has a "my role menu" screen');
check(/id="ppRoleMenu"/.test(preview) && /id="ppRoleMenuBtn"/.test(preview), 'preview mirrors the overlay and its button');

// Syntax of the preview's inline script (classic script, no imports).
const inline = preview.match(/<script>([\s\S]*?)<\/script>/);
if (inline) {
  try {
    new (require('vm').Script)(inline[1]);
    ok.push('preview inline script parses');
  } catch (e) {
    fail.push('preview inline script has a syntax error: ' + e.message);
  }
}

console.log(`\n${ok.length} checks passed`);
if (fail.length) {
  console.log(`\n${fail.length} FAILED:`);
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('all good');
