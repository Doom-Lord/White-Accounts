/* White Accounts historical archive and customer analysis.
   Archive records are read-only and never participate in live balance calculations. */
(function () {
  'use strict';
  var getDB, saveDB, toast;
  var $ = function (id) { return document.getElementById(id); };
  function safe(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function norm(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function litres(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', {maximumFractionDigits: 2}); }
  function rupees(n) { return '₹' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-IN', {maximumFractionDigits: 2}); }
  function knownAmount(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0; }
  function label(ym) {
    var parts = ym.split('-');
    var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return names[Number(parts[1]) - 1] + ' ' + parts[0];
  }
  function followingMonth(ym) {
    var parts = ym.split('-').map(Number);
    var d = new Date(parts[0], parts[1], 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function validYM(ym) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym); }
  function sumDays(days) {
    return Object.keys(days || {}).reduce(function (total, d) {
      return total + (Number(days[d]) || 0);
    }, 0);
  }
  function mergeDays(into, other) {
    Object.keys(other || {}).forEach(function (d) {
      var v = Number(other[d]);
      if (Number.isFinite(v)) into[d] = (into[d] || 0) + v;
    });
  }
  function validateArchive(file) {
    if (!file || file.format !== 'white-accounts-historical-archive' ||
        file.version !== 1 || !file.archive) throw new Error('Not a White Accounts historical archive JSON file.');
    var a = file.archive;
    if (a.schemaVersion !== 1 || !Array.isArray(a.customers) || !a.customers.length ||
        !a.months || typeof a.months !== 'object' || Array.isArray(a.months)) {
      throw new Error('Archive structure is missing or incompatible.');
    }
    var ids = new Set();
    a.customers.forEach(function (c) {
      if (!c || typeof c.id !== 'string' || !c.id || !String(c.name || '').trim() || ids.has(c.id)) {
        throw new Error('Invalid or repeated customer in archive.');
      }
      ids.add(c.id);
    });
    Object.keys(a.months).forEach(function (ym) {
      var month = a.months[ym];
      if (!validYM(ym) || !month || !month.buyers || typeof month.buyers !== 'object' ||
          Array.isArray(month.buyers)) throw new Error('Invalid archive month ' + ym);
      var p = ym.split('-').map(Number);
      var maxDay = new Date(p[0], p[1], 0).getDate();
      Object.keys(month.buyers).forEach(function (id) {
        var record = month.buyers[id];
        if (!ids.has(id) || !record || !record.days || typeof record.days !== 'object' ||
            Array.isArray(record.days)) throw new Error('Invalid customer record in ' + ym);
        Object.keys(record.days).forEach(function (d) {
          var n = Number(record.days[d]);
          if (!/^[1-9]\d?$/.test(d) || Number(d) > maxDay || !Number.isFinite(n) || n < 0) {
            throw new Error('Invalid milk quantity/date in ' + ym);
          }
        });
        if (!Number.isFinite(Number(record.litres)) ||
            Math.abs(Number(record.litres) - sumDays(record.days)) > 0.011) {
          throw new Error('Archive totals do not match daily entries in ' + ym);
        }
      });
    });
    return a;
  }
  function collect(db) {
    var groups = Object.create(null);
    var lookup = Object.create(null);
    var months = Object.create(null);
    var archive = db.archive || {};
    (archive.customers || []).forEach(function (c) {
      var key = 'h:' + c.id;
      groups[key] = c.name;
      [c.name].concat(c.aliases || []).forEach(function (n) { lookup[norm(n)] = key; });
    });
    (db.buyers || []).forEach(function (b) {
      var key = lookup[norm(b.name)] || 'l:' + norm(b.name);
      if (!groups[key]) groups[key] = b.name;
    });
    Object.keys(archive.months || {}).forEach(function (ym) {
      var slot = months[ym] = months[ym] || Object.create(null);
      Object.keys(archive.months[ym].buyers || {}).forEach(function (id) {
        var record = archive.months[ym].buyers[id];
        var key = 'h:' + id;
        if (!groups[key]) return;
        // Use the historical billed sales amount, not NET or a payment/balance figure.
        // A customer may have different milk types and rates in the same month.
        slot[key] = {
          days:Object.assign({}, record.days || {}),
          source:'archive',
          billed: knownAmount(record.salesAmount) ? Number(record.salesAmount) : null
        };
      });
    });
    var buyersById = Object.create(null);
    (db.buyers || []).forEach(function (b) { buyersById[b.id] = b; });
    Object.keys(db.months || {}).forEach(function (ym) {
      if (!validYM(ym)) return;
      var slot = months[ym] = months[ym] || Object.create(null);
      Object.keys((db.months[ym] || {}).buyers || {}).forEach(function (id) {
        var buyer = buyersById[id];
        if (!buyer) return;
        var key = lookup[norm(buyer.name)] || 'l:' + norm(buyer.name);
        // The archive is authoritative in archived months; avoid double-counting duplicates.
        if (slot[key] && slot[key].source === 'archive') return;
        if (!slot[key]) slot[key] = {days:{},source:'live',billed:0};
        var liveRecord = db.months[ym].buyers[id];
        mergeDays(slot[key].days, liveRecord.days || {});
        // Sum each live buyer entry separately so different monthly rates are respected.
        if (slot[key].billed !== null) {
          if (knownAmount(liveRecord.rate)) slot[key].billed += sumDays(liveRecord.days) * Number(liveRecord.rate);
          else slot[key].billed = null;
        }
      });
    });
    return {groups:groups, months:months};
  }
  function render() {
    if (!$('analysisBuyer') || !getDB) return;
    var db = getDB(), data = collect(db), picker = $('analysisBuyer');
    var old = picker.value || '';
    var options = ['<option value="">All customers</option>'];
    Object.keys(data.groups).sort(function (a, b) {
      return data.groups[a].localeCompare(data.groups[b], 'hi');
    }).forEach(function (k) {
      options.push('<option value="' + safe(k) + '">' + safe(data.groups[k]) + '</option>');
    });
    picker.innerHTML = options.join('');
    if (Object.prototype.hasOwnProperty.call(data.groups, old)) picker.value = old;
    var selected = picker.value;
    var custom = $('analysisRangeMode').value === 'custom';
    $('analysisCustomRange').hidden = !custom;
    var from = custom ? $('analysisFrom').value : '';
    var to = custom ? $('analysisTo').value : '';
    var out = $('analysisResults');
    if ((from && !validYM(from)) || (to && !validYM(to)) || (from && to && from > to)) {
      out.innerHTML = '<p class="mk-warn-box">Select a valid date range (From must be before or equal to To).</p>';
      return;
    }
    var rows = [];
    var now = new Date();
    var todayMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    Object.keys(data.months).sort().forEach(function (ym) {
      if ((!custom && ym > todayMonth) || (from && ym < from) || (to && ym > to)) return;
      var cells = data.months[ym], days = {}, source = '', billed = 0, missingBill = false;
      if (selected) {
        if (!cells[selected]) return;
        mergeDays(days, cells[selected].days);
        source = cells[selected].source;
        if (cells[selected].billed === null) missingBill = true;
        else billed = cells[selected].billed;
      } else {
        Object.keys(cells).forEach(function (k) {
          mergeDays(days, cells[k].days);
          if (cells[k].billed === null) missingBill = true;
          else billed += cells[k].billed;
          if (cells[k].source === 'archive') source = source === 'live' ? 'mixed' : 'archive';
          else source = source === 'archive' ? 'mixed' : 'live';
        });
      }
      rows.push({ym:ym, days:days, qty:sumDays(days), billed:missingBill ? null : billed, source:source});
    });
    var total = rows.reduce(function (s, r) { return s + r.qty; }, 0);
    var amountsComplete = rows.every(function (r) { return r.billed !== null; });
    var totalBilled = rows.reduce(function (s, r) { return s + (r.billed || 0); }, 0);
    var active = rows.filter(function (r) { return r.qty > 0; });
    var positiveDays = rows.reduce(function (s,r) {
      return s + Object.keys(r.days).filter(function (day) { return r.days[day] > 0; }).length;
    }, 0);
    var archiveCount = Object.keys((db.archive || {}).months || {}).length;
    var text = '<div class="mk-analysis-kpis">' +
      '<div><small>Total milk purchased</small><strong>' + litres(total) + ' L</strong></div>' +
      '<div><small>Total billed (not paid)</small><strong>' + (amountsComplete ? rupees(totalBilled) : '—') + '</strong></div>' +
      '<div><small>Months with purchases</small><strong>' + active.length + '</strong></div>' +
      '<div><small>Days with milk</small><strong>' + positiveDays + '</strong></div>' +
      '<div><small>Average per purchase month</small><strong>' + litres(active.length ? total / active.length : 0) + ' L</strong></div>' +
      '</div>';
    text += '<p class="mk-tip">Billed amount is the value of milk sold in the delivery month, not money received. Historical figures use the original spreadsheet sales amounts; current entries use litres × that month’s rate. Payment is usually collected the following month.</p>';
    if (!amountsComplete) text += '<p class="mk-warn-box">Some months are missing billed amounts or monthly rates. Their billed amounts are shown as unavailable rather than guessed.</p>';
    text += '<p class="mk-tip">Historical archive: ' + archiveCount + ' month(s). Live Entry records are included without duplicating a matching archived customer/month.</p>';
    if (!rows.length) {
      out.innerHTML = text + '<div class="mk-placeholder">No milk records found for this selection. Import an archive in Settings or enter milk in Entry.</div>';
      return;
    }
    var max = Math.max.apply(null, rows.map(function (r) { return r.qty; }).concat([1]));
    text += '<div class="mk-grid-scroll mk-analysis-scroll"><table class="mk-ledger-table mk-analysis-table"><thead>' +
      '<tr><th>Milk month</th><th>Litres</th><th>Billed (₹)</th><th>Volume</th><th>Usual collection month</th><th>Source</th><th>Daily records</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var dayCells = Object.keys(r.days).sort(function (a,b) { return Number(a) - Number(b); })
        .map(function (day) { return '<span>' + day + ': <b>' + litres(r.days[day]) + ' L</b></span>'; }).join('');
      text += '<tr><td>' + label(r.ym) + '</td>' +
        '<td><b>' + litres(r.qty) + '</b></td>' +
        '<td><b>' + (r.billed === null ? '—' : rupees(r.billed)) + '</b></td>' +
        '<td><div class="mk-analysis-bar" style="width:' + Math.round(100 * r.qty / max) + '%"></div></td>' +
        '<td>' + label(followingMonth(r.ym)) + '</td>' +
        '<td>' + (r.source === 'archive' ? 'Archive' : r.source === 'mixed' ? 'Archive + live' : 'Live') + '</td>' +
        '<td><details><summary>View dates</summary><div class="mk-analysis-days">' +
        (dayCells || 'No individual dates recorded') + '</div></details></td></tr>';
    });
    text += '</tbody></table></div>';
    out.innerHTML = text;
  }
  function init(config) {
    getDB = config.getDB;
    saveDB = config.saveDB;
    toast = config.toast;
    ['analysisBuyer','analysisRangeMode','analysisFrom','analysisTo'].forEach(function (id) {
      $(id).addEventListener('change', render);
    });
    $('archiveImportBtn').addEventListener('click', function () { $('archiveImportFile').click(); });
    $('archiveImportFile').addEventListener('change', function (event) {
      var input = event.target, file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var archive = validateArchive(parsed);
          var count = Object.keys(archive.months).length;
          var message = 'Import ' + count + ' historical months and ' + archive.customers.length +
            ' customers as a read-only archive? Existing Entry, Buyers, Ledger, Receipts and current balances will NOT be changed.';
          if (getDB().archive && Object.keys(getDB().archive.months || {}).length) {
            message += '\n\nThis will REPLACE the existing historical archive. Export a JSON backup first.';
          }
          if (!window.confirm(message)) return;
          var db = getDB(), previous = db.archive;
          db.archive = archive;
          try { saveDB(); }
          catch (e) {
            db.archive = previous;
            throw new Error('Could not save archive in this browser. Export a backup and check storage space.');
          }
          render();
          toast('Historical archive imported. Live billing is unchanged.');
        } catch (err) { window.alert('Archive import failed: ' + err.message); }
        finally { input.value = ''; }
      };
      reader.onerror = function () {
        window.alert('Could not read the selected archive file.');
        input.value = '';
      };
      reader.readAsText(file);
    });
    render();
  }
  window.WhiteAccountsAnalysis = {init:init, render:render};
})();