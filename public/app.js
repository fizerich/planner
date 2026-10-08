(function () {
  'use strict';

  const STATUS = {
    overdue: { key: 'overdue', label: 'Overdue', fg: '#E5697A', bg: '#2B1619' },
    critical: { key: 'critical', label: 'Due soon', fg: '#D9A454', bg: '#2B2113' },
    warning: { key: 'warning', label: 'Upcoming', fg: '#C9B968', bg: '#262310' },
    ok: { key: 'ok', label: 'Active', fg: '#4CB782', bg: '#132A1F' },
  };
  const ACCENT_OPTIONS = ['#5E6AD2', '#4A9B9B', '#BD7295', '#C08B4A'];
  const VIEWS = [
    ['dashboard', 'Dashboard'],
    ['calendar', 'Calendar'],
    ['licenses', 'Licenses & Permits'],
    ['todo', 'To-Do'],
    ['reminders', 'Reminders'],
    ['settings', 'Settings'],
  ];

  function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

  function computeStatus(expiryStr) {
    if (!expiryStr) return { daysLeft: 9999, ...STATUS.ok };
    const expiry = new Date(expiryStr + 'T00:00:00');
    const daysLeft = Math.round((expiry - startOfToday()) / 86400000);
    let key = 'ok';
    if (daysLeft < 0) key = 'overdue';
    else if (daysLeft <= 14) key = 'critical';
    else if (daysLeft <= 30) key = 'warning';
    return { daysLeft, ...STATUS[key] };
  }

  function fmtDate(s) {
    if (!s) return '';
    return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function daysText(d) {
    if (d < 0) return Math.abs(d) + 'd overdue';
    if (d === 0) return 'Due today';
    return d + 'd left';
  }

  function chipStyle(s) { return 'color:' + s.fg + ';background:' + s.bg; }

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  }

  let state = null;
  const ui = {
    activeView: 'dashboard',
    isMobile: window.innerWidth < 880,
    sidebarOpen: false,
    licenseFilterClinic: 'all',
    licenseFilterStatus: 'all',
    todoFilterClinic: 'all',
    calendarFilterClinic: 'all',
    calendarMonthOffset: 0,
    newLicense: { clinicId: '', typeId: '', expiry: '', notes: '' },
    newTodo: { text: '', clinicId: '', dueDate: '' },
    newClinicName: '',
    newClinicCode: '',
    newLicenseTypeName: '',
    newThreshold: { amount: '', unit: 'days' },
    toast: null,
    busyTest: false,
    busyPushTest: false,
    sheetBusy: false,
    pushPermission: (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported',
    pushSubscribed: false,
    pushBusy: false,
    activityExpanded: false,
    quickAdd: null,
    quickAddForm: { text: '', dueDate: '', typeId: '', expiry: '' },
  };

  function setNested(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }

  function getNested(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  function showToast(type, text, ms) {
    ui.toast = { type, text };
    render();
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { ui.toast = null; render(); }, ms || 4500);
  }

  function applyThemeVars() {
    document.documentElement.style.setProperty('--accent', state.settings.accentColor);
    document.documentElement.setAttribute('data-theme', state.settings.themeMode || 'dark');
  }

  async function refresh() {
    state = await api('GET', '/api/state');
    applyThemeVars();
  }

  async function mutate(fn) {
    try {
      const result = await fn();
      if (result && result.state) state = result.state;
      else if (result) state = result;
      applyThemeVars();
      render();
      return result;
    } catch (err) {
      showToast('error', err.message || 'Something went wrong.');
      throw err;
    }
  }

  // ---------- derived data ----------
  function enrichLicense(l) {
    const clinic = state.clinics.find((c) => c.id === l.clinicId) || { code: '?', name: 'Unknown' };
    const st = computeStatus(l.expiry);
    return {
      ...l,
      clinicCode: clinic.code,
      clinicName: clinic.name,
      expiryLabel: fmtDate(l.expiry),
      daysLeft: st.daysLeft,
      daysLabel: daysText(st.daysLeft),
      statusLabel: st.label,
      statusStyle: chipStyle(st),
      statusKey: st.key,
    };
  }

  function allEnrichedLicenses() {
    return state.licenses.map(enrichLicense).sort((a, b) => a.daysLeft - b.daysLeft);
  }

  function clinicPillList(currentId, filterKey) {
    return [{ id: 'all', code: 'All' }, ...state.clinics].map((c) => ({
      id: c.id,
      label: c.code,
      active: currentId === c.id,
      action: filterKey,
    }));
  }

  function buildCalendarCells(monthOffset, filterClinic) {
    const today = startOfToday();
    const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const year = base.getFullYear(), month = base.getMonth();
    const startWeekday = base.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const cells = [];
    for (let i = startWeekday - 1; i >= 0; i--) {
      cells.push({ dayNum: prevMonthDays - i, bg: 'var(--calendar-dim-bg)', dayColor: 'var(--calendar-dim-text)', dayWeight: 500, events: [], hasMore: false, moreCount: 0 });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(year, month, d);
      const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const isToday = dateObj.toDateString() === new Date().toDateString();
      const events = [];
      state.licenses.forEach((l) => {
        if ((filterClinic === 'all' || l.clinicId === filterClinic) && l.expiry === dateStr) {
          const st = computeStatus(l.expiry);
          events.push({ label: l.type, style: chipStyle(st) });
        }
      });
      state.todos.forEach((t) => {
        if (t.dueDate && (filterClinic === 'all' || t.clinicId === filterClinic) && t.dueDate === dateStr) {
          events.push({ label: t.text, style: 'color:var(--text-secondary);background:var(--surface-alt)' });
        }
      });
      cells.push({
        dayNum: d,
        bg: isToday ? 'var(--calendar-today-bg)' : 'var(--surface)',
        dayColor: isToday ? 'var(--accent)' : 'var(--text-primary)',
        dayWeight: isToday ? 700 : 500,
        events: events.slice(0, 2),
        hasMore: events.length > 2,
        moreCount: Math.max(0, events.length - 2),
      });
    }
    let next = 1;
    while (cells.length < 42) {
      cells.push({ dayNum: next, bg: 'var(--calendar-dim-bg)', dayColor: 'var(--calendar-dim-text)', dayWeight: 500, events: [], hasMore: false, moreCount: 0 });
      next++;
    }
    return { cells, monthLabel: base.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) };
  }

  // ---------- render ----------
  function pillBtn({ label, active, action, id }) {
    return `<button class="pill-btn ${active ? 'pill-active' : 'pill-inactive'}" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
  }

  // Inline quick-add panel shown inside a dashboard section when its "+" button
  // is clicked, so the owner can add a to-do/license straight into that clinic's
  // column without going through the full-page form and picking a clinic.
  function quickAddPanel(clinicId, section) {
    const qa = ui.quickAdd;
    if (!qa || qa.clinicId !== clinicId || qa.section !== section) return '';

    if (qa.kind === 'todo') {
      return `
        <div class="quick-add-form">
          <input class="field" type="text" placeholder="New task..." value="${esc(ui.quickAddForm.text)}" data-action="set-quick-todo-text" autofocus />
          <input class="field" type="date" value="${esc(ui.quickAddForm.dueDate)}" data-action="set-quick-todo-date" />
          <div class="quick-add-actions">
            <button class="pill-btn pill-outline" data-action="close-quick-add">Cancel</button>
            <button class="pill-btn pill-accent" data-action="submit-quick-todo">Add</button>
          </div>
        </div>`;
    }
    return `
      <div class="quick-add-form">
        <select class="field" data-action="set-quick-license-type">
          ${state.licenseTypes.map((lt) => `<option value="${lt.id}" ${ui.quickAddForm.typeId === lt.id ? 'selected' : ''}>${esc(lt.name)}</option>`).join('')}
        </select>
        <input class="field" type="date" value="${esc(ui.quickAddForm.expiry)}" data-action="set-quick-license-expiry" />
        <div class="quick-add-actions">
          <button class="pill-btn pill-outline" data-action="close-quick-add">Cancel</button>
          <button class="pill-btn pill-accent" data-action="submit-quick-license">Add</button>
        </div>
      </div>`;
  }

  function logoMarkup(size) {
    return `<img src="./icon.svg" width="${size}" height="${size}" style="border-radius:${Math.round(size * 0.22)}px;flex-shrink:0" alt="" />
      <span style="font:800 ${Math.round(size * 0.68)}px 'Manrope';letter-spacing:-0.025em">
        <span style="color:var(--text-primary)">Super</span><span style="color:var(--accent)">Planner</span>
      </span>`;
  }

  function render() {
    const s = state;
    const root = document.getElementById('app');
    const showBackdrop = ui.isMobile && ui.sidebarOpen;

    root.innerHTML = `
      ${showBackdrop ? '<div class="backdrop" data-action="close-sidebar"></div>' : ''}
      <div class="sidebar ${ui.isMobile ? 'mobile' : ''} ${ui.isMobile && ui.sidebarOpen ? 'open' : ''}">
        <div class="sidebar-logo">${logoMarkup(26)}</div>
        ${VIEWS.map(([key, label]) => `<div class="navitem ${ui.activeView === key ? 'active' : 'inactive'}" data-action="nav" data-id="${key}">${esc(label)}</div>`).join('')}
        <div class="sidebar-footer">${s.clinics.length} clinics<br/>Owner: ${esc(s.ownerPhone)}</div>
      </div>
      <div class="main-col">
        ${ui.isMobile ? `
          <div class="mobile-topbar">
            <button class="hamburger-btn" data-action="toggle-sidebar">&#9776;</button>
            <div class="mobile-topbar-title">${logoMarkup(24)}</div>
          </div>` : ''}
        ${renderView()}
      </div>
    `;
  }

  function renderView() {
    switch (ui.activeView) {
      case 'dashboard': return renderDashboard();
      case 'calendar': return renderCalendar();
      case 'licenses': return renderLicenses();
      case 'todo': return renderTodo();
      case 'reminders': return renderReminders();
      case 'settings': return renderSettings();
      default: return '';
    }
  }

  function renderDashboard() {
    const s = state;
    const enriched = allEnrichedLicenses();
    const overdueCount = enriched.filter((l) => l.statusKey === 'overdue').length;
    const criticalCount = enriched.filter((l) => l.statusKey === 'critical').length;
    const openTodoCount = s.todos.filter((t) => !t.done).length;
    const layout = s.settings.dashboardLayout;

    const header = `
      <div class="view-header">
        <div>
          <div class="view-title">Dashboard</div>
          <div class="view-subtitle">${s.clinics.length} clinics &middot; ${s.licenses.length} licenses tracked</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="chip" style="${chipStyle(STATUS.overdue)}">${overdueCount} overdue</span>
          <span class="chip" style="${chipStyle(STATUS.critical)}">${criticalCount} due soon</span>
          <span class="chip" style="color:var(--text-secondary);background:var(--surface-alt)">${openTodoCount} open to-dos</span>
          <div class="layout-toggle">
            ${pillBtn({ label: 'Columns', active: layout === 'columns', action: 'set-layout', id: 'columns' })}
            ${pillBtn({ label: 'List', active: layout === 'list', action: 'set-layout', id: 'list' })}
          </div>
        </div>
      </div>`;

    if (layout === 'columns') {
      const sectionOrder = (s.settings.dashboardSectionOrder && s.settings.dashboardSectionOrder.length === 3)
        ? s.settings.dashboardSectionOrder : ['events', 'todo', 'licenses'];
      const sectionLabels = { events: 'Upcoming events', todo: 'To-do', licenses: 'Licenses' };

      const columns = s.clinics.map((c) => {
        const items = enriched.filter((l) => l.clinicId === c.id);
        const todos = s.todos.filter((t) => t.clinicId === c.id);
        const worstKey = items.some((l) => l.statusKey === 'overdue') ? 'overdue'
          : items.some((l) => l.statusKey === 'critical') ? 'critical'
          : items.some((l) => l.statusKey === 'warning') ? 'warning' : 'ok';

        // "Upcoming events" is to-do due dates only — license expiries already
        // have their own soonest-first panel, so they don't need to show twice.
        const upcoming = todos.filter((t) => t.dueDate && !t.done).map((t) => {
          const st = computeStatus(t.dueDate);
          return { label: t.text, dateLabel: fmtDate(t.dueDate), daysLeft: st.daysLeft, daysLabel: daysText(st.daysLeft), style: chipStyle(st) };
        }).sort((a, b) => a.daysLeft - b.daysLeft);

        const sectionBody = {
          events: upcoming.map((ev) => `
                  <div class="license-item">
                    <div class="license-item-top">
                      <div class="license-item-type">${esc(ev.label)}</div>
                      <span class="chip" style="${ev.style}">${ev.daysLabel}</span>
                    </div>
                    <div class="license-item-meta">${ev.dateLabel}</div>
                  </div>`).join('') || '<div class="empty-note">Nothing upcoming</div>',
          todo: todos.map((t) => `
                  <label class="todo-row" style="opacity:${t.done ? 0.5 : 1}">
                    <input type="checkbox" ${t.done ? 'checked' : ''} data-action="toggle-todo" data-id="${t.id}" />
                    <span style="text-decoration:${t.done ? 'line-through' : 'none'}">${esc(t.text)}</span>
                  </label>`).join('') || '<div class="empty-note">Nothing pending</div>',
          licenses: items.map((l) => `
                  <div class="license-item">
                    <div class="license-item-top">
                      <div class="license-item-type">${esc(l.type)}</div>
                      <span class="chip" style="${l.statusStyle}">${l.statusLabel}</span>
                    </div>
                    <div class="license-item-meta">${l.expiryLabel} &middot; ${l.daysLabel}</div>
                  </div>`).join('') || '<div class="empty-note">No licenses tracked yet</div>',
        };

        const sectionsHtml = sectionOrder.map((key) => `
              <div class="todo-block" data-section="${key}">
                <div class="todo-block-label-row">
                  <div class="todo-block-label">${sectionLabels[key]}</div>
                  <div class="todo-block-label-actions">
                    <button class="quick-add-btn" data-action="open-quick-add" data-section="${key}" data-id="${c.id}" title="Quick add">+</button>
                    <span class="section-drag-handle" data-reorder-handle title="Drag to reorder">&#8942;&#8942;</span>
                  </div>
                </div>
                ${quickAddPanel(c.id, key)}
                ${sectionBody[key]}
              </div>`).join('');

        return `
          <div class="dash-col">
            <div class="dash-col-head">
              <div class="dash-col-head-row">
                <div class="dash-col-code">${esc(c.code)}</div>
                <span class="chip" style="${chipStyle(STATUS[worstKey])}">${STATUS[worstKey].label}</span>
              </div>
              <div class="dash-col-name">${esc(c.name)}</div>
            </div>
            <div class="dash-col-body scrollarea">${sectionsHtml}
            </div>
          </div>`;
      }).join('');
      return header + `<div class="dash-columns">${columns}</div>`;
    }

    const list = enriched.map((l) => `
      <div class="row-card">
        <div>
          <div class="row-title">${esc(l.type)}</div>
          <div class="row-sub">${esc(l.clinicCode)} &middot; ${esc(l.clinicName)} &middot; expires ${l.expiryLabel}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          <span style="font:500 12px 'Manrope';color:var(--text-secondary)">${l.daysLabel}</span>
          <span class="chip" style="${l.statusStyle}">${l.statusLabel}</span>
        </div>
      </div>`).join('');

    const todosHtml = s.todos.map((t) => {
      const clinic = s.clinics.find((c) => c.id === t.clinicId) || { code: '?' };
      return `
        <label class="todo-row" style="padding:7px 2px;opacity:${t.done ? 0.5 : 1}">
          <input type="checkbox" ${t.done ? 'checked' : ''} data-action="toggle-todo" data-id="${t.id}" style="width:16px;height:16px" />
          <span style="font-size:13px;text-decoration:${t.done ? 'line-through' : 'none'}">${esc(t.text)} &middot; ${esc(clinic.code)}</span>
        </label>`;
    }).join('');

    return header + `
      <div class="dash-list">
        <div class="dash-list-main">
          <div class="section-label">Upcoming renewals</div>
          <div class="list-scroll scrollarea" style="padding:0">${list}</div>
        </div>
        <div class="dash-list-side">
          <div class="card">
            <div class="section-label">To-do</div>
            ${todosHtml}
          </div>
          <div class="tint-card">
            <div class="tint-card-title">WhatsApp reminders</div>
            <div class="tint-card-body">Owner alerted at 30 / 14 / 3 days before expiry, sent automatically to ${esc(s.ownerPhone)}.</div>
          </div>
        </div>
      </div>`;
  }

  function renderCalendar() {
    const s = state;
    const pills = clinicPillList(ui.calendarFilterClinic, 'calendar-filter-clinic');
    const { cells, monthLabel } = buildCalendarCells(ui.calendarMonthOffset, ui.calendarFilterClinic);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return `
      <div class="view-header">
        <div>
          <div class="view-title">Calendar</div>
          <div class="view-subtitle">Renewal &amp; task due dates</div>
        </div>
        <div style="display:flex;gap:8px">${pills.map(pillBtn).join('')}</div>
      </div>
      <div class="calendar-wrap">
        <div class="calendar-nav">
          <button class="pill-btn pill-outline" data-action="calendar-prev">&larr;</button>
          <div class="calendar-month-label">${monthLabel}</div>
          <button class="pill-btn pill-outline" data-action="calendar-next">&rarr;</button>
        </div>
        <div class="calendar-grid-head">${weekdays.map((wd) => `<div class="calendar-weekday">${wd}</div>`).join('')}</div>
        <div class="calendar-grid scrollarea">
          ${cells.map((c) => `
            <div class="calendar-cell" style="background:${c.bg}">
              <div class="calendar-daynum" style="font-weight:${c.dayWeight};color:${c.dayColor}">${c.dayNum}</div>
              ${c.events.map((ev) => `<div class="chip calendar-event-chip" style="${ev.style}">${esc(ev.label)}</div>`).join('')}
              ${c.hasMore ? `<div class="calendar-more">+${c.moreCount} more</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }

  function renderLicenses() {
    const s = state;
    const clinicPills = clinicPillList(ui.licenseFilterClinic, 'license-filter-clinic');
    const statusDefs = [{ k: 'all', label: 'All statuses' }, { k: 'overdue', label: 'Overdue' }, { k: 'critical', label: 'Due soon' }, { k: 'ok', label: 'Active' }];
    const statusPills = statusDefs.map((sd) => ({ id: sd.k, label: sd.label, active: ui.licenseFilterStatus === sd.k, action: 'license-filter-status' }));
    const filtered = allEnrichedLicenses().filter((l) =>
      (ui.licenseFilterClinic === 'all' || l.clinicId === ui.licenseFilterClinic) &&
      (ui.licenseFilterStatus === 'all' || l.statusKey === ui.licenseFilterStatus)
    );

    return `
      <div class="view-header" style="border-bottom:none">
        <div>
          <div class="view-title">Licenses &amp; Permits</div>
          <div class="view-subtitle">Track renewal status across all clinics</div>
        </div>
      </div>
      <div class="toolbar">
        <select class="field" data-action="set-new-license-clinic">
          ${s.clinics.map((cl) => `<option value="${cl.id}" ${ui.newLicense.clinicId === cl.id ? 'selected' : ''}>${esc(cl.code)}</option>`).join('')}
        </select>
        <select class="field" style="min-width:220px" data-action="set-new-license-type">
          ${s.licenseTypes.map((lt) => `<option value="${lt.id}" ${ui.newLicense.typeId === lt.id ? 'selected' : ''}>${esc(lt.name)}</option>`).join('')}
        </select>
        <input class="field" type="date" value="${esc(ui.newLicense.expiry)}" data-action="set-new-license-expiry" />
        <input class="field" type="text" placeholder="Notes (optional)" value="${esc(ui.newLicense.notes)}" style="flex:1;min-width:160px" data-action="set-new-license-notes" />
        <button class="pill-btn pill-accent" data-action="add-license">+ Add license</button>
      </div>
      <div class="pillbar">
        ${clinicPills.map(pillBtn).join('')}
        <div class="divider-v"></div>
        ${statusPills.map(pillBtn).join('')}
      </div>
      <div class="list-scroll scrollarea">
        ${filtered.map((l) => `
          <div class="row-card">
            <div>
              <div class="row-title">${esc(l.type)}</div>
              <div class="row-sub">${esc(l.clinicCode)} &middot; ${esc(l.clinicName)} &middot; expires ${l.expiryLabel}${l.notes ? ' &middot; ' + esc(l.notes) : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
              <span style="font:500 12px 'Manrope';color:var(--text-secondary)">${l.daysLabel}</span>
              <span class="chip" style="${l.statusStyle}">${l.statusLabel}</span>
              <button class="pill-btn pill-danger" data-action="remove-license" data-id="${l.id}">Remove</button>
            </div>
          </div>`).join('') || '<div class="row-empty">No licenses match this filter.</div>'}
      </div>`;
  }

  function renderTodo() {
    const s = state;
    const pills = clinicPillList(ui.todoFilterClinic, 'todo-filter-clinic');
    const filtered = s.todos
      .filter((t) => ui.todoFilterClinic === 'all' || t.clinicId === ui.todoFilterClinic)
      .map((t) => ({ ...t, clinic: s.clinics.find((c) => c.id === t.clinicId) || { code: '?' } }));

    return `
      <div class="view-header" style="border-bottom:none">
        <div>
          <div class="view-title">To-Do</div>
          <div class="view-subtitle">Tasks across all clinics</div>
        </div>
      </div>
      <div class="toolbar">
        <input class="field" type="text" placeholder="New task..." value="${esc(ui.newTodo.text)}" style="flex:1;min-width:200px" data-action="set-new-todo-text" />
        <select class="field" data-action="set-new-todo-clinic">
          ${s.clinics.map((cl) => `<option value="${cl.id}" ${ui.newTodo.clinicId === cl.id ? 'selected' : ''}>${esc(cl.code)}</option>`).join('')}
        </select>
        <input class="field" type="date" value="${esc(ui.newTodo.dueDate)}" data-action="set-new-todo-date" />
        <button class="pill-btn pill-accent" data-action="add-todo">+ Add task</button>
      </div>
      <div class="pillbar">${pills.map(pillBtn).join('')}</div>
      <div class="list-scroll scrollarea">
        ${filtered.map((t) => `
          <div class="row-card" style="opacity:${t.done ? 0.5 : 1}">
            <label style="display:flex;align-items:center;gap:12px;cursor:pointer;flex:1">
              <input type="checkbox" ${t.done ? 'checked' : ''} data-action="toggle-todo" data-id="${t.id}" style="width:16px;height:16px" />
              <div>
                <div class="row-title" style="text-decoration:${t.done ? 'line-through' : 'none'}">${esc(t.text)}</div>
                <div class="row-sub">${esc(t.clinic.code)}${t.dueDate ? ' &middot; due ' + fmtDate(t.dueDate) : ''}</div>
              </div>
            </label>
            <button class="pill-btn pill-danger" data-action="remove-todo" data-id="${t.id}">Remove</button>
          </div>`).join('') || '<div class="row-empty">No tasks here.</div>'}
      </div>`;
  }

  function renderReminders() {
    const s = state;
    const visibleActivity = ui.activityExpanded ? s.activityLog : s.activityLog.slice(0, 3);

    return `
      <div class="view-header">
        <div>
          <div class="view-title">Reminders</div>
          <div class="view-subtitle">Automated push notifications &amp; WhatsApp alerts for expiring licenses &amp; tasks</div>
        </div>
      </div>
      <div class="reminders-wrap scrollarea">
        <div class="reminders-left">
          <div class="card card-hover">
            <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:12px">Push notifications on this device</div>
            <div class="wa-status-banner ${s.pushConfigured ? 'ok' : 'warn'}" style="margin-bottom:10px">
              ${s.pushConfigured ? `Server ready — ${s.pushSubscriptionCount} device(s) subscribed.` : 'Server not configured yet — see Settings.'}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${!pushSupported() ? '<span style="font:400 12px \'Manrope\';color:var(--text-tertiary)">Not supported in this browser.</span>' : ui.pushSubscribed
                ? `<button class="pill-btn pill-outline" data-action="disable-push" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? 'Working…' : 'Disable on this device'}</button>`
                : `<button class="pill-btn pill-accent" data-action="enable-push" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? 'Working…' : '+ Enable on this device'}</button>`}
              <button class="pill-btn pill-outline" data-action="send-push-test" ${ui.busyPushTest ? 'disabled' : ''}>${ui.busyPushTest ? 'Sending…' : 'Send test push'}</button>
            </div>
          </div>

          <div class="card card-hover">
            <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:12px">Owner WhatsApp number</div>
            <input class="field" type="text" value="${esc(s.ownerPhone)}" style="width:100%" data-action="set-owner-phone" />
            <div style="font:400 11.5px 'Manrope';color:var(--text-secondary);margin-top:8px">All expiry &amp; overdue alerts are sent here.</div>
          </div>

          <div class="card card-hover">
            <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:12px">Alert schedule</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
              ${s.alertThresholds.map((t) => `
                <div class="threshold-row">
                  <span style="font:400 13px 'Manrope';color:var(--text-primary)">${t.amount} ${t.unit === 'months' ? (t.amount === 1 ? 'month' : 'months') : (t.amount === 1 ? 'day' : 'days')} before expiry</span>
                  <span class="threshold-remove" data-action="remove-alert-threshold" data-id="${t.id}">&times;</span>
                </div>`).join('') || '<div class="empty-note">No alert thresholds set — add one below.</div>'}
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="field" type="number" min="1" placeholder="e.g. 7" value="${esc(ui.newThreshold.amount)}" style="width:80px" data-action="set-new-threshold-amount" />
              <select class="field" data-action="set-new-threshold-unit">
                <option value="days" ${ui.newThreshold.unit === 'days' ? 'selected' : ''}>days before</option>
                <option value="months" ${ui.newThreshold.unit === 'months' ? 'selected' : ''}>months before</option>
              </select>
              <button class="pill-btn pill-accent" data-action="add-alert-threshold">+ Add</button>
            </div>
          </div>

          <button class="pill-btn pill-accent" style="padding:11px 18px;align-self:flex-start" data-action="send-test" ${ui.busyTest ? 'disabled' : ''}>${ui.busyTest ? 'Sending…' : 'Send test WhatsApp reminder'}</button>
          ${ui.toast ? `<div class="${ui.toast.type === 'error' ? 'toast-error' : 'toast-success'}">${esc(ui.toast.text)}</div>` : ''}
        </div>

        <div class="reminders-right">
          <div class="section-label">Recent activity</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${visibleActivity.map((a) => `
              <div class="activity-item">
                <div style="font:500 12.5px 'Manrope';color:var(--text-primary)">${esc(a.text)}</div>
                <div style="font:400 11.5px 'Manrope';color:var(--text-secondary);margin-top:3px">${esc(a.when)}${a.automated ? ' &middot; automatic' : ''}</div>
              </div>`).join('') || '<div class="empty-note">No activity yet.</div>'}
          </div>
          ${s.activityLog.length > 3 ? `<button class="pill-btn pill-outline" style="margin-top:10px" data-action="toggle-activity-expanded">${ui.activityExpanded ? 'Show less' : 'See all (' + s.activityLog.length + ')'}</button>` : ''}
        </div>
      </div>`;
  }

  function renderSettings() {
    const s = state;
    return `
      <div class="view-header">
        <div>
          <div class="view-title">Settings</div>
          <div class="view-subtitle">Manage clinics, license types, theme and data sync</div>
        </div>
      </div>
      <div class="settings-wrap scrollarea">
        <div class="settings-col">
          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:12px">Clinics</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${s.clinics.map((cl) => `
              <div class="clinic-row">
                <input class="field" type="text" value="${esc(cl.code)}" style="width:70px;flex-shrink:0" data-action="clinic-code-change" data-id="${cl.id}" />
                <input class="field" type="text" value="${esc(cl.name)}" style="flex:1" data-action="clinic-name-change" data-id="${cl.id}" />
                <button class="pill-btn pill-danger" data-action="remove-clinic" data-id="${cl.id}">Remove</button>
              </div>`).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <input class="field" type="text" placeholder="Code (e.g. KPS)" value="${esc(ui.newClinicCode)}" style="width:110px" data-action="set-new-clinic-code" />
            <input class="field" type="text" placeholder="Clinic name" value="${esc(ui.newClinicName)}" style="flex:1" data-action="set-new-clinic-name" />
            <button class="pill-btn pill-accent" data-action="add-clinic">+ Add clinic</button>
          </div>

          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin:24px 0 12px">Theme</div>
          <div class="layout-toggle" style="margin-bottom:12px">
            ${pillBtn({ label: 'Dark', active: (s.settings.themeMode || 'dark') === 'dark', action: 'set-theme-mode', id: 'dark' })}
            ${pillBtn({ label: 'Light', active: s.settings.themeMode === 'light', action: 'set-theme-mode', id: 'light' })}
          </div>
          <div class="swatch-row">
            ${ACCENT_OPTIONS.map((color) => `<div class="swatch ${s.settings.accentColor === color ? 'selected' : ''}" style="background:${color}" data-action="set-accent" data-id="${color}"></div>`).join('')}
          </div>
        </div>

        <div class="settings-col" style="max-width:420px">
          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:12px">License &amp; permit types</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${s.licenseTypes.map((lt) => `<span class="chip type-chip">${esc(lt.name)}<span data-action="remove-license-type" data-id="${lt.id}">&times;</span></span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <input class="field" type="text" placeholder="New license/permit type" value="${esc(ui.newLicenseTypeName)}" style="flex:1" data-action="set-new-license-type-name" />
            <button class="pill-btn pill-accent" data-action="add-license-type">+ Add type</button>
          </div>
        </div>

        <div class="settings-col" style="max-width:420px">
          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin-bottom:6px">Data &amp; sync</div>
          <div style="font:400 12px 'Manrope';color:var(--text-secondary);margin-bottom:12px;line-height:1.5">This server is the shared source of truth for the owner and all clinic managers. Optionally connect a Google Sheet as an external backup/export via a small Apps Script bridge (paste the deployed Web App URL below).</div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px">
            <input class="field" type="text" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(s.sheetUrl)}" style="width:100%" data-action="set-sheet-url" />
            <div style="display:flex;gap:8px">
              <button class="pill-btn pill-accent" style="flex:1" data-action="save-to-sheet" ${ui.sheetBusy ? 'disabled' : ''}>Save to Sheet</button>
              <button class="pill-btn pill-outline" style="flex:1" data-action="load-from-sheet" ${ui.sheetBusy ? 'disabled' : ''}>Load from Sheet</button>
            </div>
            <div style="font:400 11.5px 'Manrope';color:var(--text-secondary)">${s.lastSynced ? 'Last synced ' + esc(s.lastSynced) : 'Not synced yet'}</div>
            ${ui.toast ? `<div style="font:500 12px 'Manrope';color:var(--accent-tint-text);background:var(--accent-tint-bg);border-radius:6px;padding:8px 10px">${esc(ui.toast.text)}</div>` : ''}
          </div>

          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin:20px 0 6px">Push notifications</div>
          <div style="font:400 12px 'Manrope';color:var(--text-secondary);margin-bottom:10px;line-height:1.5">Free, no WhatsApp ban risk — alerts appear directly on this device's lock screen. On iPhone, "Add to Home Screen" first so notifications keep working in the background.</div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px">
            <div class="wa-status-banner ${s.pushConfigured ? 'ok' : 'warn'}" style="margin:0">
              ${s.pushConfigured ? `Server ready — ${s.pushSubscriptionCount} device(s) subscribed.` : 'Server not configured yet. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (see SETUP.md).'}
            </div>
            ${!pushSupported() ? '<div style="font:400 12px \'Manrope\';color:var(--text-tertiary)">Notifications aren\'t supported in this browser.</div>' : ui.pushSubscribed
              ? `<button class="pill-btn pill-outline" data-action="disable-push" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? 'Working…' : 'Disable on this device'}</button>`
              : `<button class="pill-btn pill-accent" data-action="enable-push" ${ui.pushBusy ? 'disabled' : ''}>${ui.pushBusy ? 'Working…' : '+ Enable on this device'}</button>`}
          </div>

          <div style="font:600 14px 'Manrope';color:var(--text-primary);margin:20px 0 6px">WhatsApp Cloud API</div>
          <div class="wa-status-banner ${s.whatsappConfigured ? 'ok' : 'warn'}" style="margin:0">
            ${s.whatsappConfigured ? 'Configured — automated & manual reminders send for real.' : 'Not configured yet (optional — see SETUP.md for setup, and the ban-risk notes if considering unofficial libraries instead).'}
          </div>
        </div>
      </div>`;
  }

  // ---------- event handling ----------
  function bindDelegatedEvents() {
    const root = document.getElementById('app');

    root.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || el.matches('input,select,textarea')) return;
      const action = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      const section = el.getAttribute('data-section');

      switch (action) {
        case 'nav':
          ui.activeView = id; ui.sidebarOpen = false; render(); break;
        case 'toggle-sidebar':
          ui.sidebarOpen = !ui.sidebarOpen; render(); break;
        case 'close-sidebar':
          ui.sidebarOpen = false; render(); break;
        case 'set-layout':
          await mutate(() => api('PATCH', '/api/settings', { dashboardLayout: id })); break;
        case 'set-accent':
          await mutate(() => api('PATCH', '/api/settings', { accentColor: id })); break;
        case 'set-theme-mode':
          await mutate(() => api('PATCH', '/api/settings', { themeMode: id })); break;
        case 'calendar-filter-clinic':
          ui.calendarFilterClinic = id; render(); break;
        case 'calendar-prev':
          ui.calendarMonthOffset -= 1; render(); break;
        case 'calendar-next':
          ui.calendarMonthOffset += 1; render(); break;
        case 'license-filter-clinic':
          ui.licenseFilterClinic = id; render(); break;
        case 'license-filter-status':
          ui.licenseFilterStatus = id; render(); break;
        case 'todo-filter-clinic':
          ui.todoFilterClinic = id; render(); break;
        case 'add-license':
          if (!ui.newLicense.expiry) { showToast('error', 'Pick an expiry date first.'); break; }
          await mutate(() => api('POST', '/api/licenses', ui.newLicense));
          ui.newLicense = { clinicId: ui.newLicense.clinicId, typeId: ui.newLicense.typeId, expiry: '', notes: '' };
          render();
          break;
        case 'remove-license':
          await mutate(() => api('DELETE', '/api/licenses/' + id)); break;
        case 'add-todo':
          if (!ui.newTodo.text.trim()) { showToast('error', 'Type a task first.'); break; }
          await mutate(() => api('POST', '/api/todos', ui.newTodo));
          ui.newTodo = { text: '', clinicId: ui.newTodo.clinicId, dueDate: '' };
          render();
          break;
        case 'remove-todo':
          await mutate(() => api('DELETE', '/api/todos/' + id)); break;
        case 'toggle-todo': {
          const t = state.todos.find((x) => x.id === id);
          await mutate(() => api('PATCH', '/api/todos/' + id, { done: t ? !t.done : true }));
          break;
        }
        case 'open-quick-add': {
          const kind = section === 'licenses' ? 'license' : 'todo';
          ui.quickAdd = { clinicId: id, section, kind };
          ui.quickAddForm = { text: '', dueDate: '', typeId: (state.licenseTypes[0] || {}).id || '', expiry: '' };
          render();
          break;
        }
        case 'close-quick-add':
          ui.quickAdd = null; render(); break;
        case 'submit-quick-todo': {
          if (!ui.quickAddForm.text.trim()) { showToast('error', 'Type a task first.'); break; }
          const clinicId = ui.quickAdd.clinicId;
          await mutate(() => api('POST', '/api/todos', { clinicId, text: ui.quickAddForm.text, dueDate: ui.quickAddForm.dueDate }));
          ui.quickAdd = null;
          render();
          break;
        }
        case 'submit-quick-license': {
          if (!ui.quickAddForm.typeId || !ui.quickAddForm.expiry) { showToast('error', 'Pick a license type and expiry date.'); break; }
          const clinicId = ui.quickAdd.clinicId;
          await mutate(() => api('POST', '/api/licenses', { clinicId, typeId: ui.quickAddForm.typeId, expiry: ui.quickAddForm.expiry, notes: '' }));
          ui.quickAdd = null;
          render();
          break;
        }
        case 'add-clinic':
          if (!ui.newClinicName.trim() || !ui.newClinicCode.trim()) { showToast('error', 'Enter both a code and a name.'); break; }
          await mutate(() => api('POST', '/api/clinics', { code: ui.newClinicCode, name: ui.newClinicName }));
          ui.newClinicName = ''; ui.newClinicCode = '';
          render();
          break;
        case 'remove-clinic':
          await mutate(() => api('DELETE', '/api/clinics/' + id)); break;
        case 'add-license-type':
          if (!ui.newLicenseTypeName.trim()) break;
          await mutate(() => api('POST', '/api/license-types', { name: ui.newLicenseTypeName }));
          ui.newLicenseTypeName = '';
          render();
          break;
        case 'remove-license-type':
          await mutate(() => api('DELETE', '/api/license-types/' + id)); break;
        case 'add-alert-threshold': {
          const amount = Number(ui.newThreshold.amount);
          if (!amount || amount <= 0) { showToast('error', 'Enter a number greater than 0.'); break; }
          await mutate(() => api('POST', '/api/alert-thresholds', { amount, unit: ui.newThreshold.unit }));
          ui.newThreshold = { amount: '', unit: ui.newThreshold.unit };
          render();
          break;
        }
        case 'remove-alert-threshold':
          await mutate(() => api('DELETE', '/api/alert-thresholds/' + id)); break;
        case 'toggle-activity-expanded':
          ui.activityExpanded = !ui.activityExpanded; render(); break;
        case 'send-test':
          ui.busyTest = true; render();
          try {
            const result = await mutate(() => api('POST', '/api/reminders/test'));
            showToast(result.ok ? 'success' : 'error', result.ok ? 'Test reminder sent to owner.' : ('Send failed: ' + result.error));
          } finally { ui.busyTest = false; render(); }
          break;
        case 'enable-push':
          await enablePush(); break;
        case 'disable-push':
          await disablePush(); break;
        case 'send-push-test':
          ui.busyPushTest = true; render();
          try {
            const result = await mutate(() => api('POST', '/api/push/test'));
            showToast(result.ok ? 'success' : 'error', result.ok ? 'Test push notification sent.' : ('Send failed: ' + result.error));
          } finally { ui.busyPushTest = false; render(); }
          break;
        case 'save-to-sheet':
          ui.sheetBusy = true; render();
          try { await saveToSheet(); } finally { ui.sheetBusy = false; render(); }
          break;
        case 'load-from-sheet':
          ui.sheetBusy = true; render();
          try { await loadFromSheet(); } finally { ui.sheetBusy = false; render(); }
          break;
      }
    });

    root.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      const value = el.type === 'checkbox' ? el.checked : el.value;

      switch (action) {
        case 'set-new-license-clinic': ui.newLicense.clinicId = value; break;
        case 'set-new-license-type': ui.newLicense.typeId = value; break;
        case 'set-new-license-expiry': ui.newLicense.expiry = value; break;
        case 'set-new-license-notes': ui.newLicense.notes = value; break;
        case 'set-new-todo-text': ui.newTodo.text = value; break;
        case 'set-new-todo-clinic': ui.newTodo.clinicId = value; break;
        case 'set-new-todo-date': ui.newTodo.dueDate = value; break;
        case 'set-quick-todo-text': ui.quickAddForm.text = value; break;
        case 'set-quick-todo-date': ui.quickAddForm.dueDate = value; break;
        case 'set-quick-license-type': ui.quickAddForm.typeId = value; break;
        case 'set-quick-license-expiry': ui.quickAddForm.expiry = value; break;
        case 'set-new-clinic-code': ui.newClinicCode = value; break;
        case 'set-new-clinic-name': ui.newClinicName = value; break;
        case 'set-new-license-type-name': ui.newLicenseTypeName = value; break;
        case 'set-owner-phone':
          await mutate(() => api('PATCH', '/api/settings', { ownerPhone: value })); break;
        case 'clinic-code-change':
          await mutate(() => api('PATCH', '/api/clinics/' + id, { code: value })); break;
        case 'clinic-name-change':
          await mutate(() => api('PATCH', '/api/clinics/' + id, { name: value })); break;
        case 'set-new-threshold-amount': ui.newThreshold.amount = value; break;
        case 'set-new-threshold-unit': ui.newThreshold.unit = value; break;
        case 'set-sheet-url':
          await mutate(() => api('PATCH', '/api/settings', { sheetUrl: value })); break;
      }
    });

    window.addEventListener('resize', () => {
      const wasMobile = ui.isMobile;
      ui.isMobile = window.innerWidth < 880;
      if (wasMobile !== ui.isMobile) render();
    });

    root.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('[data-reorder-handle]');
      if (handle) startSectionDrag(e, handle);
    });
  }

  // Drag-to-reorder for the Licenses / To-do sections on the dashboard. Uses
  // Pointer Events (not native HTML5 drag-and-drop) so it works
  // on touch screens, not just mouse. Order is a shared setting applied to every
  // clinic column, so the drag only needs to run in the column the user grabbed.
  function startSectionDrag(e, handle) {
    if (e.button !== undefined && e.button !== 0) return;
    const block = handle.closest('[data-section]');
    const body = block.parentElement;
    const blocks = Array.from(body.children).filter((el) => el.hasAttribute('data-section'));
    const order = blocks.map((b) => b.getAttribute('data-section'));
    const startIndex = order.indexOf(block.getAttribute('data-section'));
    const originalRects = blocks.map((b) => b.getBoundingClientRect());
    const startY = e.clientY;
    let currentIndex = startIndex;

    e.preventDefault();
    block.classList.add('section-dragging');
    block.style.transition = 'none';

    function shiftSiblings(newIndex) {
      blocks.forEach((b, i) => {
        if (i === startIndex) return;
        let targetSlot = i;
        if (startIndex < newIndex && i > startIndex && i <= newIndex) targetSlot = i - 1;
        else if (startIndex > newIndex && i >= newIndex && i < startIndex) targetSlot = i + 1;
        const dy = originalRects[targetSlot].top - originalRects[i].top;
        b.style.transform = dy ? `translateY(${dy}px)` : '';
      });
    }

    function onMove(ev) {
      const dy = ev.clientY - startY;
      block.style.transform = `translateY(${dy}px)`;
      const draggedCenter = originalRects[startIndex].top + originalRects[startIndex].height / 2 + dy;
      const passed = originalRects.filter((r) => draggedCenter >= r.top + r.height / 2).length;
      const newIndex = Math.max(0, Math.min(blocks.length - 1, passed - 1));
      if (newIndex !== currentIndex) {
        currentIndex = newIndex;
        shiftSiblings(currentIndex);
      }
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      block.classList.remove('section-dragging');
      block.style.transition = '';
      block.style.transform = '';
      blocks.forEach((b) => { if (b !== block) b.style.transform = ''; });

      if (currentIndex !== startIndex) {
        const newOrder = order.slice();
        const [moved] = newOrder.splice(startIndex, 1);
        newOrder.splice(currentIndex, 0, moved);
        mutate(() => api('PATCH', '/api/settings', { dashboardSectionOrder: newOrder }));
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // ---------- Google Sheets bridge (client-side, talks directly to the user's Apps Script URL) ----------
  async function saveToSheet() {
    if (!state.sheetUrl) { showToast('error', 'Paste your Apps Script Web App URL first.'); return; }
    showToast('success', 'Saving to Google Sheet…', 60000);
    try {
      const payload = {
        clinics: state.clinics, licenseTypes: state.licenseTypes, licenses: state.licenses, todos: state.todos,
        ownerPhone: state.ownerPhone, alertThresholds: state.alertThresholds, settings: state.settings,
      };
      const res = await fetch(state.sheetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Request failed');
      await mutate(() => api('PATCH', '/api/settings', { lastSynced: new Date().toLocaleTimeString() }));
      showToast('success', 'Saved.');
    } catch (err) {
      showToast('error', 'Could not reach the sheet — check the URL and deployment access.');
    }
  }

  async function loadFromSheet() {
    if (!state.sheetUrl) { showToast('error', 'Paste your Apps Script Web App URL first.'); return; }
    showToast('success', 'Loading from Google Sheet…', 60000);
    try {
      const res = await fetch(state.sheetUrl);
      if (!res.ok) throw new Error('Request failed');
      const data = await res.json();
      await mutate(() => api('PUT', '/api/state/bulk-import', data));
      showToast('success', 'Loaded.');
    } catch (err) {
      showToast('error', 'Could not load — check the URL and that the sheet has saved data.');
    }
  }

  // ---------- push notifications ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  }

  async function checkExistingPushSubscription() {
    if (!pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      const sub = await reg.pushManager.getSubscription();
      ui.pushSubscribed = !!sub;
    } catch (e) { /* ignore — treated as not subscribed */ }
  }

  async function enablePush() {
    if (!pushSupported()) { showToast('error', 'Notifications are not supported in this browser.'); return; }
    ui.pushBusy = true; render();
    try {
      const permission = await Notification.requestPermission();
      ui.pushPermission = permission;
      if (permission !== 'granted') { showToast('error', 'Notification permission was not granted.'); return; }

      const { publicKey } = await api('GET', '/api/push/public-key');
      if (!publicKey) { showToast('error', 'Push notifications are not set up on the server yet (missing VAPID keys).'); return; }

      const reg = await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      await mutate(() => api('POST', '/api/push/subscribe', sub.toJSON ? sub.toJSON() : sub));
      ui.pushSubscribed = true;
      showToast('success', 'Notifications enabled on this device.');
    } catch (err) {
      showToast('error', 'Could not enable notifications: ' + err.message);
    } finally {
      ui.pushBusy = false; render();
    }
  }

  async function disablePush() {
    ui.pushBusy = true; render();
    try {
      if (pushSupported()) {
        const reg = await navigator.serviceWorker.getRegistration('./sw.js');
        const sub = reg && (await reg.pushManager.getSubscription());
        if (sub) {
          await mutate(() => api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }));
          await sub.unsubscribe();
        }
      }
      ui.pushSubscribed = false;
      showToast('success', 'Notifications disabled on this device.');
    } catch (err) {
      showToast('error', 'Could not disable notifications: ' + err.message);
    } finally {
      ui.pushBusy = false; render();
    }
  }

  // ---------- boot ----------
  async function init() {
    await refresh();
    if (!ui.newLicense.clinicId && state.clinics[0]) ui.newLicense.clinicId = state.clinics[0].id;
    if (!ui.newLicense.typeId && state.licenseTypes[0]) ui.newLicense.typeId = state.licenseTypes[0].id;
    if (!ui.newTodo.clinicId && state.clinics[0]) ui.newTodo.clinicId = state.clinics[0].id;
    bindDelegatedEvents();
    render();
    await checkExistingPushSubscription();
    render();
  }

  init();
})();
