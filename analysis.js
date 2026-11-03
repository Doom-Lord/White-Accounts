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
  // Build a portable archive from the imported history and all manually closed
  // Entry months. No live/open month is exported as historical.
  function historicalArchiveForExport(db) {
    var existing = db.archive || {};
    var archive = {
      schemaVersion: 1,
      customers: JSON.parse(JSON.stringify(existing.customers || [])),
      months: JSON.parse(JSON.stringify(existing.months || {}))
    };
    var ids = new Set(archive.customers.map(function (c) { return c.id; }));
    var byName = Object.create(null);
    archive.customers.forEach(function (c) {
      [c.name].concat(c.aliases || []).forEach(function (n) { byName[norm(n)] = c.id; });
    });
    var buyers = Object.create(null);
    (db.buyers || []).forEach(function (b) { buyers[b.id] = b; });

    Object.keys(db.closedMonths || {}).sort().forEach(function (ym) {
      if (!db.closedMonths[ym] || !validYM(ym) || !db.months || !db.months[ym]) return;
      var month = archive.months[ym] || {buyers:{}};
      if (!month.buyers) month.buyers = {};
      Object.keys(db.months[ym].buyers || {}).forEach(function (bid) {
        var buyer = buyers[bid], entry = db.months[ym].buyers[bid];
        if (!buyer || !entry || !entry.days || !Object.keys(entry.days).length) return;
        var id = byName[norm(buyer.name)];
        if (!id) {
          id = 'closed-' + bid;
          while (ids.has(id)) id += '-copy';
          ids.add(id);
          byName[norm(buyer.name)] = id;
          archive.customers.push({id:id, name:buyer.name, aliases:[]});
        }
        // Imported historical archive wins if this customer-month already exists.
        if (month.buyers[id]) return;
        var days = Object.assign({}, entry.days);
        var qty = sumDays(days);
        var rate = knownAmount(entry.rate) ? Number(entry.rate) : null;
        month.buyers[id] = {
          days: days,
          litres: qty,
          rate: rate,
          salesAmount: rate === null ? null : Math.round(qty * rate * 100) / 100,
          source: 'closed-month'
        };
      });
      if (Object.keys(month.buyers).length) archive.months[ym] = month;
    });
    return archive;
  }
  function downloadFile(content, name, type) {
    var url = URL.createObjectURL(new Blob([content], {type:type}));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvField(value) {
    var s = String(value == null ? '' : value);
    // Prevent spreadsheet formula execution in customer names.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportHistoricalJSON() {
    var archive = historicalArchiveForExport(getDB());
    if (!Object.keys(archive.months).length) {
      toast('No archived months to export');
      return;
    }
    // Same format as Settings -> Import historical archive.
    downloadFile(JSON.stringify({
      format:'white-accounts-historical-archive',
      version:1,
      archive:archive
    }, null, 2), 'white-accounts-historical-archive.json', 'application/json');
    toast('Historical archive JSON downloaded ✅');
  }
  function exportHistoricalCSV() {
    var archive = historicalArchiveForExport(getDB());
    if (!Object.keys(archive.months).length) {
      toast('No archived months to export');
      return;
    }
    var names = Object.create(null);
    archive.customers.forEach(function (c) { names[c.id] = c.name; });
    var headings = ['Milk month','Usual collection month','Customer','Litres','Rate (INR/L)','Billed amount (INR)','Source'];
    for (var d = 1; d <= 31; d++) headings.push('Day ' + d);
    var rows = [headings.map(csvField).join(',')];
    Object.keys(archive.months).sort().forEach(function (ym) {
      Object.keys(archive.months[ym].buyers || {}).sort(function (a,b) {
        return String(names[a] || '').localeCompare(String(names[b] || ''), 'hi');
      }).forEach(function (id) {
        var rec = archive.months[ym].buyers[id], cols = [
          ym, followingMonth(ym), names[id] || id, rec.litres,
          rec.rate, rec.salesAmount, rec.source || 'historical-import'
        ];
        for (var day=1; day<=31; day++) {
          cols.push(Object.prototype.hasOwnProperty.call(rec.days || {}, String(day))
            ? rec.days[String(day)] : '');
        }
        rows.push(cols.map(csvField).join(','));
      });
    });
    downloadFile('\uFEFF' + rows.join('\r\n'), 'white-accounts-historical-archive.csv', 'text/csv;charset=utf-8');
    toast('Historical CSV downloaded ✅');
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
        if (!slot[key]) slot[key] = {days:{},source:(db.closedMonths && db.closedMonths[ym]) ? 'archive' : 'live',billed:0};
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
  // Populate real month selectors instead of leaving unsupported browser month fields blank.
  // Include months between the first and last recorded month, even if some are empty.
  function populateMonthRange(data, selected) {
    var now = new Date();
    var todayMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var recorded = Object.keys(data.months).filter(function (ym) {
      if (!validYM(ym) || ym > todayMonth) return false;
      var entries = data.months[ym];
      if (selected) {
        return !!(entries[selected] && Object.keys(entries[selected].days || {}).length);
      }
      return Object.keys(entries).some(function (id) {
        return Object.keys(entries[id].days || {}).length > 0;
      });
    }).sort();
    if (!recorded.length) recorded = [todayMonth];
    var first = recorded[0], last = recorded[recorded.length - 1];
    var parts = first.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, 1);
    var months = [];
    while (months.length < 1200) {
      var ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (ym > last) break;
      months.push(ym);
      d.setMonth(d.getMonth() + 1);
    }
    var markup = months.map(function (ym) {
      return '<option value="' + ym + '">' + label(ym) + '</option>';
    }).join('');
    var fromSelect = $('analysisFrom'), toSelect = $('analysisTo');
    var oldFrom = fromSelect.value, oldTo = toSelect.value;
    fromSelect.innerHTML = markup;
    toSelect.innerHTML = markup;
    fromSelect.value = months.indexOf(oldFrom) >= 0 ? oldFrom : first;
    toSelect.value = months.indexOf(oldTo) >= 0 ? oldTo : last;
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
    populateMonthRange(data, selected);
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
    var archiveCount = new Set(Object.keys((db.archive || {}).months || {}).concat(
      Object.keys(db.closedMonths || {}).filter(function (ym) { return !!db.closedMonths[ym] && !!(db.months || {})[ym]; })
    )).size;
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
    $('archiveExportBtn').addEventListener('click', exportHistoricalJSON);
    $('archiveCsvBtn').addEventListener('click', exportHistoricalCSV);
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