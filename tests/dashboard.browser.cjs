/* Uses public ignored snapshots for legacy checks, and explicitly illustrative in-memory fixtures for new tables. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.DASHBOARD_URL || 'http://localhost:8000';
const evidence = process.env.EVIDENCE_DIR || '/tmp/crawl-evidence';
fs.mkdirSync(evidence, { recursive: true });
const t = (columns, data) => ({columns, data});
const fixture = {
  id:'fixture',name:'Illustrative domain diagnostics — browser test only',state:'finished',cycles:[1,2],config:{},
  exported_at:'2026-11-04T18:00:00Z', histograms:{},
  metrics:{'fetch/pages':[100,200],'wall/pages_cumulative':[100,300]},
  tables:{
    'domains/top_domains':{1:t(['domain','pages'],[['alpha.test',90],['beta.test',10]])},
    'domains/diagnostics':{1:t(['domain','allocated budget','attempts','failures','pages fetched'],[['alpha.test',200,100,20,80],['beta.test',10,10,9,1]])},
    'fetch/top_failing_domains':{1:t(['domain','4xx/5xx responses'],[['alpha.test',15],['beta.test',8]])},
    'frontier/links_by_domain':{1:t(['domain','outlinks','distinct outlinks'],[['alpha.test',500,400],['beta.test',0,0]])},
    'frontier/priority_score_by_domain':{1:t(['domain','spearman','pearson','scored pairs'],[['alpha.test',.9,.8,20],['beta.test',-.4,-.2,5],['small.test',1,1,2]])},
    'domains/page_examples':{1:t(['domain','url','title','status','FineWeb-Edu'],[['alpha.test','https://alpha.test/article','Example crawled article',200,.7],['alpha.test','javascript:alert(1)','Unsafe sample',200,.4]])}
  }
};
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'chrome'});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const capture = async (name) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForTimeout(150); // Allow Chrome's compositor to settle after viewport changes.
    await page.screenshot({path:path.join(evidence,name),animations:'disabled'});
  };
  await page.goto(base+'/?tab=explorer');await page.waitForSelector('.explorer-table');
  assert.equal(await page.locator('#error').isVisible(),false);
  await capture('real-desktop.png');
  // Progressive disclosure preserves summaries and configuration without crowding the default view.
  assert.equal(await page.locator('#cycle-summary').getAttribute('open'),null);
  assert.equal(await page.locator('#gaps').getAttribute('open'),null);
  assert.equal(await page.getByRole('tab').count(),12);
  await page.locator('#kpi-title').click();
  assert.equal(await page.locator('.tile').count(),8);
  await page.locator('.tile').first().waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelectorAll('.spark-host .js-plotly-plot').length === 8);
  await capture('real-summary.png');
  await page.locator('#kpi-title').click();
  await page.locator('.run-details summary').click();
  await page.locator('#run-name').waitFor({state:'visible'});
  await capture('real-run-details.png');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.run-details').getAttribute('open'),null);
  // Existing charts remain reachable, and table buttons work.
  await page.getByRole('tab',{name:'Page quality',exact:true}).click();
  await page.getByRole('button',{name:'Table',exact:true}).first().click();
  assert.ok(await page.locator('figure').first().locator('table tbody tr').count());
  // Cross-section search, keyboard activation, focus, no-results recovery.
  const search=page.getByRole('searchbox',{name:'Find a figure',exact:true});
  await search.fill('frontier/outlinks');assert.ok(await page.locator('.figure-result').count());
  await page.locator('.figure-result').first().focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('tab',{name:'Prioritization',exact:true}).getAttribute('aria-selected'),'true');
  assert.ok(await page.locator('figure:focus').count());
  await search.fill('zz-no-match');await page.getByText('No figures match.',{exact:false}).waitFor();
  await search.fill('');assert.equal(await page.locator('#figure-results').isVisible(),false);
  // Search reveals a missing figure even when its disclosure starts closed.
  await page.getByRole('tab',{name:'Page quality',exact:true}).click();
  assert.equal(await page.locator('#quality .unavailable').getAttribute('open'),null);
  await capture('real-quality.png');
  await search.fill('DataMan and Nemotron');
  await search.press('ArrowDown');await page.keyboard.press('Enter');
  assert.notEqual(await page.locator('#quality .unavailable').getAttribute('open'),null);
  assert.ok(await page.locator('figure:focus').isVisible());
  await search.fill('quality');await search.press('Escape');
  assert.equal(await page.locator('#figure-results').isVisible(),false);
  // Vertical navigation supports the usual arrow/Home/End keyboard pattern.
  await page.getByRole('tab',{name:'Page quality',exact:true}).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getByRole('tab',{name:'Language',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab',{name:'All metrics',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab',{name:'Page quality',exact:true}).getAttribute('aria-selected'),'true');
  // Intermediate widths retain the sidebar without page overflow.
  await page.setViewportSize({width:900,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tablet page overflow');
  await capture('real-tablet.png');
  await page.setViewportSize({width:1440,height:1000});
  // Legacy error counts available; optional data has a specific empty state.
  await page.getByRole('tab',{name:'Domain explorer',exact:true}).click();
  await page.getByRole('button',{name:'Download failures',exact:true}).click();
  assert.ok(await page.locator('.explorer-table tbody tr').count());
  await page.getByLabel('Rank domains by',{exact:true}).selectOption('failureRate');
  await page.getByText('No failure rate records',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Links by source',exact:true}).click();
  await page.getByText('No outlinks records',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator('.domain-link').first().click();await page.getByText('Example crawled pages',{exact:true}).waitFor();
  await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer').isVisible(),false);
  for (const tab of ['Language','Text usability','Domain diversity','Prioritization','Fetch outcomes','Fetch cache','Speed','Storage','Downstream','All metrics']) {
    await page.getByRole('tab',{name:tab,exact:true}).click(); assert.equal(await page.locator('#error').isVisible(),false,tab);
  }
  // Other public runs include sparse legacy and cache-aware snapshots.
  for (const id of ['crawl-237653', 'baseline-148132', 'crawl-233150']) {
    await page.locator('#f-run').selectOption(id);
    await page.waitForFunction(id => DATA?.id === id, id);
    await page.getByRole('tab',{name:'Domain explorer',exact:true}).click();
    await page.getByRole('button',{name:'Overview',exact:true}).click();
    assert.ok(await page.locator('.explorer-table tbody tr').count(),id);
    assert.equal(await page.locator('#error').isVisible(),false,id);
  }
  await search.fill('failure');
  await capture('real-figure-search.png');
  await search.fill('');
  // Test fixture only: never write fabricated records into site/data.
  await page.route('**/data/runs.js',r=>r.fulfill({contentType:'text/javascript',body:'window.CRAWL_RUNS=[{id:"fixture",name:"Illustrative test data",file:"data/fixture.js"}];'}));
  await page.route('**/data/fixture.js',r=>r.fulfill({contentType:'text/javascript',body:'window.CRAWL_DATA={fixture:'+JSON.stringify(fixture)+'};'}));
  await page.goto(base+'/?tab=explorer&cycle=1');await page.waitForSelector('.explorer-table');
  await page.getByRole('button',{name:'Download failures',exact:true}).click();
  await page.getByLabel('Rank domains by',{exact:true}).selectOption('failureRate');
  assert.equal(await page.locator('.domain-link').first().textContent(),'beta.test');
  assert.match(await page.locator('.explorer-table').textContent(),/90%/);
  await page.getByLabel('Rank domains by',{exact:true}).selectOption('budget');
  assert.equal(await page.locator('.domain-link').first().textContent(),'alpha.test');
  await page.getByRole('button',{name:'Priority correlation',exact:true}).click();
  assert.equal(await page.locator('.domain-link').count(),2);
  assert.equal(await page.locator('.domain-link').first().textContent(),'alpha.test');
  await page.getByRole('button',{name:'Highest first',exact:true}).click();
  assert.equal(await page.locator('.domain-link').first().textContent(),'beta.test');
  await page.getByRole('searchbox',{name:'Filter domains',exact:true}).fill('alpha');
  assert.equal(await page.locator('.domain-link').count(),1);
  await page.locator('.domain-link').click();
  assert.equal(await page.locator('#drawer a[href="https://alpha.test/article"]').count(),1);
  assert.equal(await page.locator('#drawer a[href^="javascript:"]').count(),0);
  await capture('fixture-domain.png');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.domain-link:focus').count(),1);
  await page.getByRole('searchbox',{name:'Filter domains',exact:true}).fill('');
  await page.getByRole('button',{name:'Links by source',exact:true}).click();
  assert.equal(await page.locator('.domain-link').count(),2);assert.match(await page.locator('.explorer-table').textContent(),/500/);
  await page.getByRole('button',{name:'Cumulative',exact:true}).click();
  assert.match(await page.locator('#explorer').textContent(),/Cycle 1 · Per-cycle/);
  await page.locator('#f-cycle').selectOption('2');await page.getByText('No outlinks records for cycle 2',{exact:true}).waitFor();
  await page.locator('#f-cycle').selectOption('1');assert.ok(await page.locator('.explorer-table tbody tr').count());
  await page.getByRole('button',{name:'Dark mode',exact:true}).click();
  await page.locator('#explorer').scrollIntoViewIfNeeded();await capture('fixture-dark.png');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#f-section').isVisible(),true);
  assert.equal(await page.locator('#tabs').isVisible(),false);
  assert.equal(await page.locator('#f-section option').count(),12);
  await page.locator('#f-section').selectOption('language');
  await page.locator('#language-h').waitFor({state:'visible'});
  await page.locator('#f-section').selectOption('explorer');
  await page.getByRole('button',{name:'Download failures',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page overflow');
  await page.locator('#explorer').scrollIntoViewIfNeeded();await capture('fixture-mobile.png');
  await page.getByRole('button',{name:'Light mode',exact:true}).click();
  await page.locator('#explorer').scrollIntoViewIfNeeded();
  await capture('fixture-mobile-light.png');
  await page.locator('.domain-link').first().click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'drawer page overflow');
  await capture('fixture-mobile-domain.png');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:320,height:740});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'small mobile overflow');
  await capture('fixture-small-mobile.png');
  assert.deepEqual(errors,[]);console.log('PASS: real snapshot, all sections, chart tables, figure search, empty states, domain details, fixture rankings, ratios, examples, cycle changes, cumulative context, keyboard, light/dark and mobile.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
