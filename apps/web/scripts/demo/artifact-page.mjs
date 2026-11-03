// dist-demo/index.html → dist-demo/demo.html: the same page without its own <html>/<head>/<body>
// (the hosting page supplies those), plus a title and description.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('../../dist-demo/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const head = html.match(/<head>([\s\S]*)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<link rel="(icon|manifest)"[^>]*>\s*/g, '')
  .replace(/<title>[^<]*<\/title>/, '<title>Trawer Live Demo</title>')
  .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="Clickable demo of Trawer with a sample fabric shop" />');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
writeFileSync(new URL('demo.html', dir), `${head.trim()}\n<style>html,body{background:#F7F5EF;margin:0}</style>\n${body.trim()}\n`);
console.log('ok');
