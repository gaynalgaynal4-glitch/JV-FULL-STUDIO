import fs from 'node:fs';
import vm from 'node:vm';
const files = ['../public/index.html', '../public/video-lab.html'];
let checked = 0;
for (const file of files) {
  const html = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for (let i = 0; i < scripts.length; i++) {
    const source = scripts[i][1].trim();
    if (!source) continue;
    new vm.Script(source, { filename: `${file}:inline-script-${i + 1}` });
    checked++;
  }
}
console.log(`Checked ${checked} inline JavaScript blocks across PostZen and Video Lab.`);
