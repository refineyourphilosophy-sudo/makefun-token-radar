// Token Radar dashboard: board, detail view and filters, no network.
// Reads window.RADAR from data.js (written by main.ts from the same
// board.json the gate checks), so the page and the board can never drift
// apart. Views are hash routes: "" the board, "#/p/<slug>" a protocol's
// detail, "#/f/<category>" the board filtered to one category.
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
  function mult(r) {
    return (r.implied_value_usd / r.tvl_usd).toFixed(2) + 'x';
  }

  var state = { q: '', cat: '', minTvl: 0, wl: false, sort: 'rank', dir: 1 };

  function statsHtml() {
    var h = R.holdout;
    return '<div class="stats">' +
      '<div class="stat"><b>' + R.board_size + '</b><span>protocols ranked</span></div>' +
      '<div class="stat"><b>' + R.watchlist_size + '</b><span>watchlist covered</span></div>' +
      '<div class="stat"><b>' + R.early_size + '</b><span>below the $50M floor</span></div>' +
      '<div class="stat"><b>' + R.live_size + '</b><span>already trading, set aside</span></div>' +
      '<div class="stat"><b>' + h.logR2.toFixed(2) + '</b><span>hold-out log R&sup2; (25 tokens)</span></div>' +
      '<div class="stat"><b>' + Math.round(h.mdAPE * 100) + '%</b><span>hold-out median error</span></div>' +
      '</div>';
  }

  function methodHtml() {
    var h = R.holdout;
    var f = R.fitted;
    return '<div class="method"><h3>How an implied value is computed</h3>' +
      '<p><code>log10(market cap) = ' + f.intercept.toFixed(4) + ' + ' + f.slope.toFixed(4) + ' &times; log10(TVL)</code> fitted by least squares on the ' + f.tradedCount + ' traded tokens in this snapshot, plus a shrunk category adjustment (' + f.adjustedCategories.length + ' categories, median residual &times; n/(n+8)). Then &times; a growth multiplier from the 7-day TVL change (clamped &minus;60% to +120%) and &times; a maturity multiplier from the protocol&rsquo;s age (0.6 to 1.0). The shipped fit is recomputed from the snapshot on every run — no hardcoded list of names.</p>' +
      '<p><span class="warn">Honest check:</span> on a fixed hold-out (traded tokens sorted by slug, every 5th held out: ' + h.trainCount + ' train, ' + h.testCount + ' test), the full pipeline scores log R&sup2; ' + h.logR2.toFixed(3) + ' with a median error of ' + Math.round(h.mdAPE * 100) + '% and a mean error of ' + Math.round(h.mape * 100) + '%. The fit is weak: TVL alone explains little of a token&rsquo;s market cap. Treat every implied value as a rough comps estimate, not a forecast. The model sees no tokenomics, vesting, team, revenue or user data — the snapshot carries none of it — and the traded set is survivors only. Run <code>scripts/eval-model.mjs</code> to reproduce these numbers from the snapshot.</p>' +
      '</div>';
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
    out.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'implied') d = b.implied_value_usd - a.implied_value_usd;
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'growth') d = (b.change_7d || 0) - (a.change_7d || 0);
      else if (key === 'mult') d = (b.implied_value_usd / b.tvl_usd) - (a.implied_value_usd / a.tvl_usd);
      return d * state.dir;
    });
    return out;
  }

  function boardHtml(list, title) {
    var h = '<div id="boardwrap"><h2 class="sec">' + esc(title) + ' <span class="muted small">(' + list.length + ' rows)</span></h2>';
    h += '<table><thead><tr>' +
      '<th data-sort="rank">Rank</th><th>Protocol</th><th>Category</th><th class="num" data-sort="tvl">TVL</th>' +
      '<th class="num" data-sort="growth">7d</th><th class="num" data-sort="implied">Implied value</th>' +
      '<th class="num" data-sort="mult">Value / TVL</th><th>Farm</th></tr></thead><tbody>';
    list.forEach(function (r) {
      h += '<tr><td>' + r.rank + '</td>' +
        '<td><a href="#/p/' + esc(r.slug) + '">' + esc(r.name) + '</a> ' + (r.watchlist ? '<span class="badge wl">watchlist</span>' : '') + '<br><span class="muted small">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num val">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + mult(r) + '</td>' +
        '<td><a href="#/p/' + esc(r.slug) + '">plan &rsaquo;</a></td></tr>';
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
      '<option value="implied"' + (state.sort === 'implied' ? ' selected' : '') + '>Sort: implied value</option>' +
      '<option value="tvl"' + (state.sort === 'tvl' ? ' selected' : '') + '>Sort: TVL</option>' +
      '<option value="growth"' + (state.sort === 'growth' ? ' selected' : '') + '>Sort: 7-day growth</option>' +
      '<option value="mult"' + (state.sort === 'mult' ? ' selected' : '') + '>Sort: value / TVL</option></select>' +
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
    var h = '<a class="back" href="#">&larr; Back to the board</a>' +
      '<div class="card"><h2>' + esc(r.name) + ' <span class="muted small">rank ' + r.rank + ' of ' + R.board_size + '</span></h2>' +
      '<p class="muted">' + esc(r.slug) + ' &middot; ' + esc(r.category || 'Uncategorized') + ' &middot; ' + esc(r.chains.join(', ') || 'no chain listed') + (r.watchlist ? ' &middot; <span class="badge wl">watchlist</span>' : '') + '</p>' +
      '<div class="kv"><span>TVL</span><b>' + moneyFull(r.tvl_usd) + '</b></div>' +
      '<div class="kv"><span>7-day TVL change</span><b>' + pct(r.change_7d) + '</b></div>' +
      '<div class="kv"><span>Age (tracked since ' + esc(r.listed_at || 'unknown') + ')</span><b>' + ageText(r.age_days) + '</b></div>' +
      '<div class="kv"><span>Token recorded</span><b>None — records no token</b></div>' +
      '<div class="kv"><span>Implied value if it launched a token</span><b class="val">' + moneyFull(r.implied_value_usd) + '</b></div>' +
      '<div class="kv"><span>Value / TVL</span><b>' + mult(r) + '</b></div></div>' +
      '<div class="card"><h2>How the value was computed</h2>' +
      '<div class="kv"><span>Comps base: 10^(' + R.fitted.intercept.toFixed(4) + ' + ' + R.fitted.slope.toFixed(4) + ' &times; log10 TVL' + (r.category_adjustment ? ' + ' + r.category_adjustment.toFixed(4) + ' ' + esc(r.category || '') + ' adjustment' : '') + ')</span><b>' + moneyFull(r.base_value_usd) + '</b></div>' +
      '<div class="kv"><span>Growth multiplier (7d ' + pct(r.change_7d) + ')</span><b>&times; ' + r.growth_multiplier.toFixed(2) + '</b></div>' +
      '<div class="kv"><span>Maturity multiplier (' + ageText(r.age_days) + ')</span><b>&times; ' + r.maturity_multiplier.toFixed(2) + '</b></div>' +
      '<p class="note">Base &times; growth &times; maturity, rounded to the dollar. The comps line is fitted on the ' + R.fitted.tradedCount + ' traded tokens in this snapshot; the growth and maturity multipliers are stated assumptions, not fitted parameters. See the method note below for the hold-out check.</p></div>' +
      '<div class="card"><h2>Farm plan</h2><ol class="farm">';
    r.farm_steps.forEach(function (s) {
      h += '<li>' + esc(s) + '</li>';
    });
    return h + '</ol><p class="note">Gas figures are rough estimates for one transaction on ' + esc(r.chains[0] || 'the protocol&rsquo;s main chain') + '. Costs move with the network; check before you transact. Never pay to claim an airdrop — claims come only from the protocol&rsquo;s own published link.</p></div>';
  }

  function render() {
    var hash = location.hash || '';
    var m = hash.match(/^#\/p\/(.+)$/);
    if (m) {
      var slug = decodeURIComponent(m[1]);
      var row = null;
      rows.forEach(function (r) { if (r.slug === slug) row = r; });
      if (row) {
        app.innerHTML = detailHtml(row) + methodHtml();
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
    app.innerHTML = statsHtml() + controlsHtml() + boardHtml(filteredRows(), title) + liveHtml() + methodHtml();
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
  }

  function renderBoardOnly() {
    // Re-render just the board section while typing, keeping focus in the search box.
    var wrap = document.getElementById('boardwrap');
    if (!wrap) { render(); return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = boardHtml(filteredRows(), 'Ranked board');
    wrap.parentNode.replaceChild(tmp.firstChild, wrap);
  }

  window.addEventListener('hashchange', render);
  render();
})();
