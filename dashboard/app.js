// Token Radar dashboard: board, detail view and filters, no network.
// Reads window.RADAR from data.js (written by main.ts from the same
// board.json the gate checks), so the page and the board can never drift
// apart. Views are hash routes: "" the board, "#/p/<slug>" a protocol's
// detail, "#/f/<category>" the board filtered to one category.
//
// The board ranks on EXPECTED value: the conditional value-if-launches
// times P(token) from the odds model. The farm verdicts are computed
// here from the same arithmetic the server uses (see farmMath), so the
// scenario controls can move them live; at the default scenario the
// verdicts match board.json exactly.
(function () {
  'use strict';
  var R = window.RADAR;
  var app = document.getElementById('app');
  if (!R || !R.rows) {
    app.innerHTML = '<p>Could not load the board data.</p>';
    return;
  }
  var rows = R.rows;
  var live = R.live || [];
  var cats = [];
  rows.forEach(function (r) {
    if (cats.indexOf(r.category || 'Uncategorized') < 0) cats.push(r.category || 'Uncategorized');
  });
  cats.sort();

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function moneySigned(n) {
    if (n === null || n === undefined) return '—';
    return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function ageText(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d < 30) return d + ' days';
    if (d < 365) return Math.round(d / 30) + ' months';
    return (d / 365).toFixed(1) + ' years';
  }
  function probText(p) {
    if (p === null || p === undefined) return '—';
    return Math.round(p * 100) + '%';
  }
  function verdictBadge(v) {
    if (v === 'FARM') return '<span class="verdict v-farm">FARM</span>';
    if (v === 'THIN') return '<span class="verdict v-thin">THIN</span>';
    return '<span class="verdict v-skip">SKIP</span>';
  }

  // Farm economics, mirroring lib/model.ts farmEconomics exactly.
  // Defaults (from R.farm_defaults): 5% of expected value allocated to an
  // airdrop, split among 10,000 farmers, share scaling linearly with the
  // deposit against the $100 average farmer, time at $25 an hour.
  // FARM clears $50 net and $25 an hour; THIN is positive but below that;
  // SKIP loses money. The airdrop share and farmer count are assumptions,
  // not measured facts — move the controls and watch the verdicts change.
  var state = { q: '', cat: '', minTvl: 0, wl: false, sort: 'rank', dir: 1, sc: { deposit: '', alloc: 5, farmers: 10000, hourly: 25 } };
  function farmMath(r) {
    var sc = state.sc;
    var deposit = sc.deposit === '' || sc.deposit === null ? r.farm_capital_usd : +sc.deposit;
    var airdrop = r.implied_value_usd * (sc.alloc / 100) / sc.farmers * (deposit / 100);
    // At the default scenario the verdict is the server's own stored one:
    // the recompute below rounds the stored time to 4 decimals, which can
    // move a net by a dollar at a rounding boundary. Off-default, the
    // recompute is what the controls are for.
    if (sc.deposit === '' && sc.alloc === 5 && sc.farmers === 10000 && sc.hourly === 25) {
      return { verdict: r.farm_verdict, net: r.farm_net_usd, nph: r.farm_net_per_hour_usd, airdrop: airdrop, deposit: deposit };
    }
    var net = airdrop - r.farm_gas_usd - r.farm_time_hours * sc.hourly;
    var nph = net / r.farm_time_hours;
    var verdict = (net >= 50 && nph >= 25) ? 'FARM' : (net > 0 ? 'THIN' : 'SKIP');
    return { verdict: verdict, net: Math.round(net), nph: Math.round(nph * 100) / 100, airdrop: airdrop, deposit: deposit };
  }

  function statsHtml() {
    var h = R.holdout;
    var fc = R.farm_counts;
    return '<div class="stats">' +
      '<div class="stat"><b>' + R.board_size + '</b><span>protocols ranked</span></div>' +
      '<div class="stat"><b>' + R.watchlist_size + '</b><span>watchlist covered</span></div>' +
      '<div class="stat"><b>' + R.early_size + '</b><span>below the $50M floor</span></div>' +
      '<div class="stat"><b>' + fc.farm + ' FARM</b><span>' + fc.thin + ' thin · ' + fc.skip + ' skip</span></div>' +
      '<div class="stat"><b>' + h.logR2.toFixed(2) + '</b><span>v1 benchmark hold-out log R&sup2;</span></div>' +
      '<div class="stat"><b>' + Math.round(h.mdAPE * 100) + '%</b><span>v1 benchmark median error</span></div>' +
      '</div>';
  }

  function scenarioHtml() {
    var sc = state.sc;
    var fd = R.farm_defaults;
    return '<div class="scenario"><h3>Farm scenario — move the assumptions, watch the verdicts change</h3>' +
      '<p class="note">Every verdict below uses these assumptions. The airdrop is <b>not</b> a measured fact: it assumes ' + fd.allocShare * 100 + '% of a protocol&rsquo;s expected value is allocated to an airdrop, split among ' + fd.farmers.toLocaleString('en-US') + ' farmers, with a farmer&rsquo;s share scaling linearly with the deposit against the $100 average farmer. Gas is the plan&rsquo;s own estimate; time is valued at the hourly rate. FARM clears $50 net and $25 an hour; THIN is positive but below that; SKIP loses money.</p>' +
      '<div class="controls">' +
      '<label>Deposit $ <input id="sc-deposit" type="number" min="10" max="100000" step="10" placeholder="' + rows[0].farm_capital_usd + ' (plan capital)" value="' + esc(sc.deposit) + '"></label>' +
      '<label>Airdrop share % <input id="sc-alloc" type="number" min="0" max="50" step="0.5" value="' + sc.alloc + '"></label>' +
      '<label>Farmers <input id="sc-farmers" type="number" min="100" max="1000000" step="100" value="' + sc.farmers + '"></label>' +
      '<label>Hourly value $ <input id="sc-hourly" type="number" min="0" max="500" step="5" value="' + sc.hourly + '"></label>' +
      '<button id="sc-reset" type="button">Reset to defaults</button>' +
      '</div></div>';
  }

  function methodHtml() {
    var h = R.holdout;
    var f = R.fitted;
    var o = R.odds;
    return '<div class="method"><h3>How an expected value is computed</h3>' +
      '<p><b>1. Conditional value if it launched a token.</b> <code>log10(market cap) = ' + f.intercept.toFixed(4) + ' + ' + f.slope.toFixed(4) + ' &times; log10(TVL)</code> fitted by least squares on the ' + f.tradedCount + ' traded tokens in this snapshot, plus a shrunk category adjustment (' + f.adjustedCategories.length + ' categories, median residual &times; n/(n+8)). Then &times; a growth multiplier from the 7-day TVL change (clamped &minus;60% to +120%) and &times; a maturity multiplier from the protocol&rsquo;s age (0.6 to 1.0). The shipped fit is recomputed from the snapshot on every run — no hardcoded list of names.</p>' +
      '<p><b>2. Token odds.</b> A logistic model for P(token) fitted on the snapshot&rsquo;s peer record (' + o.n + ' protocols, ' + (o.baseRate * 100).toFixed(1) + '% record a token): log TVL, age, listing-date-unknown, 7-day change and category dummies. A term is in only if it lowers the Brier score in BOTH the leave-one-out test (' + o.selectedLoo.toFixed(4) + ') and the walk-forward test (' + o.selectedWf.toFixed(4) + '), against a base-rate Brier of ' + o.baseBrier.toFixed(4) + '. The odds are the peers&rsquo; record, not a forecast.</p>' +
      '<p><b>3. Expected value = conditional value &times; P(token).</b> That is the number the board ranks on. Both parts are shown as columns, and each row&rsquo;s detail view shows the logit contributions behind its P(token), so any row can be audited.</p>' +
      '<p><span class="warn">Honest check — v1 benchmark, unchanged:</span> on a fixed hold-out (traded tokens sorted by slug, every 5th held out: ' + h.trainCount + ' train, ' + h.testCount + ' test), the full value pipeline scores log R&sup2; ' + h.logR2.toFixed(3) + ' with a median error of ' + Math.round(h.mdAPE * 100) + '% and a mean error of ' + Math.round(h.mape * 100) + '%. The fit is weak: TVL alone explains little of a token&rsquo;s market cap. The walk-forward test is worse still — every value variant scores a negative log R&sup2; when fitted on older tokens and scored on newer ones, so the value model does not generalise forward in time. Treat every implied value as a rough comps estimate, not a forecast. The model sees no tokenomics, vesting, team, revenue or user data — the snapshot carries none of it — and the traded set is survivors only. Run <code>scripts/eval-model.mjs</code>, <code>scripts/eval-odds.mjs</code> and <code>scripts/eval-ablation.mjs</code> to reproduce these numbers from the snapshot.</p>' +
      '<p><b>Exclusions.</b> A protocol is ranked only if it records no token and the house eligibility rule does not exclude it (bridge, staked or wrapped product of a token that trades; versioned pool; exchange product). One correction in this version: &ldquo;Cross Chain Bridge&rdquo; is not in the house rule&rsquo;s category list, so Circle Gateway ($65.3M TVL) is ranked — the only re-admission. Every other questionable exclusion was checked individually against the rule as written and stays excluded; the ledger below names each group.</p>' +
      '</div>';
  }

  function ledgerHtml() {
    var h = '<h2 class="sec">Ledger: all ' + R.ledger_total + ' protocols accounted for</h2>' +
      '<p class="note">Every protocol in the snapshot sits in exactly one group. The counts sum to ' + R.ledger_total + '.</p>' +
      '<table><thead><tr><th>Group</th><th class="num">Count</th><th>Why</th></tr></thead><tbody>';
    R.ledger.forEach(function (g) {
      h += '<tr><td>' + esc(g.group) + '</td><td class="num">' + g.count + '</td><td>' + esc(g.note) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  function oddsHtml() {
    var o = R.odds;
    var h = '<div id="evidence"><h2 class="sec">Token odds: will it ever launch one?</h2>' +
      '<p class="note">P(token) is the share of similar protocols that record a token, from the peers&rsquo; record — ' + o.n + ' protocols, ' + (o.baseRate * 100).toFixed(1) + '% record one. It is not a forecast, and it is not a guarantee: a protocol with P(token) 80% may never launch, and one at 20% may launch tomorrow. What it does is stop the board ranking a huge-but-unlikely protocol above a smaller-but-likely one.</p>' +
      '<table><thead><tr><th>Term</th><th class="num">Leave-one-out Brier</th><th class="num">Walk-forward Brier</th><th>Kept?</th></tr></thead><tbody>';
    o.terms.forEach(function (t) {
      h += '<tr><td>' + esc(t.label) + '</td><td class="num">' + t.looBrier.toFixed(4) + '</td><td class="num">' + t.wfBrier.toFixed(4) + '</td><td>' + (t.label.indexOf('base:') === 0 ? 'base' : (t.kept ? 'kept' : 'tested, not kept')) + '</td></tr>';
    });
    h += '<tr><td>CONTROL: base + shuffled log TVL</td><td class="num">' + o.controlLoo.toFixed(4) + '</td><td class="num">' + o.controlWf.toFixed(4) + '</td><td>must not help — confirmed</td></tr>';
    h += '</tbody></table>' +
      '<p class="note">Selected model: leave-one-out Brier ' + o.selectedLoo.toFixed(4) + ' against a base-rate Brier of ' + o.baseBrier.toFixed(4) + ' (' + Math.round((1 - o.selectedLoo / o.baseBrier) * 100) + '% better); walk-forward Brier ' + o.selectedWf.toFixed(4) + ' (fit on ' + o.wfTrain + ' older protocols, scored on ' + o.wfTest + ' newer ones, cutoff ' + esc(o.wfCutoff) + '). Chain count was tested and not kept: it did not help the walk-forward test. Coefficients (log-odds):</p>' +
      '<table><thead><tr><th>Feature</th><th class="num">Coefficient</th></tr></thead><tbody>';
    o.coefficients.forEach(function (c) {
      h += '<tr><td>' + esc(c.feature) + '</td><td class="num">' + (c.value >= 0 ? '+' : '') + c.value.toFixed(4) + '</td></tr>';
    });
    h += '</tbody></table>' +
      '<p class="note">Reading the coefficients: each extra year listed adds about +0.61 to the log-odds; a missing listing date adds +1.26 (protocols with no listing date in the snapshot are mostly older, token-recorded ones — see the age table below); a fast 7-day TVL rise counts <i>against</i> recording a token yet (coefficient &minus;2.03 per unit of change), holding age and size fixed — growth precedes a launch rather than following one. Centralised-exchange protocols count heavily against (coefficient &minus;2.04).</p>' +
      '<table><thead><tr><th>Decile (leave-one-out predictions)</th><th class="num">Protocols</th><th class="num">Mean predicted P(token)</th><th class="num">Observed token rate</th></tr></thead><tbody>';
    o.calibration.forEach(function (d) {
      h += '<tr><td>' + d.bin + '</td><td class="num">' + d.n + '</td><td class="num">' + (d.meanPred * 100).toFixed(1) + '%</td><td class="num">' + (d.observed * 100).toFixed(1) + '%</td></tr>';
    });
    h += '</tbody></table>' +
      '<p class="note">Calibration: the predicted and observed rates track each other across deciles — the model is roughly honest about its own uncertainty, slightly under-predicting at the bottom and over-predicting near the top.</p>' +
      '<table><thead><tr><th>Age bucket (peers&rsquo; record)</th><th class="num">Protocols</th><th class="num">Record a token</th><th class="num">Rate</th></tr></thead><tbody>';
    o.ageBuckets.forEach(function (b) {
      h += '<tr><td>' + esc(b.bucket) + '</td><td class="num">' + b.n + '</td><td class="num">' + b.withToken + '</td><td class="num">' + (b.rate * 100).toFixed(1) + '%</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function ablationHtml() {
    var a = R.ablation;
    var h = '<h2 class="sec">Out-of-sample evidence: what was tested, what was kept</h2>' +
      '<p class="note">Every value variant below was scored on the 103 training tokens only (the 25 hold-out test tokens were never used for selection). A term is kept only if it beats the shipped fit by more than 0.02 log R&sup2; in BOTH the 5-fold cross-validation and the walk-forward test (fit on older tokens, score on newer). A pooled gain under 0.02 is noise on 103 tokens.</p>' +
      '<table><thead><tr><th>Variant</th><th class="num">CV log R&sup2;</th><th class="num">CV median error</th><th class="num">Walk-forward log R&sup2;</th><th class="num">Walk-forward median error</th><th>Verdict</th></tr></thead><tbody>';
    a.variants.forEach(function (v) {
      h += '<tr><td>' + esc(v.name) + '</td><td class="num">' + v.cvLogR2.toFixed(4) + '</td><td class="num">' + (v.cvMdAPE * 100).toFixed(1) + '%</td><td class="num">' + v.wfLogR2.toFixed(4) + '</td><td class="num">' + (v.wfMdAPE * 100).toFixed(1) + '%</td><td>' + (v.verdict === 'kept' ? 'kept' : v.verdict === 'must-not-help' ? 'must not help' : 'tested, not kept') + '</td></tr>';
    });
    h += '</tbody></table>' +
      '<p class="note">No alternative is materially better: the best challenger (+ 7-day change) gains 0.007 log R&sup2; in cross-validation — inside the noise — and every variant&rsquo;s walk-forward log R&sup2; is negative, worse than predicting the newer tokens&rsquo; mean. The shipped fit stays because nothing beats it, not because it is strong. Range calibration for the shipped fit (intervals from the other folds&rsquo; out-of-fold residuals, coverage counted on the held-out fold, n=' + a.ranges.n + '): P25–P75 stated ' + a.ranges.p50Stated + '% coverage, actual ' + a.ranges.p50Actual.toFixed(1) + '%; P10–P90 stated ' + a.ranges.p80Stated + '% coverage, actual ' + a.ranges.p80Actual.toFixed(1) + '% — the ranges are roughly honest.</p>';
    return h;
  }

  function filteredRows() {
    var out = rows.filter(function (r) {
      if (state.cat && (r.category || 'Uncategorized') !== state.cat) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (state.wl && !r.watchlist) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    var vRank = { FARM: 0, THIN: 1, SKIP: 2 };
    out.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'implied') d = b.implied_value_usd - a.implied_value_usd;
      else if (key === 'conditional') d = b.conditional_value_usd - a.conditional_value_usd;
      else if (key === 'odds') d = b.token_probability - a.token_probability;
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'growth') d = (b.change_7d || 0) - (a.change_7d || 0);
      else if (key === 'verdict') d = (vRank[farmMath(a).verdict] - vRank[farmMath(b).verdict]) || (farmMath(b).net - farmMath(a).net);
      return d * state.dir;
    });
    return out;
  }

  function boardHtml(list, title) {
    var h = '<div id="boardwrap"><h2 class="sec">' + esc(title) + ' <span class="muted small">(' + list.length + ' rows)</span></h2>';
    h += '<table><thead><tr>' +
      '<th data-sort="rank">Rank</th><th>Protocol</th><th>Category</th><th class="num" data-sort="tvl">TVL</th>' +
      '<th class="num" data-sort="growth">7d</th><th class="num" data-sort="odds">P(token)</th>' +
      '<th class="num" data-sort="conditional">If it launched</th><th class="num" data-sort="implied">Expected value</th>' +
      '<th data-sort="verdict">Farm</th></tr></thead><tbody>';
    list.forEach(function (r) {
      var fm = farmMath(r);
      h += '<tr><td>' + r.rank + '</td>' +
        '<td><a href="#/p/' + esc(r.slug) + '">' + esc(r.name) + '</a> ' + (r.watchlist ? '<span class="badge wl">watchlist</span>' : '') + '<br><span class="muted small">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + probText(r.token_probability) + '</td>' +
        '<td class="num">' + money(r.conditional_value_usd) + '</td>' +
        '<td class="num val">' + money(r.implied_value_usd) + '</td>' +
        '<td>' + verdictBadge(fm.verdict) + '<br><span class="muted small">net ' + moneySigned(fm.net) + '</span></td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function controlsHtml() {
    var opts = '<option value="">All categories</option>';
    cats.forEach(function (c) {
      opts += '<option value="' + esc(c) + '"' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    });
    return '<div class="controls">' +
      '<input id="q" type="search" placeholder="Search name or slug…" value="' + esc(state.q) + '" aria-label="Search">' +
      '<select id="cat" aria-label="Category">' + opts + '</select>' +
      '<select id="mintvl" aria-label="Minimum TVL">' +
      '<option value="0"' + (state.minTvl === 0 ? ' selected' : '') + '>Any TVL</option>' +
      '<option value="50000000"' + (state.minTvl === 50000000 ? ' selected' : '') + '>&ge; $50M (watchlist floor)</option>' +
      '<option value="100000000"' + (state.minTvl === 100000000 ? ' selected' : '') + '>&ge; $100M</option>' +
      '<option value="1000000000"' + (state.minTvl === 1000000000 ? ' selected' : '') + '>&ge; $1B</option></select>' +
      '<label><input id="wl" type="checkbox"' + (state.wl ? ' checked' : '') + '> Watchlist only</label>' +
      '<select id="sort" aria-label="Sort by">' +
      '<option value="rank"' + (state.sort === 'rank' ? ' selected' : '') + '>Sort: rank</option>' +
      '<option value="implied"' + (state.sort === 'implied' ? ' selected' : '') + '>Sort: expected value</option>' +
      '<option value="conditional"' + (state.sort === 'conditional' ? ' selected' : '') + '>Sort: value if launched</option>' +
      '<option value="odds"' + (state.sort === 'odds' ? ' selected' : '') + '>Sort: P(token)</option>' +
      '<option value="tvl"' + (state.sort === 'tvl' ? ' selected' : '') + '>Sort: TVL</option>' +
      '<option value="growth"' + (state.sort === 'growth' ? ' selected' : '') + '>Sort: 7-day growth</option>' +
      '<option value="verdict"' + (state.sort === 'verdict' ? ' selected' : '') + '>Sort: farm verdict</option></select>' +
      '</div>';
  }

  function liveHtml() {
    var h = '<h2 class="sec">Already trading — shown at the market&rsquo;s value, never ranked</h2>' +
      '<p class="note">These protocols record a token, so the board does not rank them. Their market caps are the market&rsquo;s own numbers from the same snapshot.</p>' +
      '<table><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th></tr></thead><tbody>';
    live.forEach(function (p) {
      h += '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.category || '—') + '</td>' +
        '<td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + money(p.mcap_usd) + '</td>' +
        '<td class="num">' + (p.mcap_usd / p.tvl_usd).toFixed(2) + 'x</td></tr>';
    });
    return h + '</tbody></table>';
  }

  function detailHtml(r) {
    var fm = farmMath(r);
    var o = R.odds;
    var h = '<a class="back" href="#">&larr; Back to the board</a>' +
      '<div class="card"><h2>' + esc(r.name) + ' <span class="muted small">rank ' + r.rank + ' of ' + R.board_size + '</span></h2>' +
      '<p class="muted">' + esc(r.slug) + ' &middot; ' + esc(r.category || 'Uncategorized') + ' &middot; ' + esc(r.chains.join(', ') || 'no chain listed') + (r.watchlist ? ' &middot; <span class="badge wl">watchlist</span>' : '') + '</p>' +
      '<div class="kv"><span>TVL</span><b>' + moneyFull(r.tvl_usd) + '</b></div>' +
      '<div class="kv"><span>7-day TVL change</span><b>' + pct(r.change_7d) + '</b></div>' +
      '<div class="kv"><span>Age (tracked since ' + esc(r.listed_at || 'unknown') + ')</span><b>' + ageText(r.age_days) + '</b></div>' +
      '<div class="kv"><span>Token recorded</span><b>None — records no token</b></div>' +
      '<div class="kv"><span>Value if it launched a token</span><b>' + moneyFull(r.conditional_value_usd) + '</b></div>' +
      '<div class="kv"><span>P(token) — the peers&rsquo; record</span><b>' + probText(r.token_probability) + '</b></div>' +
      '<div class="kv"><span>Expected value (ranked on this)</span><b class="val">' + moneyFull(r.implied_value_usd) + '</b></div>' +
      '<div class="kv"><span>Expected value / TVL</span><b>' + (r.implied_value_usd / r.tvl_usd).toFixed(2) + 'x</b></div></div>' +
      '<div class="card"><h2>How the value was computed</h2>' +
      '<div class="kv"><span>Comps base: 10^(' + R.fitted.intercept.toFixed(4) + ' + ' + R.fitted.slope.toFixed(4) + ' &times; log10 TVL' + (r.category_adjustment ? ' + ' + r.category_adjustment.toFixed(4) + ' ' + esc(r.category || '') + ' adjustment' : '') + ')</span><b>' + moneyFull(r.base_value_usd) + '</b></div>' +
      '<div class="kv"><span>Growth multiplier (7d ' + pct(r.change_7d) + ')</span><b>&times; ' + r.growth_multiplier.toFixed(2) + '</b></div>' +
      '<div class="kv"><span>Maturity multiplier (' + ageText(r.age_days) + ')</span><b>&times; ' + r.maturity_multiplier.toFixed(2) + '</b></div>' +
      '<div class="kv"><span>Conditional value (base &times; growth &times; maturity)</span><b>' + moneyFull(r.conditional_value_usd) + '</b></div>' +
      '<div class="kv"><span>P(token)</span><b>&times; ' + r.token_probability.toFixed(4) + '</b></div>' +
      '<div class="kv"><span>Expected value</span><b class="val">' + moneyFull(r.implied_value_usd) + '</b></div>' +
      '<p class="note">The comps line is fitted on the ' + R.fitted.tradedCount + ' traded tokens in this snapshot; the growth and maturity multipliers are stated assumptions, not fitted parameters. P(token) comes from the logistic odds model on the peers&rsquo; record — see the odds section below for its validation.</p>' +
      '<h3 class="sub2">Why P(token) is ' + probText(r.token_probability) + '</h3>' +
      '<table><thead><tr><th>Feature</th><th class="num">Log-odds contribution</th></tr></thead><tbody>';
    o.coefficients.forEach(function (c, i) {
      var contrib = r.odds_contrib[i];
      if (contrib === 0 || contrib === undefined) return;
      h += '<tr><td>' + esc(c.feature) + '</td><td class="num">' + (contrib >= 0 ? '+' : '') + contrib.toFixed(3) + '</td></tr>';
    });
    var logit = 0;
    r.odds_contrib.forEach(function (c) { logit += c; });
    h += '</tbody></table>' +
      '<p class="note">The contributions sum to the log-odds (' + logit.toFixed(3) + '); the logistic function turns that into P(token) = ' + r.token_probability.toFixed(4) + '. A missing listing date is imputed at the training median age of ' + o.median_age_years + ' years and flagged by the &ldquo;listing date unknown&rdquo; term. Contributions are rounded to three decimals, so the sum may differ from the log-odds by a few thousandths.</p></div>' +
      '<div class="card"><h2>Farm verdict: ' + verdictBadge(fm.verdict) + '</h2>' +
      '<div class="kv"><span>Expected airdrop for one farmer</span><b>' + moneyFull(fm.airdrop) + '</b></div>' +
      '<div class="kv"><span>Gas (deposit + one transaction a week)</span><b>&minus; ' + moneyFull(r.farm_gas_usd) + '</b></div>' +
      '<div class="kv"><span>Time cost (' + r.farm_time_hours + ' hours at $' + state.sc.hourly + '/h)</span><b>&minus; ' + moneyFull(r.farm_time_hours * state.sc.hourly) + '</b></div>' +
      '<div class="kv"><span>Net</span><b class="' + (fm.net >= 0 ? 'val' : '') + '">' + moneySigned(fm.net) + '</b></div>' +
      '<div class="kv"><span>Net per hour</span><b>' + moneySigned(fm.nph) + '/h</b></div>' +
      '<div class="kv"><span>Capital required (deposit)</span><b>' + moneyFull(fm.deposit) + '</b></div>' +
      '<div class="kv"><span>Hold</span><b>' + r.farm_hold_days + ' days</b></div>' +
      '<p class="note">Assumes ' + state.sc.alloc + '% of the expected value is allocated to an airdrop, split among ' + state.sc.farmers.toLocaleString('en-US') + ' farmers, with a farmer&rsquo;s share scaling linearly with the deposit against the $100 average farmer. Those are assumptions, not measured facts — change them in the scenario controls on the board and the verdict moves. FARM clears $50 net and $25 an hour; THIN is positive but below that; SKIP loses money. Never pay to claim an airdrop — claims come only from the protocol&rsquo;s own published link.</p>' +
      '<h3 class="sub2">Farm plan</h3><ol class="farm">';
    r.farm_steps.forEach(function (s) {
      h += '<li>' + esc(s) + '</li>';
    });
    return h + '</ol><p class="note">Gas figures are rough estimates for one transaction on ' + esc(r.chains[0] || 'the protocol&rsquo;s main chain') + '. Costs move with the network; check before you transact.</p></div>';
  }

  function render() {
    var hash = location.hash || '';
    var m = hash.match(/^#\/p\/(.+)$/);
    if (m) {
      var slug = decodeURIComponent(m[1]);
      var row = null;
      rows.forEach(function (r) { if (r.slug === slug) row = r; });
      if (row) {
        app.innerHTML = detailHtml(row) + oddsHtml() + ablationHtml() + methodHtml();
        app.removeAttribute('aria-busy');
        window.scrollTo(0, 0);
        return;
      }
    }
    var f = hash.match(/^#\/f\/(.+)$/);
    var title = 'Ranked board';
    if (f) {
      state.cat = decodeURIComponent(f[1]);
      title = 'Filtered: ' + state.cat;
    }
    app.innerHTML = statsHtml() + scenarioHtml() + controlsHtml() + boardHtml(filteredRows(), title) + ledgerHtml() + oddsHtml() + ablationHtml() + liveHtml() + methodHtml();
    app.removeAttribute('aria-busy');
    bindControls();
  }

  function bindControls() {
    var q = document.getElementById('q');
    var cat = document.getElementById('cat');
    var mintvl = document.getElementById('mintvl');
    var wl = document.getElementById('wl');
    var sort = document.getElementById('sort');
    if (q) q.addEventListener('input', function () { state.q = q.value; renderBoardOnly(); });
    if (cat) cat.addEventListener('change', function () { state.cat = cat.value; render(); });
    if (mintvl) mintvl.addEventListener('change', function () { state.minTvl = +mintvl.value; render(); });
    if (wl) wl.addEventListener('change', function () { state.wl = wl.checked; render(); });
    if (sort) sort.addEventListener('change', function () { state.sort = sort.value; render(); });
    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
        render();
      });
    });
    var dep = document.getElementById('sc-deposit');
    var alloc = document.getElementById('sc-alloc');
    var farmers = document.getElementById('sc-farmers');
    var hourly = document.getElementById('sc-hourly');
    var reset = document.getElementById('sc-reset');
    var onScenario = function () {
      state.sc.deposit = dep.value === '' ? '' : dep.value;
      state.sc.alloc = +alloc.value || 0;
      state.sc.farmers = +farmers.value || 1;
      state.sc.hourly = +hourly.value || 0;
      renderBoardOnly();
      var fc = { farm: 0, thin: 0, skip: 0 };
      rows.forEach(function (r) { var v = farmMath(r).verdict; if (v === 'FARM') fc.farm++; else if (v === 'THIN') fc.thin++; else fc.skip++; });
      var stats = document.querySelectorAll('.stat b');
      if (stats[3]) stats[3].textContent = fc.farm + ' FARM';
      if (stats[3] && stats[3].nextSibling) stats[3].nextSibling.textContent = fc.thin + ' thin · ' + fc.skip + ' skip';
    };
    if (dep) dep.addEventListener('input', onScenario);
    if (alloc) alloc.addEventListener('input', onScenario);
    if (farmers) farmers.addEventListener('input', onScenario);
    if (hourly) hourly.addEventListener('input', onScenario);
    if (reset) reset.addEventListener('click', function () {
      state.sc = { deposit: '', alloc: 5, farmers: 10000, hourly: 25 };
      render();
    });
  }

  function renderBoardOnly() {
    // Re-render just the board section while typing or moving a scenario control, keeping focus.
    var wrap = document.getElementById('boardwrap');
    if (!wrap) { render(); return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = boardHtml(filteredRows(), 'Ranked board');
    wrap.parentNode.replaceChild(tmp.firstChild, wrap);
  }

  window.addEventListener('hashchange', render);
  render();
})();
