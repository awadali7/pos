// Mobile ordering client — served by the HTTP server in main.js (see the
// "Mobile ordering server" section there). Plain vanilla JS, no build step,
// matching src/renderer.js's own hand-rolled style. Talks to the same
// process/DB as the desktop app, just over HTTP instead of Electron IPC —
// see MOBILE_ROUTES in main.js for the full route list and what each is
// allowed to do (dine-in orders + KOT only, no billing/payment).

const money = (n) => Number(n || 0).toFixed(2);

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let token = sessionStorage.getItem('mobileToken') || null;
let staff = null;
try { staff = JSON.parse(sessionStorage.getItem('mobileStaff') || 'null'); } catch { staff = null; }

let tables = [];
let currentOrder = null;
let menuItems = [];
let modifierPickerItem = null;
let modifierPickerGroups = [];
let isSubmitting = false; // guards the order-screen poll from clobbering a mutation in flight
let pollTimer = null;
let activeCategory = 'All';
let searchQuery = '';

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('hidden', el.id !== id));
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function clearSession() {
  token = null;
  staff = null;
  currentOrder = null;
  sessionStorage.removeItem('mobileToken');
  sessionStorage.removeItem('mobileStaff');
  stopPolling();
  showScreen('screen-login');
}

// ---------------- Login ----------------
const pinDisplay = document.getElementById('login-pin');
const loginBtn = document.getElementById('login-btn');

document.querySelectorAll('#screen-login .key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key === 'clear') pinDisplay.value = '';
    else if (key === 'back') pinDisplay.value = pinDisplay.value.slice(0, -1);
    else if (pinDisplay.value.length < 6) pinDisplay.value += key;
    loginBtn.disabled = pinDisplay.value.length < 4;
  });
});

loginBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const result = await api('/api/mobile/login', { method: 'POST', body: { pin: pinDisplay.value } });
    token = result.token;
    staff = result.staff;
    sessionStorage.setItem('mobileToken', token);
    sessionStorage.setItem('mobileStaff', JSON.stringify(staff));
    pinDisplay.value = '';
    loginBtn.disabled = true;
    await enterTablesScreen();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    pinDisplay.value = '';
    loginBtn.disabled = true;
  }
});

document.getElementById('logout-btn').addEventListener('click', clearSession);

// ---------------- Tables ----------------
async function enterTablesScreen() {
  document.getElementById('staff-name').textContent = staff ? `${staff.name} · ${staff.role}` : '';
  showScreen('screen-tables');
  await refreshTables();
  stopPolling();
  pollTimer = setInterval(refreshTables, 4000);
}

async function refreshTables() {
  try {
    tables = await api('/api/mobile/tables');
  } catch (err) {
    if (err.statusCode === 401) clearSession();
    return;
  }
  renderTableGrid();
}

function renderTableGrid() {
  const grid = document.getElementById('table-grid');
  grid.innerHTML = tables.map((t) => {
    const occupied = t.order_id != null;
    return `
      <button class="table-tile ${occupied ? 'occupied' : ''}" data-table-id="${t.id}" data-order-id="${t.order_id || ''}">
        <div class="table-name">${escapeHtml(t.name)}</div>
        <div class="table-status">${occupied ? '&#8377;' + money(t.order_total) : 'Free'}</div>
      </button>
    `;
  }).join('');
  grid.querySelectorAll('.table-tile').forEach((tile) => {
    tile.addEventListener('click', () => openTable(tile.dataset.tableId, tile.dataset.orderId));
  });
}

async function openTable(tableId, orderId) {
  try {
    currentOrder = orderId
      ? await api(`/api/mobile/orders/${orderId}`)
      : await api('/api/mobile/orders', { method: 'POST', body: { tableId: Number(tableId) } });
    if (!currentOrder.items) currentOrder.items = [];
  } catch (err) {
    alert(`Could not open table: ${err.message}`);
    return;
  }
  await enterOrderScreen();
}

// ---------------- Order screen ----------------
async function enterOrderScreen() {
  showScreen('screen-order');
  document.getElementById('order-error').classList.add('hidden');
  document.getElementById('order-table-name').textContent = currentOrder.table_label || `Order #${currentOrder.id}`;
  activeCategory = 'All';
  searchQuery = '';
  document.getElementById('menu-search').value = '';
  if (!menuItems.length) {
    try { menuItems = await api('/api/mobile/menu'); } catch (err) { alert(`Could not load menu: ${err.message}`); }
  }
  renderOrder();
  renderCategoryTabs();
  renderMenuList();
  stopPolling();
  pollTimer = setInterval(pollOrder, 4000);
}

