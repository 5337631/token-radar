// Token Radar dashboard. Renders window.RADAR (written by main.ts beside this
// page as data.js): the ranked board, one protocol's detail view with its farm
// plan, filters and sorting, the model panel, and the live-token comparison
// set. Plain DOM, no framework, no fetch, no network.
(function () {
  'use strict';
  var R = window.RADAR;
  var main = document.getElementById('board');
  if (!R || !main) return;

  /* ---------- formatting helpers ---------- */
  function usd(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined) return '<span class="flat">n/a</span>';
    var cls = n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30.4) + ' mo';
    return (days / 365.25).toFixed(1) + ' yrs';
  }

  /* ---------- page skeleton ---------- */
  var state = { q: '', category: 'All', chain: 'All', watchOnly: false, sort: 'implied', selected: null };

  main.innerHTML =
    '<div class="hero"><div class="brand"><div class="radar-mark" aria-hidden="true"></div><div>' +
    '<h1>Token Radar</h1>' +
    '<p class="tagline">Pre-token protocols ranked by implied value — what a launch could be worth, ' +
    'learned from the protocols that already trade — with a concrete farm plan for every row.</p>' +
    '</div></div>' +
    '<div class="asof">Snapshot ' + esc(R.as_of) + '<br>Model ' + esc(R.model_version) + ' · deterministic, offline</div></div>' +

    '<section class="stats" aria-label="Radar summary">' +
    stat(R.scanned_size, 'protocols scanned') +
    stat(R.watchlist_size + ' / ' + R.watchlist_size, 'watchlist covered') +
    stat(R.board_size, 'ranked pre-token') +
    stat(R.early_size, 'early finds below the floor') +
    stat(usd(R.total_implied_usd), 'total implied value', true) +
    stat(R.live_size, 'live tokens set aside') +
    '</section>' +

    '<section class="model" aria-label="How the value model works">' +
    '<h2>How implied value is computed</h2>' +
    '<p>The model learns its prices from this snapshot, not from a hand-kept list. For each category it takes the ' +
    'live-token protocols in that category and their median <code>market cap / TVL</code> ratio (shrunk toward the global ' +
    'median of <code>' + R.global_comp.toFixed(3) + '</code> when a category has few traded peers, clamped to ' +
    R.model.comp_floor + '–' + R.model.comp_cap + '). A pre-token protocol is then valued as:</p>' +
    '<div class="formula">implied value = TVL × category ratio × momentum × seasoning × reach</div>' +
    '<p><code>momentum</code> = 1 + clamp(7-day TVL change, ' + R.model.momentum_floor + '%…+' + R.model.momentum_cap + '%) × ' +
    R.model.momentum_weight + '. <code>seasoning</code> grows from ' + R.model.seasoning_floor + ' to ' +
    (R.model.seasoning_floor + R.model.seasoning_range).toFixed(2) + ' over ' + R.model.seasoning_days +
    ' days with no token recorded — the longer a protocol has run tokenless, the more a launch is worth today. ' +
    '<code>reach</code> adds ' + (R.model.reach_per_chain * 100) + '% per extra chain. Protocols whose token already ' +
    'trades are never ranked; they appear below at market value, as the comparison set.</p>' +
    '<div class="comps">' + R.category_comps.map(function (c) {
      return '<span class="chip">' + esc(c.category) + ' <b>×' + c.comp.toFixed(3) + '</b> · ' + c.peers + ' peers</span>';
    }).join('') + '</div>' +
    '</section>' +

    '<div class="controls" role="search">' +
    '<input type="search" id="q" placeholder="Search name or slug…" aria-label="Search protocols">' +
    '<select id="fcat" aria-label="Filter by category"><option>All</option>' +
    R.categories.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select>' +
    '<select id="fchain" aria-label="Filter by chain"><option>All</option>' +
    R.chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select>' +
    '<select id="fsort" aria-label="Sort the board">' +
    '<option value="implied">Sort: implied value</option><option value="tvl">Sort: TVL</option>' +
    '<option value="change">Sort: 7-day change</option><option value="age">Sort: longest tokenless</option></select>' +
    '<label class="toggle"><input type="checkbox" id="fwatch"> Watchlist only</label>' +
    '<button type="button" id="freset" class="reset">Reset filters</button>' +
    '<span class="count" id="count"></span></div>' +

    '<div class="table-wrap"><table aria-label="Ranked board"><thead><tr>' +
    '<th>#</th><th>Protocol</th><th>Category</th><th class="hide-s">Chains</th>' +
    '<th class="num">TVL</th><th class="num">7d</th><th class="num">Implied value</th><th>Signals</th>' +
    '</tr></thead><tbody id="rows"></tbody></table></div>' +

    '<section class="detail" id="detail" aria-label="Protocol detail"></section>' +

    '<section class="live"><h2>Already trading — the comparison set</h2>' +
    '<p>These protocols record a token, so the radar does not rank or value them. They are shown at the market\u2019s ' +
    'own figures — and they are the peers each category ratio above was learned from.</p>' +
    '<div class="table-wrap"><table aria-label="Live token protocols"><thead><tr>' +
    '<th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">MCap / TVL</th><th class="num">7d</th>' +
    '</tr></thead><tbody>' +
    R.live.map(function (p) {
      return '<tr><td><span class="pname">' + esc(p.name) + '</span></td><td class="cat">' + esc(p.category || '—') +
        '</td><td class="num">' + usd(p.tvl_usd) + '</td><td class="num">' + usd(p.mcap_usd) +
        '</td><td class="num">' + (p.mcap_tvl === null ? '—' : '×' + p.mcap_tvl.toFixed(3)) +
        '</td><td class="num">' + pct(p.change_7d) + '</td></tr>';
    }).join('') +
    '</tbody></table></div></section>' +

    '<footer>Implied value is this radar\u2019s own estimate from the snapshot\u2019s figures; it is not a prediction ' +
    'that a token will be issued. "Records no token" describes the snapshot\u2019s record, not a guarantee. ' +
    'Farm plans are checklists, not financial advice — verify every step in the protocol\u2019s own app.</footer>';

  function stat(v, label, hot) {
    return '<div class="stat' + (hot ? ' hot' : '') + '"><b>' + v + '</b><span>' + label + '</span></div>';
  }

  /* ---------- board rendering ---------- */
  var rowsEl = document.getElementById('rows');
  var countEl = document.getElementById('count');

  function visibleRows() {
    var out = R.rows.filter(function (r) {
      if (state.watchOnly && !r.on_watchlist) return false;
      if (state.category !== 'All' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'All' && r.chains.indexOf(state.chain) === -1) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      }
      return true;
    });
    var by = {
      implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      change: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
    }[state.sort];
    return out.sort(by);
  }

  function tagHtml(r) {
    return r.tags.map(function (t) {
      var cls = t === 'Watchlist' ? 'tag hot' : t === 'Cooling' ? 'tag warn' : 'tag';
      return '<span class="' + cls + '">' + esc(t) + '</span>';
    }).join('');
  }

  function renderBoard() {
    var rows = visibleRows();
    countEl.textContent = rows.length + ' of ' + R.board_size + ' protocols';
    rowsEl.innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span><br><span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="chains hide-s">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + usd(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num implied">' + usd(r.implied_value_usd) + '</td>' +
        '<td>' + tagHtml(r) + '</td></tr>';
    }).join('');
    var trs = rowsEl.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () { select(this.getAttribute('data-slug'), true); });
    }
  }

  /* ---------- detail view ---------- */
  var detailEl = document.getElementById('detail');
  function factor(label, value, widthPct, note) {
    return '<div class="factor"><span>' + label + '</span><span class="bar"><i style="width:' +
      Math.max(3, Math.min(100, widthPct)) + '%"></i></span><span class="val">' + value + '</span></div>' +
      (note ? '' : '');
  }
  function select(slug, scroll) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) r = R.rows[i];
    if (!r) return;
    state.selected = slug;
    renderBoard();
    var m = r.model;
    detailEl.innerHTML =
      '<h2>#' + r.rank + ' · ' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || 'chain not recorded') +
      ' · records no token in the snapshot' + (r.on_watchlist ? ' · on the watchlist' : ' · early find below the watchlist floor') + '</p>' +
      '<div class="dgrid">' +
      '<div class="stat"><b>' + usd(r.implied_value_usd) + '</b><span>implied value</span></div>' +
      '<div class="stat"><b>' + usd(r.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div class="stat"><b>' + ageLabel(r.age_days) + '</b><span>running tokenless</span></div>' +
      '<div class="stat"><b>' + (r.change_7d === null ? 'n/a' : r.change_7d.toFixed(1) + '%') + '</b><span>TVL change, 7d</span></div>' +
      '<div class="stat"><b>×' + m.category_comp.toFixed(3) + '</b><span>category ratio (' + m.comp_peers + ' peers)</span></div>' +
      '</div>' +
      '<h3>Why this value — the factors</h3><div class="factors">' +
      factor('Category ratio', '×' + m.category_comp.toFixed(3), (m.category_comp / R.model.comp_cap) * 100) +
      factor('Momentum (7d ' + m.momentum_pct.toFixed(1) + '%)', '×' + m.momentum_multiplier.toFixed(3), ((m.momentum_multiplier - 0.55) / 1.0) * 100) +
      factor('Seasoning (' + ageLabel(r.age_days) + ' tokenless)', '×' + m.seasoning_multiplier.toFixed(3), ((m.seasoning_multiplier - 0.7) / 0.45) * 100) +
      factor('Reach (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')', '×' + m.reach_multiplier.toFixed(3), ((m.reach_multiplier - 1) / 0.22) * 100) +
      '</div>' +
      '<h3>Farm plan — ' + r.farm_steps.length + ' steps</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    if (scroll) detailEl.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- controls ---------- */
  document.getElementById('q').addEventListener('input', function () { state.q = this.value.trim(); renderBoard(); });
  document.getElementById('fcat').addEventListener('change', function () { state.category = this.value; renderBoard(); });
  document.getElementById('fchain').addEventListener('change', function () { state.chain = this.value; renderBoard(); });
  document.getElementById('fsort').addEventListener('change', function () { state.sort = this.value; renderBoard(); });
  document.getElementById('fwatch').addEventListener('change', function () { state.watchOnly = this.checked; renderBoard(); });
  document.getElementById('freset').addEventListener('click', function () {
    state = { q: '', category: 'All', chain: 'All', watchOnly: false, sort: 'implied', selected: state.selected };
    document.getElementById('q').value = '';
    document.getElementById('fcat').value = 'All';
    document.getElementById('fchain').value = 'All';
    document.getElementById('fsort').value = 'implied';
    document.getElementById('fwatch').checked = false;
    renderBoard();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
      e.preventDefault();
      document.getElementById('q').focus();
    }
  });

  renderBoard();
  if (R.rows.length > 0) select(R.rows[0].slug, false);
  main.setAttribute('aria-busy', 'false');
})();
