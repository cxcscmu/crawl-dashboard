const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../site/domain-metrics.js');
const table = (columns, data) => ({ columns, data });
const fixture = { tables: {
  'domains/top_domains': { 1: table(['domain', 'pages'], [['a.test', 90]]) },
  'fetch/top_failing_domains': { 1: table(['domain', '4xx/5xx responses'], [['a.test', 10]]) },
  'domains/diagnostics': { 1: table(['domain', 'attempts', 'failures', 'allocated budget'], [['a.test', 100, 20, 200], ['b.test', 0, 0, 0], ['c.test', 2, 4, 1]]) },
  'frontier/links_by_domain': { 1: table(['domain', 'outlinks'], [['b.test', 0]]) },
  'frontier/priority_score_by_domain': { 1: table(['domain', 'spearman', 'scored pairs'], [['a.test', -.5, 3], ['b.test', .8, 10], ['c.test', 1, 2], ['d.test', 1.2, 20]]) },
} };
test('joins domain populations without using pages as attempts', () => {
  const a = D.domains(fixture, 1).find(r => r.domain === 'a.test');
  assert.equal(a.failureRate, 20); assert.equal(a.budgetUse, 50); assert.equal(a.httpErrors, 10); assert.equal(a.pages, 90);
  const old = D.domains({tables:{'fetch/top_failing_domains':fixture.tables['fetch/top_failing_domains']}},1)[0];
  assert.equal(old.failureRate, null); assert.equal(old.budgetUse, null);
});
test('zero and missing denominators stay unknown; invalid ratios excluded', () => {
  const rows = D.domains(fixture, 1);
  assert.equal(rows.find(r=>r.domain==='b.test').failureRate, null);
  assert.equal(rows.find(r=>r.domain==='b.test').budgetUse, null);
  assert.equal(rows.find(r=>r.domain==='c.test').failureRate, null);
  assert.equal(rows.find(r=>r.domain==='c.test').budgetUse, 200);
  assert.equal(D.rank(rows, 'outlinks')[0].outlinks, 0);
});
test('signed correlations rank both ways and require eligible samples', () => {
  const rows=D.domains(fixture,1);
  assert.deepEqual(D.rank(rows,'spearman').map(r=>r.domain),['b.test','a.test']);
  assert.deepEqual(D.rank(rows,'spearman',true).map(r=>r.domain),['a.test','b.test']);
});
test('missing cycle/table and malformed tables are empty', () => {
  assert.deepEqual(D.domains(fixture, 2),[]); assert.deepEqual(D.domains({},1),[]);
  assert.deepEqual(D.rows({tables:{x:{1:{columns:null,data:[]}}}},'x',1),[]);
});
test('examples accept only real HTTP(S) URLs on matching domain/subdomains', () => {
  const data={tables:{'domains/page_examples':{1:table(['domain','url'],[
    ['a.test','https://a.test/page'],['a.test','https://www.a.test/page'],['a.test','javascript:alert(1)'],
    ['a.test','https://a.test.evil.test/'],['a.test','https://user:secret@a.test/'],['a.test','/relative'],['b.test','https://b.test/']
  ])}}};
  assert.deepEqual(D.examples(data,'a.test',1).map(r=>r.url),['https://a.test/page','https://www.a.test/page']);
  assert.deepEqual(D.examples(data,'a.test',2),[]);
});
test('weighted domain means omit unknown scores rather than converting them to zero', () => {
  assert.equal(D.weightedMean([{score:null,n:100},{score:.8,n:10},{score:.4,n:10}], 'score','n'),.6);
  assert.equal(D.weightedMean([{score:undefined,n:10},{score:.8,n:0}], 'score','n'),null);
});