async function pollOrder() {
  if (isSubmitting || !currentOrder) return;
  try {
    currentOrder = await api(`/api/mobile/orders/${currentOrder.id}`);
    renderOrder();
  } catch (err) {
    if (err.statusCode === 401) clearSession();
  }
}

document.getElementById('back-to-tables-btn').addEventListener('click', async () => {
  currentOrder = null;
  await enterTablesScreen();
});

function renderOrder() {
  const wrap = document.getElementById('order-items');
  const items = currentOrder.items || [];
  wrap.innerHTML = items.length ? items.map((i) => {
    const mods = (i.modifiers || []).map((m) => m.name).join(', ');
    return `
      <div class="order-item-row" data-item-id="${i.id}">
        <div>
          <div class="order-item-name">${escapeHtml(i.item_name)}</div>
          ${mods ? `<div class="order-item-mods">${escapeHtml(mods)}</div>` : ''}
        </div>
        <div class="qty-controls">
          <button class="qty-btn" data-action="dec">&minus;</button>
          <span>${i.quantity}</span>
          <button class="qty-btn" data-action="inc">+</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="hint">No items yet — add something below.</p>';

  wrap.querySelectorAll('.order-item-row').forEach((row) => {
    const itemId = Number(row.dataset.itemId);
    const item = items.find((i) => i.id === itemId);
    row.querySelector('[data-action="inc"]').addEventListener('click', () => changeItemQty(item, item.quantity + 1));
    row.querySelector('[data-action="dec"]').addEventListener('click', () => changeItemQty(item, item.quantity - 1));
  });

  document.getElementById('order-total').textContent = money(currentOrder.total);
}

async function changeItemQty(item, newQty) {
  isSubmitting = true;
  try {
    if (newQty <= 0) {
      await api(`/api/mobile/orders/${currentOrder.id}/items/${item.id}`, { method: 'DELETE' });
    } else {
      await api(`/api/mobile/orders/${currentOrder.id}/items/${item.id}`, { method: 'PATCH', body: { quantity: newQty } });
    }
    currentOrder = await api(`/api/mobile/orders/${currentOrder.id}`);
    renderOrder();
  } catch (err) {
    alert(`Could not update item: ${err.message}`);
  } finally {
    isSubmitting = false;
  }
}

// Tabs are derived from menuItems itself rather than a separate
// categories fetch — listMenu() (main.js) already orders items by each
// category's sort_order, so de-duping category_name in that same order
// (Set preserves insertion order) reproduces the desktop's tab order
// without a second API call.
function renderCategoryTabs() {
  const wrap = document.getElementById('category-tabs');
  const names = ['All', ...new Set(menuItems.map((m) => m.category_name || 'Other'))];
  wrap.innerHTML = names.map((name) => `
    <button class="category-tab ${name === activeCategory ? 'active' : ''}" data-category="${escapeHtml(name)}">${escapeHtml(name)}</button>
  `).join('');
  wrap.querySelectorAll('.category-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeCategory = tab.dataset.category;
      wrap.querySelectorAll('.category-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderMenuList();
    });
  });
}

function renderMenuList() {
  const wrap = document.getElementById('menu-list');
  const query = searchQuery.trim().toLowerCase();
  const filtered = menuItems.filter((m) => {
    if (!m.is_available) return false;
    if (activeCategory !== 'All' && (m.category_name || 'Other') !== activeCategory) return false;
    if (query && !m.name.toLowerCase().includes(query)) return false;
    return true;
  });
  wrap.innerHTML = filtered.length ? filtered.map((m) => `
    <button class="menu-item-row" data-item-id="${m.id}">
      <span class="menu-item-name">${escapeHtml(m.name)}</span>
      <span class="menu-item-price">&#8377;${money(m.price)}</span>
    </button>
  `).join('') : '<p class="hint">No items match.</p>';
  wrap.querySelectorAll('.menu-item-row').forEach((row) => {
    row.addEventListener('click', () => {
      const item = menuItems.find((m) => m.id === Number(row.dataset.itemId));
      addItemToOrder(item);
    });
  });
}

document.getElementById('menu-search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderMenuList();
});

// Dispatcher for tapping a menu item: items with modifier groups need a
// picker first (size/add-ons/etc.), plain items go straight onto the
// order — mirrors addItemToOrder() in src/renderer.js.
async function addItemToOrder(menuItem) {
  if (menuItem.modifier_group_count > 0) {
    await openModifierPicker(menuItem);
    return;
  }
  await addItemToOrderWithModifiers(menuItem, []);
}

async function addItemToOrderWithModifiers(menuItem, modifierOptionIds) {
  isSubmitting = true;
  try {
    await api(`/api/mobile/orders/${currentOrder.id}/items`, {
      method: 'POST',
      body: { menuItemId: menuItem.id, quantity: 1, modifierOptionIds },
    });
    currentOrder = await api(`/api/mobile/orders/${currentOrder.id}`);
    renderOrder();
  } catch (err) {
    alert(`Could not add item: ${err.message}`);
  } finally {
    isSubmitting = false;
  }
}

// ---------------- Modifier picker ----------------
async function openModifierPicker(menuItem) {
  modifierPickerItem = menuItem;
  try {
    modifierPickerGroups = await api(`/api/mobile/menu/${menuItem.id}/modifiers`);
  } catch (err) {
    alert(`Could not load options: ${err.message}`);
    return;
  }
  document.getElementById('modifier-modal-title').textContent = menuItem.name;
  const wrap = document.getElementById('modifier-modal-groups');
  wrap.innerHTML = modifierPickerGroups.map((g) => {
    // Same semantics as src/renderer.js's own picker: a required
    // single-choice group (min 1, max 1) is a real radio; an OPTIONAL
    // single-choice group (min 0, max 1) still needs checkbox markup
    // because a native radio can't be clicked back to unchecked — mutual
    // exclusivity is enforced by the listener wired below instead.
    const isOptionalSingle = g.min_select === 0 && g.max_select === 1;
    const inputType = (g.max_select > 1 || isOptionalSingle) ? 'checkbox' : 'radio';
    const requiredLabel = g.min_select > 0 ? ' (required)' : '';
    return `
      <div class="modifier-group" data-group-id="${g.id}" data-optional-single="${isOptionalSingle}">
        <div class="modifier-group-name">${escapeHtml(g.name)}${requiredLabel}</div>
        ${g.options.map((o) => `
          <label class="modifier-option">
            <input type="${inputType}" name="modifier-group-${g.id}" value="${o.id}" />
            <span>${escapeHtml(o.name)}</span>
            ${Number(o.price_delta) !== 0 ? `<span class="modifier-option-price">${Number(o.price_delta) > 0 ? '+' : '−'}&#8377;${money(Math.abs(o.price_delta))}</span>` : ''}
          </label>
        `).join('')}
      </div>
    `;
  }).join('');
  wrap.querySelectorAll('.modifier-group[data-optional-single="true"]').forEach((groupEl) => {
    const boxes = groupEl.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) boxes.forEach((other) => { if (other !== box) other.checked = false; });
      });
    });
  });
  document.getElementById('modifier-modal').classList.remove('hidden');
}

