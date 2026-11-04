import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
let checked = 0;
for (let i = 0; i < scripts.length; i++) {
  const source = scripts[i][1].trim();
  if (!source) continue;
  new vm.Script(source, { filename: `public/index.html:inline-script-${i + 1}` });
  checked++;
}
console.log(`Checked ${checked} inline JavaScript blocks.`);
