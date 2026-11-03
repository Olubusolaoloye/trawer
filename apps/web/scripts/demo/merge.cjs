// node merge.cjs fixtures.json extra.json → src/demo/data.json (product photos dropped: the demo has no media server).
const fs = require('fs');
const [fx, ex] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const strip = (v) => JSON.parse(JSON.stringify(v), (k, val) => (typeof val === 'string' && /^\/media\//.test(val) ? null : val));
const out = strip({ fixtures: fx, ...ex });
fs.writeFileSync(new URL('../../src/demo/data.json', `file://${__filename}`), JSON.stringify(out));
console.log('fixtures', Object.keys(fx).length, 'products', Object.keys(ex.products).length);