document.getElementById('modifier-cancel-btn').addEventListener('click', () => {
  document.getElementById('modifier-modal').classList.add('hidden');
  modifierPickerItem = null;
});

document.getElementById('modifier-add-btn').addEventListener('click', async () => {
  for (const g of modifierPickerGroups) {
    const checked = document.querySelectorAll(`input[name="modifier-group-${g.id}"]:checked`);
    if (checked.length < g.min_select || checked.length > g.max_select) {
      alert(`"${g.name}" needs between ${g.min_select} and ${g.max_select} selection(s).`);
      return;
    }
  }
  const selectedIds = Array.from(document.querySelectorAll('#modifier-modal-groups input:checked')).map((el) => Number(el.value));
  const item = modifierPickerItem;
  document.getElementById('modifier-modal').classList.add('hidden');
  modifierPickerItem = null;
  await addItemToOrderWithModifiers(item, selectedIds);
});

// ---------------- Fire KOT ----------------
document.getElementById('fire-kot-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('order-error');
  errEl.classList.add('hidden');
  const btn = document.getElementById('fire-kot-btn');
  btn.disabled = true;
  isSubmitting = true;
  try {
    const result = await api(`/api/mobile/orders/${currentOrder.id}/fire-kot`, { method: 'POST' });
    if (result.mode === 'none') {
      alert('Nothing new to send — everything on this order is already fired.');
    } else {
      alert(`Sent ${result.count} item(s) to the kitchen.`);
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    isSubmitting = false;
  }
});

// ---------------- Boot ----------------
if (token && staff) {
  enterTablesScreen();
} else {
  showScreen('screen-login');
}
