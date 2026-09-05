// ---------------- State ----------------
let categories = [];
let subcategories = [];
let menuItems = [];
let restaurantTables = [];
let activeCategory = 'all';
let activeSubcategory = 'all';
let currentOrder = null; // { id, items: [...], subtotal, tax_amount, discount, total, ... }
let splitPayments = []; // [{ mode, amount }, ...] while the split-payment section of the payment modal is in use
let allOrders = [];
let ordersStatusFilter = 'all';
let customerSearchQuery = '';
let viewingHistoricalReceipt = false;
let currentReceiptOrderId = null; // which order the open receipt modal belongs to, for receipt-print-btn
let reportsRangeKey = 'today';
let defaultTaxPercent = 5;
let currentStaff = null; // { id, name, role } once logged in — mirrors main.js's session, used here only to hide tabs the role can't use; the real access control lives in main.js
let openShift = null; // the currently open shift row (or null), refreshed after login/open/close

const money = (n) => Number(n || 0).toFixed(2);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------- Notice / confirm modal ----------------
// Replaces the native alert()/confirm() (OS-chrome dialogs — and for IPC
// errors, alert() would otherwise show Electron's own "Error invoking
// remote method 'x:y': Error: ..." wrapper text verbatim) with the app's
// own styled modal, reusing the same .modal-backdrop/.modal markup every
// other modal here already uses.
function cleanErrorMessage(message) {
  return String(message)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function showNoticeModal(message, { showCancel } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('notice-modal');
    document.getElementById('notice-modal-message').textContent = cleanErrorMessage(message);
    const cancelBtn = document.getElementById('notice-modal-cancel-btn');
    const okBtn = document.getElementById('notice-modal-ok-btn');
    cancelBtn.classList.toggle('hidden', !showCancel);
    okBtn.textContent = showCancel ? 'Confirm' : 'OK';

    function cleanup(result) {
      backdrop.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.classList.remove('hidden');
    okBtn.focus();
  });
}

// Fire-and-forget, matching native alert()'s undefined return — every
// existing `alert(...)` call site in this file gets the styled modal (and
// cleaned-up error text) automatically, with no call site changes needed:
// none of them depend on alert()'s actual blocking behavior, they're
// always the last thing done in their branch.
window.alert = (message) => { showNoticeModal(message, { showCancel: false }); };

// confirm() is genuinely synchronous by spec and can't be polyfilled the
// same way alert() was — every `confirm(...)` call site below is instead
// written as `await confirmDialog(...)` (all were already inside async
// functions).
function confirmDialog(message) {
  return showNoticeModal(message, { showCancel: true });
}

// ---------------- Staff login / setup ----------------
// The overlay (#auth-screen) visually covers the whole window until login
// succeeds — that's a UX gate, not the real access control. The real
// enforcement is server-side in main.js (requireRole/requireLogin), since a
// renderer-only lock could be bypassed via DevTools.
function showAuthError(el, message) {
  el.textContent = message;
  el.classList.remove('hidden');
}

async function initAuth() {
  // A window reload (Ctrl+R/F5) restarts this script from scratch, but not
  // the main process — the session actually lives there (see the comment on
  // staff:whoAmI in main.js), so check it before assuming logged-out.
  const existing = await window.pos.staff.whoAmI();
  if (existing) {
    onLoggedIn(existing);
    return;
  }
  const needsSetup = await window.pos.staff.needsSetup();
  document.getElementById('auth-setup').classList.toggle('hidden', !needsSetup);
  document.getElementById('auth-login').classList.toggle('hidden', needsSetup);
  if (needsSetup) {
    document.getElementById('setup-name').focus();
  } else {
    document.getElementById('login-pin').focus();
  }
}

document.getElementById('auth-setup-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('auth-setup-error');
  errEl.classList.add('hidden');
  const name = document.getElementById('setup-name').value.trim();
  const pin = document.getElementById('setup-pin').value;
  const pinConfirm = document.getElementById('setup-pin-confirm').value;
  if (!name) { showAuthError(errEl, 'Enter your name.'); return; }
  if (!/^\d{4,6}$/.test(pin)) { showAuthError(errEl, 'PIN must be 4-6 digits.'); return; }
  if (pin !== pinConfirm) { showAuthError(errEl, 'PINs do not match.'); return; }
  try {
    const staff = await window.pos.staff.createFirstOwner({ name, pin });
    onLoggedIn(staff);
  } catch (err) {
    showAuthError(errEl, err.message);
  }
});

const loginPinInput = document.getElementById('login-pin');

document.querySelectorAll('.auth-key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key === 'clear') loginPinInput.value = '';
    else if (key === 'back') loginPinInput.value = loginPinInput.value.slice(0, -1);
    else if (loginPinInput.value.length < 6) loginPinInput.value += key;
    loginPinInput.focus();
  });
});

loginPinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});

document.getElementById('auth-login-btn').addEventListener('click', attemptLogin);

async function attemptLogin() {
  const errEl = document.getElementById('auth-login-error');
  errEl.classList.add('hidden');
  const pin = loginPinInput.value;
  if (!pin) return;
  try {
    const staff = await window.pos.staff.login({ pin });
    loginPinInput.value = '';
    onLoggedIn(staff);
  } catch (err) {
    loginPinInput.value = '';
    showAuthError(errEl, err.message);
    loginPinInput.focus();
  }
}

function onLoggedIn(staff) {
  currentStaff = staff;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('topbar-staff-info').classList.remove('hidden');
  document.getElementById('topbar-staff-name').textContent = `${staff.name} · ${staff.role}`;
  applyRolePermissions();
  document.getElementById('topbar-shift-info').classList.remove('hidden');
  refreshShiftStatus();
}

// Hides tabs the current role can't use. This is convenience, not
// security — see the note at the top of this section.
function applyRolePermissions() {
  const role = currentStaff ? currentStaff.role : null;
  const canManage = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';
  document.querySelector('.tab-btn[data-view="menu"]').classList.toggle('hidden', !canManage);
  document.querySelector('.tab-btn[data-view="reports"]').classList.toggle('hidden', !canManage);
  document.querySelector('.tab-btn[data-view="settings"]').classList.toggle('hidden', !isOwner);
}

// Shared by the Lock button and syncSessionAfterStaffChange() (an owner who
// deactivates/deletes their OWN account from Staff management ends up here
// too, not just an explicit Lock click) — resets the topbar and any
// currently-open modal back to a logged-out state and shows the PIN screen.
function showLoginScreen() {
  currentStaff = null;
  document.getElementById('topbar-staff-info').classList.add('hidden');
  document.getElementById('topbar-shift-info').classList.add('hidden');
  document.getElementById('auth-login-error').classList.add('hidden');
  loginPinInput.value = '';
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
  switchToView('order');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('auth-setup').classList.add('hidden');
  document.getElementById('auth-login').classList.remove('hidden');
  loginPinInput.focus();
}

document.getElementById('lock-btn').addEventListener('click', async () => {
  try {
    await window.pos.staff.logout();
  } catch (err) {
    // Not expected to ever throw, but showLoginScreen() runs regardless —
    // locking the screen locally is more important than surfacing this.
  }
  showLoginScreen();
});

// Staff management (Settings) can change or end the CURRENTLY logged-in
// session's own account (self-demotion with another owner present, or
// self-deactivation/self-deletion) — main.js keeps its own currentStaff in
// sync server-side, but this renderer's copy and the visible UI (tabs,
// topbar name) don't know unless something re-checks. Called after every
// staff:update/staff:delete in the management list.
async function syncSessionAfterStaffChange() {
  if (!currentStaff) return;
  const whoAmI = await window.pos.staff.whoAmI();
  if (!whoAmI) {
    showLoginScreen();
  } else if (whoAmI.role !== currentStaff.role || whoAmI.name !== currentStaff.name) {
    currentStaff = whoAmI;
    document.getElementById('topbar-staff-name').textContent = `${whoAmI.name} · ${whoAmI.role}`;
    applyRolePermissions();
  }
}

// ---------------- Shift open/close ----------------
// The drawer is shared and physical — one shift open at a time for the
// whole terminal, not per-staff-member, and anyone logged in can open or
// close it (whoever's at the counter when it needs doing), not just
// whoever opened it. See shifts.opening_payment_id in schema.sql for how
// "sales during this shift" is actually computed.
async function refreshShiftStatus() {
  openShift = await window.pos.shifts.current();
  const statusEl = document.getElementById('topbar-shift-status');
  const actionBtn = document.getElementById('shift-action-btn');
  if (openShift) {
    statusEl.textContent = `Shift open · ${escapeHtml(openShift.opened_by_name)} · float ₹${money(openShift.opening_float)}`;
    actionBtn.textContent = 'Close Shift';
  } else {
    statusEl.textContent = 'No shift open';
    actionBtn.textContent = 'Start Shift';
  }
}

document.getElementById('shift-action-btn').addEventListener('click', () => {
  if (openShift) {
    openShiftCloseModal();
  } else {
    document.getElementById('shift-open-float').value = '0';
    document.getElementById('shift-open-error').classList.add('hidden');
    document.getElementById('shift-open-modal').classList.remove('hidden');
  }
});

document.getElementById('shift-open-cancel-btn').addEventListener('click', () => {
  document.getElementById('shift-open-modal').classList.add('hidden');
});

document.getElementById('shift-open-confirm-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('shift-open-error');
  errEl.classList.add('hidden');
  const openingFloat = Number(document.getElementById('shift-open-float').value);
  try {
    await window.pos.shifts.open({ openingFloat });
    document.getElementById('shift-open-modal').classList.add('hidden');
    await refreshShiftStatus();
  } catch (err) {
    showAuthError(errEl, err.message);
  }
});

async function openShiftCloseModal() {
  const errEl = document.getElementById('shift-close-error');
  errEl.classList.add('hidden');
  document.getElementById('shift-close-counted').value = '';
  document.getElementById('shift-close-notes').value = '';
  document.getElementById('shift-close-diff').classList.add('hidden');

  let preview;
  try {
    preview = await window.pos.shifts.preview();
  } catch (err) {
    alert(`Could not load shift summary: ${err.message}`);
    return;
  }

  document.getElementById('shift-close-summary').innerHTML = `
    <div class="receipt-row"><span>Opened by</span><span>${escapeHtml(preview.shift.opened_by_name)} · ${formatOrderDate(preview.shift.opened_at)}</span></div>
    <div class="receipt-row"><span>Opening float</span><span>₹${money(preview.shift.opening_float)}</span></div>
    <div class="receipt-row"><span>Cash sales</span><span>₹${money(preview.cashSales)}</span></div>
    <div class="receipt-row"><span>Card sales</span><span>₹${money(preview.cardSales)}</span></div>
    <div class="receipt-row"><span>UPI sales</span><span>₹${money(preview.upiSales)}</span></div>
    <div class="receipt-row"><span>Orders</span><span>${preview.orderCount}</span></div>
    <div class="receipt-row receipt-total"><span>Expected cash</span><span>₹${money(preview.expectedCash)}</span></div>
  `;
  document.getElementById('shift-close-modal').dataset.expectedCash = preview.expectedCash;
  document.getElementById('shift-close-modal').classList.remove('hidden');
  document.getElementById('shift-close-counted').focus();
}

document.getElementById('shift-close-counted').addEventListener('input', (e) => {
  const diffEl = document.getElementById('shift-close-diff');
  const expected = Number(document.getElementById('shift-close-modal').dataset.expectedCash);
  const counted = Number(e.target.value);
  if (e.target.value === '' || !Number.isFinite(counted)) { diffEl.classList.add('hidden'); return; }
  const diff = +(counted - expected).toFixed(2);
  if (Math.abs(diff) < 0.01) {
    diffEl.textContent = 'Matches exactly.';
    diffEl.className = 'shift-close-diff';
  } else if (diff > 0) {
    diffEl.textContent = `₹${money(diff)} over.`;
    diffEl.className = 'shift-close-diff shift-diff-over';
  } else {
    diffEl.textContent = `₹${money(Math.abs(diff))} short.`;
    diffEl.className = 'shift-close-diff shift-diff-short';
  }
});

document.getElementById('shift-close-cancel-btn').addEventListener('click', () => {
  document.getElementById('shift-close-modal').classList.add('hidden');
});

document.getElementById('shift-close-confirm-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('shift-close-error');
  errEl.classList.add('hidden');
  const countedCashRaw = document.getElementById('shift-close-counted').value.trim();
  const notes = document.getElementById('shift-close-notes').value.trim();
  // Number('') is 0, not NaN — without this explicit blank check, leaving
  // the field empty and clicking Close Shift would silently reconcile as
  // "counted ₹0 in the drawer" instead of rejecting the missing entry
  // (same class of bug as the Default GST % field, fixed earlier).
  if (countedCashRaw === '') {
    showAuthError(errEl, 'Enter the counted cash amount.');
    return;
  }
  const countedCash = Number(countedCashRaw);
  if (!Number.isFinite(countedCash) || countedCash < 0) {
    showAuthError(errEl, 'Enter a valid counted cash amount.');
    return;
  }
  try {
    await window.pos.shifts.close({ countedCash, notes });
    document.getElementById('shift-close-modal').classList.add('hidden');
    await refreshShiftStatus();
  } catch (err) {
    showAuthError(errEl, err.message);
  }
});

// ---------------- View switching ----------------
const VIEWS = ['order', 'tables', 'orders', 'reports', 'menu', 'settings'];

function switchToView(view) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  VIEWS.forEach((v) => document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view));
  if (view === 'menu') renderItemTable();
  if (view === 'tables') loadTables();
  if (view === 'orders') loadOrdersList();
  if (view === 'reports') loadReports();
  if (view === 'settings') loadSettings();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchToView(btn.dataset.view));
});

// ---------------- Load reference data ----------------
async function loadReferenceData() {
  categories = await window.pos.categories.list();
  subcategories = await window.pos.subcategories.list();
  menuItems = await window.pos.menu.list();
  restaurantTables = await window.pos.tables.list();
  const settings = await window.pos.settings.get();
  defaultTaxPercent = settings.defaultTaxPercent;
  renderCategoryTabs();
  renderSubcategoryTabs();
  renderMenuGrid();
  populateCategorySelect();
  populateSubcategoryParentSelect();
  populateBulkGstScopeSelect();
  renderCategoryManageList();
  updateTableFieldVisibility();
  renderTicket();
}

// Dine-in orders pick a real table (linked by id, same as tapping a tile on
// the Tables tab — this is what makes occupancy tracking work); takeaway/
// delivery have no physical table, so they get a free-text reference
// instead. Only one of the two fields is ever visible at a time.
function populateTableSelect() {
  const select = document.getElementById('table-select');
  const currentValue = select.value;
  select.innerHTML = restaurantTables.map((t) => {
    const occupied = !!t.order_id;
    const label = `${t.name}${t.seats ? ` (${t.seats} pax)` : ''}${occupied ? ' — occupied' : ''}`;
    return `<option value="${t.id}" ${occupied ? 'disabled' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  if (restaurantTables.some((t) => String(t.id) === currentValue)) select.value = currentValue;
}

function updateTableFieldVisibility() {
  const isDineIn = document.getElementById('order-type').value === 'dine-in';
  document.getElementById('table-select-field').classList.toggle('hidden', !isDineIn);
  document.getElementById('table-label-field').classList.toggle('hidden', isDineIn);
  if (isDineIn) populateTableSelect();
}

document.getElementById('order-type').addEventListener('change', updateTableFieldVisibility);

function resetTableFields() {
  document.getElementById('table-label').value = '';
  document.getElementById('table-select').value = '';
}

function renderCategoryManageList() {
  const wrap = document.getElementById('category-manage-list');
  if (!categories.length) {
    wrap.innerHTML = '<p class="category-manage-empty">No categories yet — add one above.</p>';
    return;
  }
  wrap.innerHTML = '';
  categories.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'category-manage-row';
    const subs = subcategories.filter((s) => s.category_id === c.id);
    row.innerHTML = `
      <span class="category-manage-name">${escapeHtml(c.name)}</span>
      <button class="link-btn danger" data-action="delete-category" data-id="${c.id}">Delete</button>
      ${subs.map((s) => `
        <span class="subcategory-pill">
          ${escapeHtml(s.name)}
          <button class="link-btn danger" data-action="delete-subcategory" data-id="${s.id}">&times;</button>
        </span>
      `).join('')}
    `;
    row.querySelector('[data-action="delete-category"]').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete category "${c.name}"? Its subcategories will be removed too.`))) return;
      try {
        await window.pos.categories.delete(c.id);
        await reloadCategoryData();
      } catch (err) {
        alert(`Could not delete category: ${err.message}`);
      }
    });
    row.querySelectorAll('[data-action="delete-subcategory"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sub = subs.find((s) => s.id === Number(btn.dataset.id));
        if (!(await confirmDialog(`Delete subcategory "${sub.name}"?`))) return;
        try {
          await window.pos.subcategories.delete(sub.id);
          await reloadCategoryData();
        } catch (err) {
          alert(`Could not delete subcategory: ${err.message}`);
        }
      });
    });
    wrap.appendChild(row);
  });
}

async function reloadCategoryData() {
  categories = await window.pos.categories.list();
  subcategories = await window.pos.subcategories.list();
  renderCategoryTabs();
  renderSubcategoryTabs();
  populateCategorySelect();
  populateSubcategoryParentSelect();
  populateBulkGstScopeSelect();
  renderCategoryManageList();
}

function renderCategoryTabs() {
  const wrap = document.getElementById('category-tabs');
  wrap.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.className = 'category-chip' + (activeCategory === 'all' ? ' active' : '');
  allChip.textContent = 'All';
  allChip.addEventListener('click', () => {
    activeCategory = 'all';
    activeSubcategory = 'all';
    renderCategoryTabs(); renderSubcategoryTabs(); renderMenuGrid();
  });
  wrap.appendChild(allChip);

  categories.forEach((c) => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (activeCategory === c.id ? ' active' : '');
    chip.textContent = c.name;
    chip.addEventListener('click', () => {
      activeCategory = c.id;
      activeSubcategory = 'all';
      renderCategoryTabs(); renderSubcategoryTabs(); renderMenuGrid();
    });
    wrap.appendChild(chip);
  });
}

function renderSubcategoryTabs() {
  const wrap = document.getElementById('subcategory-tabs');
  const subs = activeCategory === 'all' ? [] : subcategories.filter((s) => s.category_id === activeCategory);
  if (subs.length === 0) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  const allChip = document.createElement('button');
  allChip.className = 'subcategory-chip' + (activeSubcategory === 'all' ? ' active' : '');
  allChip.textContent = 'All';
  allChip.addEventListener('click', () => { activeSubcategory = 'all'; renderSubcategoryTabs(); renderMenuGrid(); });
  wrap.appendChild(allChip);

  subs.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = 'subcategory-chip' + (activeSubcategory === s.id ? ' active' : '');
    chip.textContent = s.name;
    chip.addEventListener('click', () => { activeSubcategory = s.id; renderSubcategoryTabs(); renderMenuGrid(); });
    wrap.appendChild(chip);
  });
}

function renderMenuGrid() {
  const grid = document.getElementById('menu-grid');
  grid.innerHTML = '';
  const items = menuItems.filter((m) => {
    if (activeCategory !== 'all' && m.category_id !== activeCategory) return false;
    if (activeSubcategory !== 'all' && m.subcategory_id !== activeSubcategory) return false;
    return true;
  });
  items.forEach((item) => {
    const tile = document.createElement('button');
    tile.className = 'menu-tile' + (item.is_available ? '' : ' unavailable');
    tile.disabled = !item.is_available;
    tile.innerHTML = `
      <span class="menu-tile-name">${escapeHtml(item.name)}</span>
      <span class="menu-tile-price">₹${money(item.price)}</span>
      ${item.stock_quantity != null ? `<span class="menu-tile-stock">${item.stock_quantity} left</span>` : ''}
    `;
    tile.addEventListener('click', () => addItemToOrder(item));
    grid.appendChild(tile);
  });
}

function populateCategorySelect() {
  const sel = document.getElementById('item-category');
  sel.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function populateItemSubcategorySelect(categoryId, selectedId) {
  const sel = document.getElementById('item-subcategory');
  const subs = subcategories.filter((s) => s.category_id === Number(categoryId));
  sel.innerHTML = '<option value="">None</option>' + subs.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = selectedId || '';
}

document.getElementById('item-category').addEventListener('change', (e) => {
  populateItemSubcategorySelect(e.target.value, null);
});

function populateSubcategoryParentSelect() {
  const sel = document.getElementById('new-subcategory-parent');
  sel.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function populateBulkGstScopeSelect() {
  const sel = document.getElementById('bulk-gst-scope');
  sel.innerHTML = '<option value="">All items</option>' +
    categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

document.getElementById('bulk-gst-apply-btn').addEventListener('click', async () => {
  const rateInput = document.getElementById('bulk-gst-rate');
  // Number('') is 0, not NaN — an explicit blank check keeps a cleared
  // field from silently applying 0% GST to a whole category.
  if (rateInput.value.trim() === '') {
    alert('Enter a GST percentage.');
    return;
  }
  const rate = Number(rateInput.value);
  if (isNaN(rate) || rate < 0) {
    alert('Enter a valid GST percentage.');
    return;
  }
  const scopeValue = document.getElementById('bulk-gst-scope').value;
  const categoryId = scopeValue ? Number(scopeValue) : null;
  const affected = categoryId
    ? menuItems.filter((m) => m.category_id === categoryId).length
    : menuItems.length;
  const scopeCategory = categoryId ? categories.find((c) => c.id === categoryId) : null;
  const scopeLabel = scopeCategory ? scopeCategory.name : 'all items';
  if (!(await confirmDialog(`Set GST % to ${rate}% for ${affected} item(s) in ${scopeLabel}?`))) return;

  try {
    await window.pos.menu.bulkSetGstRate({ gstRate: rate, categoryId });
    menuItems = await window.pos.menu.list();
    renderMenuGrid();
    renderItemTable();
    document.getElementById('bulk-gst-rate').value = '';
  } catch (err) {
    alert(`Could not update GST %: ${err.message}`);
  }
});

document.getElementById('add-category-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-category-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    await window.pos.categories.add(name);
    input.value = '';
    await reloadCategoryData();
  } catch (err) {
    alert(`Could not add category: ${err.message}`);
  }
});

document.getElementById('add-subcategory-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-subcategory-name');
  const name = nameInput.value.trim();
  const categoryId = Number(document.getElementById('new-subcategory-parent').value);
  if (!name) return;
  if (!categoryId) { alert('Add a category first, then pick it under "Under category".'); return; }
  try {
    await window.pos.subcategories.add({ name, categoryId });
    nameInput.value = '';
    await reloadCategoryData();
  } catch (err) {
    alert(`Could not add subcategory: ${err.message}`);
  }
});

// ---------------- Order ticket ----------------
document.getElementById('new-order-btn').addEventListener('click', async () => {
  try {
    await startNewOrder(false);
  } catch (err) {
    alert(`Could not start order: ${err.message}`);
  }
});

async function startNewOrder(force) {
  if (!force && currentOrder) {
    if (!currentOrder.items || currentOrder.items.length === 0) {
      // Already sitting on a fresh, unused order — repeated clicks shouldn't spawn more.
      return;
    }
    const label = currentOrder.table_label ? ` (${currentOrder.table_label})` : '';
    const proceed = await confirmDialog(
      `Order #${currentOrder.id}${label} is still open with items in it. Start a separate new order?\n\nThe current one stays open — resume it later from the Orders tab.`
    );
    if (!proceed) return;
  }
  const orderType = document.getElementById('order-type').value;
  const source = document.getElementById('order-source').value;
  let tableLabel = '';
  let tableId = null;
  if (orderType === 'dine-in') {
    const selected = document.getElementById('table-select').value;
    if (selected) tableId = Number(selected);
  } else {
    tableLabel = document.getElementById('table-label').value.trim();
  }
  currentOrder = await window.pos.orders.create({ orderType, tableLabel, source, tableId });
  currentOrder.items = [];
  renderTicket();
}

async function ensureOrder() {
  if (!currentOrder) await startNewOrder();
  return currentOrder;
}

document.getElementById('cancel-order-btn').addEventListener('click', async () => {
  if (!currentOrder) return;
  const itemCount = currentOrder.items ? currentOrder.items.length : 0;
  const warning = itemCount > 0
    ? `Cancel order #${currentOrder.id}? It has ${itemCount} item(s) on it — this can't be undone.`
    : `Cancel order #${currentOrder.id}?`;
  if (!(await confirmDialog(warning))) return;
  try {
    await window.pos.orders.cancel(currentOrder.id);
    currentOrder = null;
    resetTableFields();
    renderTicket();
  } catch (err) {
    alert(`Could not cancel order: ${err.message}`);
  }
});

// Dispatcher for tapping a menu tile: items with modifier groups need a
// picker first (size/add-ons/etc.), plain items go straight onto the ticket
// exactly as before this feature existed.
async function addItemToOrder(menuItem) {
  if (menuItem.modifier_group_count > 0) {
    await openModifierPicker(menuItem);
    return;
  }
  await addItemToOrderWithModifiers(menuItem, []);
}

async function addItemToOrderWithModifiers(menuItem, modifierOptionIds) {
  try {
    await ensureOrder();
    const updatedOrder = await window.pos.orders.addItem({
      orderId: currentOrder.id,
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      quantity: 1,
      modifierOptionIds,
    });
    await refreshCurrentOrder(updatedOrder);
  } catch (err) {
    alert(`Could not add item: ${err.message}`);
  }
}

// ---------------- Item modifier picker (Take Order) ----------------
let modifierPickerItem = null;
let modifierPickerGroups = [];

async function openModifierPicker(menuItem) {
  modifierPickerItem = menuItem;
  try {
    modifierPickerGroups = await window.pos.modifiers.listGroups(menuItem.id);
  } catch (err) {
    alert(`Could not load options: ${err.message}`);
    modifierPickerItem = null;
    return;
  }
  document.getElementById('item-modifier-picker-title').textContent = menuItem.name;
  const wrap = document.getElementById('item-modifier-picker-groups');
  wrap.innerHTML = modifierPickerGroups.map((g) => {
    // A required single-choice group (min 1, max 1 — e.g. "Size") is a
    // real radio: exactly one is always selected, nothing to deselect to.
    // An OPTIONAL single-choice group (min 0, max 1 — "pick one if you
    // want") still needs checkbox semantics even though at most one may be
    // checked, because native radios can't be clicked back to unchecked —
    // the mutual-exclusivity is enforced by the listener wired below instead.
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
            ${Number(o.price_delta) !== 0 ? `<span class="modifier-option-price">${Number(o.price_delta) > 0 ? '+' : '−'}₹${money(Math.abs(o.price_delta))}</span>` : ''}
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
  document.getElementById('item-modifier-picker-modal').classList.remove('hidden');
}

document.getElementById('item-modifier-picker-cancel-btn').addEventListener('click', () => {
  document.getElementById('item-modifier-picker-modal').classList.add('hidden');
  modifierPickerItem = null;
});

document.getElementById('item-modifier-picker-add-btn').addEventListener('click', async () => {
  for (const g of modifierPickerGroups) {
    const checked = document.querySelectorAll(`input[name="modifier-group-${g.id}"]:checked`);
    if (checked.length < g.min_select || checked.length > g.max_select) {
      alert(`"${g.name}" needs between ${g.min_select} and ${g.max_select} selection(s).`);
      return;
    }
  }
  const selectedIds = Array.from(document.querySelectorAll('#item-modifier-picker-groups input:checked')).map((el) => Number(el.value));
  const item = modifierPickerItem;
  document.getElementById('item-modifier-picker-modal').classList.add('hidden');
  modifierPickerItem = null;
  await addItemToOrderWithModifiers(item, selectedIds);
});

async function refreshCurrentOrder(orderHeader) {
  const full = await window.pos.orders.get(currentOrder.id);
  currentOrder = full;
  document.getElementById('discount-input').value = full.discount;
  renderTicket();
}

function renderTicket() {
  const idEl = document.getElementById('ticket-order-id');
  const itemsEl = document.getElementById('ticket-items');
  const checkoutBtn = document.getElementById('checkout-btn');
  const cancelOrderBtn = document.getElementById('cancel-order-btn');
  const kotBtn = document.getElementById('kot-print-btn');

  if (!currentOrder) {
    idEl.textContent = '—';
    itemsEl.innerHTML = '<p class="ticket-empty">No items yet. Tap a dish to add it.</p>';
    cancelOrderBtn.classList.add('hidden');
    setTotals(0, 0, 0, 0);
    checkoutBtn.disabled = true;
    kotBtn.disabled = true;
    kotBtn.textContent = 'Send to Kitchen';
    return;
  }

  const unfiredCount = (currentOrder.items || []).filter((i) => !i.kot_fired_at).length;
  kotBtn.disabled = unfiredCount === 0;
  kotBtn.textContent = unfiredCount > 0 ? `Send to Kitchen (${unfiredCount})` : 'Send to Kitchen';

  cancelOrderBtn.classList.remove('hidden');
  const sourceTag = currentOrder.source && currentOrder.source !== 'in-house' ? ` · ${currentOrder.source}` : '';
  idEl.textContent = `#${currentOrder.id} · ${currentOrder.order_type}${currentOrder.table_label ? ' · ' + currentOrder.table_label : ''}${sourceTag}`;

  if (!currentOrder.items || currentOrder.items.length === 0) {
    itemsEl.innerHTML = '<p class="ticket-empty">No items yet. Tap a dish to add it.</p>';
    checkoutBtn.disabled = true;
  } else {
    itemsEl.innerHTML = '';
    currentOrder.items.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'ticket-line';
      const modNames = (line.modifiers || []).map((m) => m.name).join(', ');
      row.innerHTML = `
        <span class="ticket-line-name">${escapeHtml(line.item_name)}${modNames ? `<span class="ticket-line-modifiers">${escapeHtml(modNames)}</span>` : ''}</span>
        <span class="ticket-line-qty">
          <button class="qty-btn" data-action="dec">&minus;</button>
          <span>${line.quantity}</span>
          <button class="qty-btn" data-action="inc">+</button>
        </span>
        <span class="ticket-line-price">₹${money(line.unit_price * line.quantity)}</span>
      `;
      row.querySelector('[data-action="dec"]').addEventListener('click', () => changeQty(line, line.quantity - 1));
      row.querySelector('[data-action="inc"]').addEventListener('click', () => changeQty(line, line.quantity + 1));
      itemsEl.appendChild(row);
    });
    checkoutBtn.disabled = false;
  }

  setTotals(currentOrder.subtotal, currentOrder.tax_amount, currentOrder.discount, currentOrder.total);
}

function setTotals(subtotal, tax, discount, total) {
  document.getElementById('sum-subtotal').textContent = money(subtotal);
  document.getElementById('sum-tax').textContent = money(tax);
  document.getElementById('sum-discount').textContent = `−${money(discount)}`;
  document.getElementById('sum-total').textContent = money(total);
  document.getElementById('payment-total').textContent = money(total);
}

async function changeQty(line, newQty) {
  try {
    const updated = await window.pos.orders.updateItemQty({
      orderItemId: line.id, quantity: newQty, orderId: currentOrder.id,
    });
    await refreshCurrentOrder(updated);
  } catch (err) {
    alert(`Could not update quantity: ${err.message}`);
  }
}

document.getElementById('discount-input').addEventListener('change', async (e) => {
  try {
    await ensureOrder();
    const updated = await window.pos.orders.setDiscount({ orderId: currentOrder.id, discount: Number(e.target.value) });
    await refreshCurrentOrder(updated);
  } catch (err) {
    alert(`Could not update discount: ${err.message}`);
  }
});

document.getElementById('kot-print-btn').addEventListener('click', async () => {
  if (!currentOrder) return;
  // Captured from local state before the IPC call, not from its result —
  // receipt:printKot only returns a count, and by the time it resolves the
  // backend has already marked these items fired, so this is the only place
  // that still knows exactly which lines were "new" for this ticket.
  const unfiredItems = (currentOrder.items || []).filter((i) => !i.kot_fired_at);
  if (!unfiredItems.length) return;
  const kotBtn = document.getElementById('kot-print-btn');
  // Disabled for the duration of the call, same guard pattern as the
  // payment-mode buttons — receipt:printKot reads "still unfired" and marks
  // items fired in two separate steps around an await, so a second click
  // fired before the first call returns would see the same unfired items
  // and send this ticket to the kitchen twice.
  kotBtn.disabled = true;
  try {
    const result = await window.pos.receipt.printKot({ orderId: currentOrder.id });
    if (result.mode === 'dialog') {
      renderKotPrintBody(currentOrder, unfiredItems);
      document.body.classList.add('printing-kot');
      window.print();
      document.body.classList.remove('printing-kot');
      // Only now mark these items fired (see the comment on receipt:printKot's
      // 'dialog' branch in main.js) — window.print() has actually returned,
      // so a cancelled/failed dialog print no longer leaves the items
      // silently marked as sent when they never really were.
      await window.pos.receipt.confirmKotPrinted({ itemIds: result.itemIds });
    }
    // refreshCurrentOrder() re-renders the ticket, which sets kotBtn.disabled
    // from the fresh unfired-item count — nothing left to do here on success.
    await refreshCurrentOrder(currentOrder);
  } catch (err) {
    // Nothing changed: these items are still unfired, so it's safe (and
    // necessary) to let the user retry.
    kotBtn.disabled = false;
    alert(`Could not send to kitchen: ${err.message}`);
  }
});

function renderKotPrintBody(order, items) {
  const body = document.getElementById('kot-print-body');
  const typeValue = `${order.order_type}${order.table_label ? ' · ' + order.table_label : ''}`;
  const itemsHtml = items.map((i) => {
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    return `
    <div class="kot-print-item">
      <div class="kot-print-item-row"><span>${escapeHtml(i.item_name)}</span><span>x${i.quantity}</span></div>
      ${modNames ? `<div class="kot-print-item-notes">${escapeHtml(modNames)}</div>` : ''}
      ${i.notes ? `<div class="kot-print-item-notes">${escapeHtml(i.notes)}</div>` : ''}
    </div>
  `;
  }).join('');
  body.innerHTML = `
    <div class="kot-print-title">KITCHEN ORDER TICKET</div>
    <div class="kot-print-meta">${escapeHtml(typeValue)} · Order #${order.id}</div>
    <div class="kot-print-meta">${new Date().toLocaleString()}</div>
    <hr>
    ${itemsHtml}
  `;
}

// ---------------- Tables ----------------
async function loadTables() {
  restaurantTables = await window.pos.tables.list();
  renderTablesGrid();
  renderTableManageList();
}

function minutesSince(timestamp) {
  if (!timestamp) return 0;
  const then = new Date(timestamp.replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.round((Date.now() - then) / 60000));
}

function renderTablesGrid() {
  const grid = document.getElementById('tables-grid');
  grid.innerHTML = '';
  if (!restaurantTables.length) {
    grid.innerHTML = '<p class="ticket-empty">No tables yet — add one above.</p>';
    return;
  }
  restaurantTables.forEach((t) => {
    const occupied = !!t.order_id;
    const tile = document.createElement('button');
    tile.className = 'menu-tile';
    tile.innerHTML = `
      <span class="menu-tile-name">${escapeHtml(t.name)}</span>
      ${t.seats ? `<span class="table-tile-meta">${t.seats} pax</span>` : ''}
      ${occupied
        ? `<span class="status-pill open">Occupied</span><span class="menu-tile-price">₹${money(t.order_total)}</span><span class="table-tile-meta">${minutesSince(t.order_created_at)} min</span>`
        : `<span class="status-pill available">Free</span>`}
    `;
    tile.addEventListener('click', () => {
      if (occupied) {
        resumeOrder(t.order_id);
      } else {
        startOrderForTable(t);
      }
    });
    grid.appendChild(tile);
  });
}

function renderTableManageList() {
  const wrap = document.getElementById('table-manage-list');
  wrap.innerHTML = '';
  if (!restaurantTables.length) return;
  restaurantTables.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'category-manage-row';
    row.innerHTML = `
      <span class="category-manage-name">${escapeHtml(t.name)}${t.seats ? ` · ${t.seats} pax` : ''}</span>
      <button class="link-btn danger" data-action="delete-table" data-id="${t.id}">Delete</button>
    `;
    row.querySelector('[data-action="delete-table"]').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete table "${t.name}"?`))) return;
      try {
        await window.pos.tables.delete(t.id);
        await loadTables();
      } catch (err) {
        alert(`Could not delete table: ${err.message}`);
      }
    });
    wrap.appendChild(row);
  });
}

document.getElementById('add-table-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-table-name');
  const seatsInput = document.getElementById('new-table-seats');
  const name = nameInput.value.trim();
  if (!name) return;
  const seats = seatsInput.value ? Number(seatsInput.value) : null;
  try {
    await window.pos.tables.add({ name, seats });
    nameInput.value = '';
    seatsInput.value = '';
    await loadTables();
  } catch (err) {
    alert(`Could not add table: ${err.message}`);
  }
});

async function startOrderForTable(table) {
  if (currentOrder && currentOrder.items && currentOrder.items.length > 0) {
    const label = currentOrder.table_label ? ` (${currentOrder.table_label})` : '';
    const proceed = await confirmDialog(
      `Order #${currentOrder.id}${label} is still open with items in it. Start table "${table.name}" as a separate new order?\n\nThe current one stays open — resume it later from the Orders tab.`
    );
    if (!proceed) return;
  }
  try {
    const order = await window.pos.orders.create({ orderType: 'dine-in', tableId: table.id, source: 'in-house' });
    order.items = [];
    currentOrder = order;
    document.getElementById('order-type').value = 'dine-in';
    document.getElementById('order-source').value = 'in-house';
    updateTableFieldVisibility();
    document.getElementById('table-select').value = String(table.id);
    renderTicket();
    switchToView('order');
  } catch (err) {
    alert(`Could not start order: ${err.message}`);
  }
}

// ---------------- Orders list ----------------
const ORDER_STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'paid', label: 'Paid' },
  { key: 'cancelled', label: 'Cancelled' },
];

async function loadOrdersList() {
  allOrders = await window.pos.orders.listAll();
  renderOrdersFilter();
  renderOrdersTable();
}

document.getElementById('orders-customer-search').addEventListener('input', (e) => {
  customerSearchQuery = e.target.value.trim();
  renderOrdersTable();
});

function renderOrdersFilter() {
  const wrap = document.getElementById('orders-filter');
  wrap.innerHTML = '';
  ORDER_STATUSES.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (ordersStatusFilter === s.key ? ' active' : '');
    chip.textContent = s.label;
    chip.addEventListener('click', () => {
      ordersStatusFilter = s.key;
      renderOrdersFilter();
      renderOrdersTable();
    });
    wrap.appendChild(chip);
  });
}

function formatOrderDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp.replace(' ', 'T') + 'Z').toLocaleString();
}

function renderOrdersTable() {
  const tbody = document.getElementById('orders-table-body');
  tbody.innerHTML = '';
  const searchDigits = customerSearchQuery.replace(/\D/g, '');
  const orders = allOrders.filter((o) => {
    if (ordersStatusFilter !== 'all' && o.status !== ordersStatusFilter) return false;
    if (searchDigits && !(o.customer_phone || '').includes(searchDigits)) return false;
    return true;
  });

  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="category-manage-empty">No orders yet.</td></tr>';
    return;
  }

  orders.forEach((o) => {
    const tr = document.createElement('tr');
    const customerText = o.customer_name || o.customer_phone
      ? `${escapeHtml(o.customer_name || '')}${o.customer_name && o.customer_phone ? ' · ' : ''}${escapeHtml(o.customer_phone || '')}`
      : '—';
    tr.innerHTML = `
      <td>#${o.id}</td>
      <td>${escapeHtml(o.order_type)}</td>
      <td>${escapeHtml(o.table_label || '—')}</td>
      <td>${customerText}</td>
      <td>${o.source && o.source !== 'in-house' ? `<span class="status-pill source-${escapeHtml(o.source)}">${escapeHtml(o.source)}</span>` : '—'}</td>
      <td><span class="status-pill ${o.status}">${escapeHtml(o.status)}</span></td>
      <td>₹${money(o.total)}</td>
      <td>${formatOrderDate(o.created_at)}</td>
      <td><div class="row-actions"></div></td>
    `;
    const actionsCell = tr.querySelector('.row-actions');
    if (o.status === 'open') {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'link-btn';
      resumeBtn.textContent = 'Resume';
      resumeBtn.addEventListener('click', () => resumeOrder(o.id));
      actionsCell.appendChild(resumeBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'link-btn danger';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        if (!(await confirmDialog(`Cancel order #${o.id}? This can't be undone.`))) return;
        try {
          await window.pos.orders.cancel(o.id);
          if (currentOrder && currentOrder.id === o.id) {
            currentOrder = null;
            renderTicket();
          }
          await loadOrdersList();
        } catch (err) {
          alert(`Could not cancel order: ${err.message}`);
        }
      });
      actionsCell.appendChild(cancelBtn);
    } else if (o.status === 'paid') {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'link-btn';
      viewBtn.textContent = 'View receipt';
      viewBtn.addEventListener('click', () => viewReceipt(o.id));
      actionsCell.appendChild(viewBtn);
    }
    tbody.appendChild(tr);
  });
}

async function resumeOrder(orderId) {
  currentOrder = await window.pos.orders.get(orderId);
  document.getElementById('discount-input').value = currentOrder.discount;
  renderTicket();
  switchToView('order');
}

// ---------------- Reports ----------------
const REPORT_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

function toLocalDateValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getReportDateRange(key) {
  const now = new Date();
  const end = toLocalDateValue(now);
  if (key === 'today') return { startDate: end, endDate: end };
  if (key === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    return { startDate: toLocalDateValue(start), endDate: end };
  }
  if (key === 'month') {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    return { startDate: toLocalDateValue(start), endDate: end };
  }
  return { startDate: null, endDate: null };
}

function currentReportRange() {
  if (reportsRangeKey === 'custom') {
    return {
      startDate: document.getElementById('reports-from').value || null,
      endDate: document.getElementById('reports-to').value || null,
    };
  }
  return getReportDateRange(reportsRangeKey);
}

function renderReportsFilter() {
  const wrap = document.getElementById('reports-filter');
  wrap.innerHTML = '';
  REPORT_PRESETS.forEach((p) => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (reportsRangeKey === p.key ? ' active' : '');
    chip.textContent = p.label;
    chip.addEventListener('click', () => {
      reportsRangeKey = p.key;
      loadReports();
    });
    wrap.appendChild(chip);
  });
}

document.getElementById('reports-from').addEventListener('change', () => {
  reportsRangeKey = 'custom';
  loadReports();
});
document.getElementById('reports-to').addEventListener('change', () => {
  reportsRangeKey = 'custom';
  loadReports();
});

document.getElementById('reports-export-btn').addEventListener('click', async () => {
  const { startDate, endDate } = currentReportRange();
  const btn = document.getElementById('reports-export-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    const result = await window.pos.reports.exportExcel({ startDate, endDate });
    if (result.success) {
      alert(`Exported ${result.orderCount} order(s) to:\n${result.filePath}`);
    } else if (!result.canceled) {
      alert('Export failed.');
    }
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

function renderReportKpis(data) {
  const wrap = document.getElementById('reports-kpis');
  const avgOrderValue = data.orderCount > 0 ? data.revenue / data.orderCount : 0;
  const tiles = [
    { label: 'Revenue', value: `₹${money(data.revenue)}` },
    { label: 'Orders', value: String(data.orderCount) },
    { label: 'Avg order value', value: `₹${money(avgOrderValue)}` },
    { label: 'Items sold', value: String(data.itemsSold) },
  ];
  wrap.innerHTML = tiles.map((t) => `
    <div class="stat-tile">
      <div class="stat-tile-label">${escapeHtml(t.label)}</div>
      <div class="stat-tile-value">${escapeHtml(t.value)}</div>
    </div>
  `).join('');
}

function renderBarList(containerId, rows, valueFormatter, subFormatter) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  if (!rows.length) {
    wrap.innerHTML = '<p class="bar-list-empty">No sales in this period.</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r.revenue) || 0), 0.01);
  rows.forEach((r) => {
    const pct = Math.max((Number(r.revenue) / max) * 100, 2);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.title = `${r.name}: ${valueFormatter(r)}`;
    row.innerHTML = `
      <div class="bar-row-head">
        <span class="bar-row-name">${escapeHtml(r.name)}${subFormatter ? ` <span class="bar-row-sub">${escapeHtml(subFormatter(r))}</span>` : ''}</span>
        <span class="bar-row-value">${valueFormatter(r)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    `;
    wrap.appendChild(row);
  });
}

async function loadReports() {
  renderReportsFilter();
  const { startDate, endDate } = currentReportRange();
  if (reportsRangeKey !== 'custom') {
    document.getElementById('reports-from').value = startDate || '';
    document.getElementById('reports-to').value = endDate || '';
  }
  const data = await window.pos.reports.summary({ startDate, endDate });
  renderReportKpis(data);
  renderBarList('reports-top-items', data.topItems, (r) => `₹${money(r.revenue)}`, (r) => `· ${r.quantity} sold`);
  renderBarList('reports-by-category', data.byCategory, (r) => `₹${money(r.revenue)}`);
  await renderShiftHistory();
}

async function renderShiftHistory() {
  const tbody = document.getElementById('shift-history-body');
  let shifts;
  try {
    shifts = await window.pos.shifts.history();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="category-manage-empty">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (!shifts.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="category-manage-empty">No closed shifts yet.</td></tr>';
    return;
  }
  tbody.innerHTML = shifts.map((s) => {
    const diff = +(Number(s.counted_cash) - Number(s.expected_cash)).toFixed(2);
    const diffClass = Math.abs(diff) < 0.01 ? '' : diff > 0 ? 'shift-diff-over' : 'shift-diff-short';
    const diffText = Math.abs(diff) < 0.01 ? '—' : `${diff > 0 ? '+' : ''}₹${money(diff)}`;
    return `
      <tr>
        <td>${formatOrderDate(s.opened_at)}</td>
        <td>${formatOrderDate(s.closed_at)}</td>
        <td>${escapeHtml(s.opened_by_name || '—')}</td>
        <td>${escapeHtml(s.closed_by_name || '—')}</td>
        <td>₹${money(s.opening_float)}</td>
        <td>₹${money(s.cash_sales)}</td>
        <td>₹${money(s.card_sales)}</td>
        <td>₹${money(s.upi_sales)}</td>
        <td>₹${money(s.expected_cash)}</td>
        <td>₹${money(s.counted_cash)}</td>
        <td class="${diffClass}">${diffText}</td>
      </tr>
    `;
  }).join('');
}

async function viewReceipt(orderId) {
  viewingHistoricalReceipt = true;
  currentReceiptOrderId = orderId;
  const receipt = await window.pos.billing.getReceipt(orderId);
  renderReceipt(receipt);
  document.getElementById('receipt-close-btn').textContent = 'Close';
  receiptModal.classList.remove('hidden');
}

// ---------------- Billing ----------------
const paymentModal = document.getElementById('payment-modal');
const receiptModal = document.getElementById('receipt-modal');

document.getElementById('checkout-btn').addEventListener('click', () => {
  document.querySelectorAll('.payment-mode-btn').forEach((b) => b.classList.remove('selected'));
  splitPayments = [];
  document.getElementById('split-payment-section').classList.add('hidden');
  document.querySelector('.payment-modes').classList.remove('hidden');
  document.getElementById('split-payment-toggle-btn').textContent = 'Split payment instead';
  renderSplitPaymentList();
  document.getElementById('payment-customer-phone').value = '';
  document.getElementById('payment-customer-name').value = '';
  document.getElementById('payment-customer-hint').classList.add('hidden');
  paymentModal.classList.remove('hidden');
});

// Looks up whether this phone number has ordered before — called on blur
// (covers any format) and as soon as 10 digits are typed (immediate
// feedback for the common India-mobile case, without waiting for blur).
async function lookupCustomerByPhone() {
  const phoneInput = document.getElementById('payment-customer-phone');
  const nameInput = document.getElementById('payment-customer-name');
  const hint = document.getElementById('payment-customer-hint');
  const phone = phoneInput.value.trim();
  if (!phone) { hint.classList.add('hidden'); return; }
  try {
    const found = await window.pos.customers.lookup(phone);
    if (found) {
      if (found.name && !nameInput.value.trim()) nameInput.value = found.name;
      const who = found.name || 'this customer';
      hint.textContent = `Welcome back, ${who} — ${found.visitCount} previous order${found.visitCount === 1 ? '' : 's'}.`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  } catch (err) {
    hint.classList.add('hidden');
  }
}

document.getElementById('payment-customer-phone').addEventListener('blur', lookupCustomerByPhone);
document.getElementById('payment-customer-phone').addEventListener('input', (e) => {
  if (e.target.value.replace(/\D/g, '').length === 10) lookupCustomerByPhone();
});

document.getElementById('payment-cancel-btn').addEventListener('click', () => {
  paymentModal.classList.add('hidden');
});

document.querySelectorAll('.payment-mode-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const allModeBtns = document.querySelectorAll('.payment-mode-btn');
    allModeBtns.forEach((b) => { b.classList.remove('selected'); b.disabled = true; });
    btn.classList.add('selected');
    try {
      await finalizeOrder({ paymentMode: btn.dataset.mode });
    } finally {
      allModeBtns.forEach((b) => { b.disabled = false; });
    }
  });
});

document.getElementById('split-payment-toggle-btn').addEventListener('click', () => {
  const splitSection = document.getElementById('split-payment-section');
  const quickModes = document.querySelector('.payment-modes');
  const toggleBtn = document.getElementById('split-payment-toggle-btn');
  const showingSplit = !splitSection.classList.contains('hidden');
  splitSection.classList.toggle('hidden', showingSplit);
  quickModes.classList.toggle('hidden', !showingSplit);
  toggleBtn.textContent = showingSplit ? 'Split payment instead' : 'Use a single payment method instead';
});

document.getElementById('split-payment-add-btn').addEventListener('click', () => {
  const mode = document.getElementById('split-payment-mode').value;
  const amountInput = document.getElementById('split-payment-amount');
  const amount = Number(amountInput.value);
  const paid = splitPayments.reduce((sum, p) => sum + p.amount, 0);
  const remaining = +(Number(currentOrder.total) - paid).toFixed(2);
  if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a valid amount.'); return; }
  // A small epsilon, not an exact <= remaining check, so a remaining of e.g.
  // 149.999999999998 from prior float additions doesn't reject a ₹150 entry
  // that's actually correct to the paisa.
  if (amount > remaining + 0.01) { alert(`Amount exceeds the remaining ₹${money(remaining)}.`); return; }
  splitPayments.push({ mode, amount: +amount.toFixed(2) });
  amountInput.value = '';
  renderSplitPaymentList();
});

function renderSplitPaymentList() {
  const list = document.getElementById('split-payment-list');
  const remainingEl = document.getElementById('split-payment-remaining');
  const chargeBtn = document.getElementById('split-payment-charge-btn');

  list.innerHTML = splitPayments.map((p, idx) => `
    <div class="split-payment-row">
      <span>${escapeHtml(capitalize(p.mode))}</span>
      <span>₹${money(p.amount)}</span>
      <button type="button" class="link-btn danger" data-idx="${idx}">Remove</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      splitPayments.splice(Number(btn.dataset.idx), 1);
      renderSplitPaymentList();
    });
  });

  const paid = splitPayments.reduce((sum, p) => sum + p.amount, 0);
  const remaining = +(Number(currentOrder ? currentOrder.total : 0) - paid).toFixed(2);
  remainingEl.textContent = money(Math.max(remaining, 0));
  chargeBtn.disabled = !(Math.abs(remaining) < 0.01 && splitPayments.length > 0);
}

document.getElementById('split-payment-charge-btn').addEventListener('click', async () => {
  const chargeBtn = document.getElementById('split-payment-charge-btn');
  chargeBtn.disabled = true;
  try {
    await finalizeOrder({ payments: splitPayments });
  } finally {
    chargeBtn.disabled = false;
  }
});

async function finalizeOrder(payload) {
  viewingHistoricalReceipt = false;
  const customerPhone = document.getElementById('payment-customer-phone').value.trim();
  const customerName = document.getElementById('payment-customer-name').value.trim();
  try {
    await window.pos.billing.finalize({ orderId: currentOrder.id, customerPhone, customerName, ...payload });
    currentReceiptOrderId = currentOrder.id;
    const receipt = await window.pos.billing.getReceipt(currentOrder.id);
    renderReceipt(receipt);
    document.getElementById('receipt-close-btn').textContent = 'New order';
    paymentModal.classList.add('hidden');
    receiptModal.classList.remove('hidden');
  } catch (err) {
    alert(`Could not charge order: ${err.message}`);
  }
}

function renderReceipt(order) {
  const body = document.getElementById('receipt-body');
  const business = order.business || {};
  const dateStr = formatOrderDate(order.paid_at || order.created_at);

  const headerHtml = `
    <div class="receipt-header">
      ${business.name ? `<div class="receipt-business-name">${escapeHtml(business.name)}</div>` : ''}
      ${business.address ? `<div>${escapeHtml(business.address)}</div>` : ''}
      ${business.phone ? `<div>Ph: ${escapeHtml(business.phone)}</div>` : ''}
      ${business.gstin ? `<div>GSTIN: ${escapeHtml(business.gstin)}</div>` : ''}
      ${business.fssaiNo ? `<div>FSSAI: ${escapeHtml(business.fssaiNo)}</div>` : ''}
    </div>
  `;

  const metaHtml = `
    <div class="receipt-meta">
      <div class="receipt-row"><span>${order.invoice_number ? 'Invoice' : 'Order'} #</span><span>${escapeHtml(order.invoice_number || String(order.id))}</span></div>
      <div class="receipt-row"><span>Date</span><span>${dateStr}</span></div>
      <div class="receipt-row"><span>Type</span><span>${escapeHtml(order.order_type)}${order.table_label ? ' · ' + escapeHtml(order.table_label) : ''}</span></div>
      ${order.source === 'zomato' ? `<div class="receipt-row"><span>Source</span><span>Zomato${business.zomatoRestaurantId ? ' · ' + escapeHtml(business.zomatoRestaurantId) : ''}</span></div>` : ''}
      ${order.customer_name || order.customer_phone ? `<div class="receipt-row"><span>Customer</span><span>${escapeHtml(order.customer_name || '')}${order.customer_name && order.customer_phone ? ' · ' : ''}${escapeHtml(order.customer_phone || '')}</span></div>` : ''}
    </div>
  `;

  const itemsRows = order.items.map((i) => {
    const modNames = (i.modifiers || []).map((m) => m.name).join(', ');
    return `
    <tr>
      <td>${escapeHtml(i.item_name)}${modNames ? `<div class="receipt-item-modifiers">${escapeHtml(modNames)}</div>` : ''}</td>
      <td>${i.quantity}</td>
      <td>${money(i.unit_price)}</td>
      <td>${money(i.unit_price * i.quantity)}</td>
    </tr>
  `;
  }).join('');
  const itemsHtml = `
    <div class="receipt-section-title">Items</div>
    <table class="receipt-items-table">
      <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amt</th></tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
  `;

  const totalsHtml = `
    <div class="receipt-row"><span>Subtotal</span><span>₹${money(order.subtotal)}</span></div>
    ${Number(order.discount) > 0 ? `<div class="receipt-row"><span>Discount</span><span>−₹${money(order.discount)}</span></div>` : ''}
    <div class="receipt-row"><span>Tax (GST)</span><span>₹${money(order.tax_amount)}</span></div>
    <div class="receipt-row receipt-total"><span>Total</span><span>₹${money(order.total)}</span></div>
  `;

  const gstRows = (order.gstBreakdown || []).filter((g) => g.gstRate > 0);
  const gstHtml = gstRows.length ? `
    <div class="receipt-section-title">GST Details</div>
    <table class="receipt-gst-table">
      <thead><tr><th>HSN</th><th>Tax%</th><th>CGST</th><th>SGST</th></tr></thead>
      <tbody>
        ${gstRows.map((g) => `
          <tr>
            <td>${escapeHtml(g.hsnCode || '—')}</td>
            <td>${g.gstRate}</td>
            <td>${money(g.cgst)}</td>
            <td>${money(g.sgst)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  const paymentText = order.payments && order.payments.length > 1
    ? 'Paid via: ' + order.payments.map((p) => `${capitalize(p.mode)} ₹${money(p.amount)}`).join(', ')
    : order.payment_mode ? `Paid via ${order.payment_mode}` : '';
  const paymentHtml = paymentText ? `<div style="margin-top:8px;">${escapeHtml(paymentText)}</div>` : '';

  const qrHtml = order.qrDataUrl ? `
    <div class="receipt-qr">
      <img src="${order.qrDataUrl}" alt="Scan and pay QR code" />
      <div>Scan and Pay</div>
    </div>
  ` : '';

  const footerHtml = business.footerNote ? `<div class="receipt-footer">${escapeHtml(business.footerNote)}</div>` : '';

  body.innerHTML = headerHtml + metaHtml + itemsHtml + totalsHtml + gstHtml + paymentHtml + qrHtml + footerHtml;
}

document.getElementById('receipt-print-btn').addEventListener('click', async () => {
  try {
    const result = await window.pos.receipt.print({ orderId: currentReceiptOrderId });
    // 'dialog' (the default/unset printer_mode) means the backend did nothing
    // and the renderer must fall back to window.print() itself — exactly as
    // before this feature existed, so every install with no printer
    // configured yet keeps behaving identically.
    if (result.mode === 'dialog') {
      window.print();
    }
  } catch (err) {
    alert(`Could not print: ${err.message}`);
  }
});

document.getElementById('receipt-close-btn').addEventListener('click', () => {
  receiptModal.classList.add('hidden');
  if (!viewingHistoricalReceipt) {
    currentOrder = null;
    resetTableFields();
    renderTicket();
  }
  viewingHistoricalReceipt = false;
});

// ---------------- Menu management ----------------
const itemModal = document.getElementById('item-modal');
let editingItemId = null;

document.getElementById('add-item-btn').addEventListener('click', () => openItemModal(null));

function openItemModal(item) {
  editingItemId = item ? item.id : null;
  document.getElementById('item-modal-title').textContent = item ? 'Edit menu item' : 'Add menu item';
  document.getElementById('item-name').value = item ? item.name : '';
  document.getElementById('item-price').value = item ? item.price : '';
  const categoryId = item ? item.category_id : (categories[0] && categories[0].id);
  document.getElementById('item-category').value = categoryId;
  populateItemSubcategorySelect(categoryId, item ? item.subcategory_id : null);
  document.getElementById('item-hsn-code').value = item ? (item.hsn_code || '') : '';
  document.getElementById('item-gst-rate').value = item ? item.gst_rate : defaultTaxPercent;
  document.getElementById('item-available').checked = item ? item.is_available : true;
  itemModal.classList.remove('hidden');
}

document.getElementById('item-cancel-btn').addEventListener('click', () => itemModal.classList.add('hidden'));

document.getElementById('item-save-btn').addEventListener('click', async () => {
  const subcategoryValue = document.getElementById('item-subcategory').value;
  const priceRaw = document.getElementById('item-price').value.trim();
  const gstRateRaw = document.getElementById('item-gst-rate').value.trim();
  const payload = {
    id: editingItemId,
    name: document.getElementById('item-name').value.trim(),
    price: Number(priceRaw),
    categoryId: Number(document.getElementById('item-category').value),
    subcategoryId: subcategoryValue ? Number(subcategoryValue) : null,
    hsnCode: document.getElementById('item-hsn-code').value.trim(),
    gstRate: Number(gstRateRaw),
    isAvailable: document.getElementById('item-available').checked,
  };
  // Number('') is 0, not NaN — without the blank checks below, clearing
  // Price or GST % and saving would silently create a free (₹0) or
  // 0%-taxed item instead of being rejected.
  if (!payload.name || priceRaw === '' || gstRateRaw === '' || isNaN(payload.price) || isNaN(payload.gstRate)) return;

  if (editingItemId) {
    await window.pos.menu.update(payload);
  } else {
    await window.pos.menu.add(payload);
  }
  itemModal.classList.add('hidden');
  menuItems = await window.pos.menu.list();
  renderMenuGrid();
  renderItemTable();
});

function renderItemTable() {
  const tbody = document.getElementById('item-table-body');
  tbody.innerHTML = '';
  menuItems.forEach((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.category_name || '—')}</td>
      <td>${escapeHtml(item.subcategory_name || '—')}</td>
      <td>${escapeHtml(item.hsn_code || '—')}</td>
      <td>${item.gst_rate}%</td>
      <td>₹${money(item.price)}</td>
      <td><input type="number" class="stock-input" min="0" step="1" placeholder="∞" value="${item.stock_quantity ?? ''}" /></td>
      <td><span class="status-pill ${item.is_available ? 'available' : 'unavailable'}${item.stock_quantity != null ? ' locked' : ''}" ${item.stock_quantity != null ? 'title="Stock-tracked — availability follows the stock quantity"' : ''}>${item.is_available ? 'Available' : 'Unavailable'}</span></td>
      <td><div class="row-actions">
        <button class="link-btn" data-action="edit">Edit</button>
        <button class="link-btn" data-action="modifiers">Modifiers</button>
        <button class="link-btn danger" data-action="delete">Delete</button>
      </div></td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openItemModal(item));
    tr.querySelector('[data-action="modifiers"]').addEventListener('click', () => openModifierManageModal(item));
    tr.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete "${item.name}"?`))) return;
      await window.pos.menu.delete(item.id);
      menuItems = await window.pos.menu.list();
      renderMenuGrid();
      renderItemTable();
    });
    // Stock-tracked items have their availability driven entirely by
    // adjustStock() in main.js — no click handler here, since toggling it
    // manually would just get silently overwritten by the next order that
    // touches this item's stock (see menu:toggleAvailability's own guard).
    if (item.stock_quantity == null) {
      tr.querySelector('.status-pill').addEventListener('click', async () => {
        try {
          await window.pos.menu.toggleAvailability(item.id);
          menuItems = await window.pos.menu.list();
          renderMenuGrid();
          renderItemTable();
        } catch (err) {
          alert(`Could not update availability: ${err.message}`);
        }
      });
    }
    // Blank = stop tracking stock (item goes back to a plain manual
    // is_available toggle); a number makes availability self-managed from
    // here on (see adjustStock()/menu:updateStock in main.js).
    tr.querySelector('.stock-input').addEventListener('change', async (e) => {
      const raw = e.target.value.trim();
      try {
        await window.pos.menu.updateStock({ id: item.id, stockQuantity: raw === '' ? null : Number(raw) });
        menuItems = await window.pos.menu.list();
        renderMenuGrid();
        renderItemTable();
      } catch (err) {
        alert(`Could not update stock: ${err.message}`);
        e.target.value = item.stock_quantity ?? '';
      }
    });
    tbody.appendChild(tr);
  });
}

// ---------------- Item modifier management (Menu) ----------------
let modifierManageItem = null;

async function openModifierManageModal(item) {
  modifierManageItem = item;
  document.getElementById('item-modifier-manage-title').textContent = `Modifiers — ${item.name}`;
  await renderModifierManageGroups();
  document.getElementById('item-modifier-manage-modal').classList.remove('hidden');
}

async function renderModifierManageGroups() {
  const groups = await window.pos.modifiers.listGroups(modifierManageItem.id);
  const wrap = document.getElementById('item-modifier-manage-groups');
  if (!groups.length) {
    wrap.innerHTML = '<p class="category-manage-empty">No modifier groups yet — add one below.</p>';
  } else {
    wrap.innerHTML = '';
    groups.forEach((g) => {
      const card = document.createElement('div');
      card.className = 'modifier-manage-group';
      // A required group (min_select > 0) with fewer options than it needs
      // makes the item permanently un-orderable — flag it here so an owner
      // who just created the group (or deleted its last option, back when
      // that was still possible) notices before a cashier hits it live.
      const insufficientOptions = g.min_select > 0 && g.options.length < g.min_select;
      const warningHtml = insufficientOptions
        ? `<p class="modifier-manage-warning">Needs at least ${g.min_select} option(s) to be orderable — currently has ${g.options.length}.</p>`
        : '';
      card.innerHTML = `
        <div class="modifier-manage-group-head">
          <span class="modifier-manage-group-name">${escapeHtml(g.name)} <span class="modifier-manage-group-range">(select ${g.min_select}-${g.max_select})</span></span>
          <button class="link-btn danger" data-action="delete-group">Delete group</button>
        </div>
        ${warningHtml}
        <div class="modifier-manage-options"></div>
        <div class="modifier-manage-add-option">
          <input type="text" class="modifier-option-name-input" placeholder="Option name" />
          <input type="number" class="modifier-option-price-input" step="0.01" placeholder="+/- price" value="0" />
          <button class="link-btn" data-action="add-option">Add option</button>
        </div>
      `;
      const optionsWrap = card.querySelector('.modifier-manage-options');
      g.options.forEach((o) => {
        const row = document.createElement('div');
        row.className = 'modifier-manage-option-row';
        row.innerHTML = `
          <span>${escapeHtml(o.name)}</span>
          <span>${Number(o.price_delta) > 0 ? '+' : ''}₹${money(o.price_delta)}</span>
          <button class="link-btn danger" data-action="delete-option">Remove</button>
        `;
        row.querySelector('[data-action="delete-option"]').addEventListener('click', async () => {
          try {
            await window.pos.modifiers.deleteOption(o.id);
          } catch (err) {
            alert(`Could not remove option: ${err.message}`);
          }
          await renderModifierManageGroups();
        });
        optionsWrap.appendChild(row);
      });
      card.querySelector('[data-action="delete-group"]').addEventListener('click', async () => {
        if (!(await confirmDialog(`Delete modifier group "${g.name}" and all its options?`))) return;
        try {
          await window.pos.modifiers.deleteGroup(g.id);
        } catch (err) {
          alert(`Could not delete group: ${err.message}`);
        }
        await renderModifierManageGroups();
      });
      card.querySelector('[data-action="add-option"]').addEventListener('click', async () => {
        const nameInput = card.querySelector('.modifier-option-name-input');
        const priceInput = card.querySelector('.modifier-option-price-input');
        const name = nameInput.value.trim();
        if (!name) { alert('Enter an option name.'); return; }
        try {
          await window.pos.modifiers.addOption({ groupId: g.id, name, priceDelta: Number(priceInput.value) || 0 });
          await renderModifierManageGroups();
        } catch (err) {
          alert(`Could not add option: ${err.message}`);
        }
      });
      wrap.appendChild(card);
    });
  }
  // Refreshes modifier_group_count on the in-memory menu list too, so Take
  // Order immediately knows whether tapping this item should open the
  // picker — without this, adding an item's first group wouldn't take
  // effect there until some unrelated reload.
  menuItems = await window.pos.menu.list();
  renderMenuGrid();
}

document.getElementById('add-modifier-group-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-modifier-group-name');
  const minInput = document.getElementById('new-modifier-group-min');
  const maxInput = document.getElementById('new-modifier-group-max');
  const name = nameInput.value.trim();
  if (!name) { alert('Enter a group name.'); return; }
  try {
    await window.pos.modifiers.addGroup({
      menuItemId: modifierManageItem.id,
      name,
      minSelect: Number(minInput.value) || 0,
      maxSelect: Number(maxInput.value) || 1,
    });
    nameInput.value = '';
    minInput.value = '0';
    maxInput.value = '1';
    await renderModifierManageGroups();
  } catch (err) {
    alert(`Could not add group: ${err.message}`);
  }
});

document.getElementById('item-modifier-manage-close-btn').addEventListener('click', () => {
  document.getElementById('item-modifier-manage-modal').classList.add('hidden');
  modifierManageItem = null;
});

// ---------------- Settings ----------------
async function loadSettings() {
  const settings = await window.pos.settings.get();
  defaultTaxPercent = settings.defaultTaxPercent;
  document.getElementById('settings-tax-input').value = settings.defaultTaxPercent;
  document.getElementById('settings-business-name').value = settings.businessName;
  document.getElementById('settings-business-phone').value = settings.businessPhone;
  document.getElementById('settings-business-address').value = settings.businessAddress;
  document.getElementById('settings-gstin').value = settings.gstin;
  document.getElementById('settings-fssai').value = settings.fssaiNo;
  document.getElementById('settings-invoice-prefix').value = settings.invoicePrefix;
  document.getElementById('settings-upi-id').value = settings.upiId;
  document.getElementById('settings-footer-note').value = settings.footerNote;
  document.getElementById('settings-zomato-id').value = settings.zomatoRestaurantId;

  document.getElementById('settings-printer-mode').value = settings.printerMode;
  document.getElementById('settings-printer-paper-width').value = settings.printerPaperWidth;
  document.getElementById('settings-printer-network-host').value = settings.printerNetworkHost;
  document.getElementById('settings-printer-network-port').value = settings.printerNetworkPort;
  document.getElementById('settings-kot-printer-mode').value = settings.kotPrinterMode;
  document.getElementById('settings-kot-printer-paper-width').value = settings.kotPrinterPaperWidth;
  document.getElementById('settings-kot-printer-network-host').value = settings.kotPrinterNetworkHost;
  document.getElementById('settings-kot-printer-network-port').value = settings.kotPrinterNetworkPort;
  document.getElementById('settings-mobile-enabled').checked = settings.mobileServerEnabled;
  document.getElementById('settings-mobile-port').value = settings.mobileServerPort;
  await loadSystemPrinters(settings.printerSystemName, 'settings-printer-system-name');
  await loadSystemPrinters(settings.kotPrinterSystemName, 'settings-kot-printer-system-name');
  updatePrinterModeVisibility();
  updateKotPrinterModeVisibility();
  await loadMobileServerInfo();
  await renderStaffManageList();
}

// Paints the LAN URL + QR code for the mobile ordering server (see
// mobile:getServerInfo in main.js) — shown only once it's actually
// enabled and reachable (i.e. a LAN IP was found).
async function loadMobileServerInfo() {
  const info = await window.pos.mobile.getServerInfo();
  document.getElementById('settings-mobile-info').classList.toggle('hidden', !info.url);
  document.getElementById('settings-mobile-url').textContent = info.url || '';
  document.getElementById('settings-mobile-qr').src = info.qrDataUrl || '';
}

// Populates a system-printer <select> from printers:listSystem — shared by
// the receipt and KOT printer sections, since both list the same OS
// printers. Pass `selectedName` (the saved settings value) on initial
// load; omit it (e.g. from a Refresh button) to keep whatever is currently
// selected. `selectId` defaults to the receipt printer's select.
async function loadSystemPrinters(selectedName, selectId = 'settings-printer-system-name') {
  const select = document.getElementById(selectId);
  const wanted = selectedName !== undefined ? selectedName : select.value;
  select.innerHTML = '';
  try {
    const printers = await window.pos.printers.listSystem();
    if (!printers.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No printers found';
      select.appendChild(opt);
    } else {
      printers.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.displayName || p.name;
        if (p.isDefault) opt.textContent += ' (default)';
        select.appendChild(opt);
      });
    }
    if (wanted && ![...select.options].some((o) => o.value === wanted)) {
      // Saved printer isn't currently detected (unplugged, renamed, etc.) —
      // keep it selectable rather than silently swapping the saved setting.
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = `${wanted} (not currently detected)`;
      select.appendChild(opt);
    }
    if (wanted) select.value = wanted;
  } catch (err) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Could not list printers';
    select.appendChild(opt);
  }
}

function updatePrinterModeVisibility() {
  const mode = document.getElementById('settings-printer-mode').value;
  document.getElementById('settings-printer-system-block').classList.toggle('hidden', mode !== 'system');
  document.getElementById('settings-printer-network-block').classList.toggle('hidden', mode !== 'network');
  document.getElementById('settings-printer-test-btn').disabled = mode === 'dialog';
}

// KOT mode has a 4th option ("" = inherit the receipt printer's mode), so
// the system/network blocks only show for an explicit override, but the
// test button's disabled state has to resolve the inherited mode too —
// otherwise it'd stay enabled while inheriting 'dialog', where a test
// print can't actually do anything (see printKot()'s dialog fallback).
function updateKotPrinterModeVisibility() {
  const kotMode = document.getElementById('settings-kot-printer-mode').value;
  const effectiveMode = kotMode || document.getElementById('settings-printer-mode').value;
  document.getElementById('settings-kot-printer-system-block').classList.toggle('hidden', kotMode !== 'system');
  document.getElementById('settings-kot-printer-network-block').classList.toggle('hidden', kotMode !== 'network');
  document.getElementById('settings-kot-printer-test-btn').disabled = effectiveMode === 'dialog';
}

document.getElementById('settings-printer-mode').addEventListener('change', () => {
  updatePrinterModeVisibility();
  updateKotPrinterModeVisibility(); // the KOT printer may be inheriting this mode
});
document.getElementById('settings-kot-printer-mode').addEventListener('change', updateKotPrinterModeVisibility);

document.getElementById('settings-printer-refresh-btn').addEventListener('click', () => {
  loadSystemPrinters(undefined, 'settings-printer-system-name');
});
document.getElementById('settings-kot-printer-refresh-btn').addEventListener('click', () => {
  loadSystemPrinters(undefined, 'settings-kot-printer-system-name');
});

document.getElementById('settings-kot-printer-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('settings-kot-printer-test-btn');
  btn.disabled = true;
  try {
    await window.pos.receipt.testPrintKot();
    alert('Test KOT sent.');
  } catch (err) {
    alert(`Test KOT failed: ${err.message}`);
  } finally {
    updateKotPrinterModeVisibility();
  }
});

document.getElementById('settings-printer-test-btn').addEventListener('click', async () => {
  const btn = document.getElementById('settings-printer-test-btn');
  btn.disabled = true;
  try {
    await window.pos.receipt.testPrint();
    alert('Test print sent.');
  } catch (err) {
    alert(`Test print failed: ${err.message}`);
  } finally {
    btn.disabled = document.getElementById('settings-printer-mode').value === 'dialog';
  }
});

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('settings-save-btn');
  const defaultTaxInput = document.getElementById('settings-tax-input').value.trim();
  // Number('') is 0, not NaN — without this explicit blank check, clearing
  // the field entirely would silently save a 0% default instead of
  // rejecting the save like every other invalid entry does.
  if (defaultTaxInput === '') {
    alert('Default GST % is required.');
    return;
  }
  const defaultTaxValue = Number(defaultTaxInput);
  if (isNaN(defaultTaxValue) || defaultTaxValue < 0) {
    alert('Enter a valid GST percentage.');
    return;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    await window.pos.settings.update({
      defaultTaxPercent: defaultTaxValue,
      businessName: document.getElementById('settings-business-name').value.trim(),
      businessPhone: document.getElementById('settings-business-phone').value.trim(),
      businessAddress: document.getElementById('settings-business-address').value.trim(),
      gstin: document.getElementById('settings-gstin').value.trim(),
      fssaiNo: document.getElementById('settings-fssai').value.trim(),
      invoicePrefix: document.getElementById('settings-invoice-prefix').value.trim() || 'INV',
      upiId: document.getElementById('settings-upi-id').value.trim(),
      footerNote: document.getElementById('settings-footer-note').value.trim(),
      zomatoRestaurantId: document.getElementById('settings-zomato-id').value.trim(),
      printerMode: document.getElementById('settings-printer-mode').value,
      printerPaperWidth: document.getElementById('settings-printer-paper-width').value,
      printerSystemName: document.getElementById('settings-printer-system-name').value.trim(),
      printerNetworkHost: document.getElementById('settings-printer-network-host').value.trim(),
      printerNetworkPort: Number(document.getElementById('settings-printer-network-port').value) || 9100,
      kotPrinterMode: document.getElementById('settings-kot-printer-mode').value,
      kotPrinterPaperWidth: document.getElementById('settings-kot-printer-paper-width').value,
      kotPrinterSystemName: document.getElementById('settings-kot-printer-system-name').value.trim(),
      kotPrinterNetworkHost: document.getElementById('settings-kot-printer-network-host').value.trim(),
      kotPrinterNetworkPort: Number(document.getElementById('settings-kot-printer-network-port').value) || 9100,
      // '1'/'0', not a raw boolean — settings:update stores every field via
      // String(value), and getMobileServerSettings() in main.js checks for
      // the literal string '1', not JS's String(true) === 'true'.
      mobileServerEnabled: document.getElementById('settings-mobile-enabled').checked ? '1' : '0',
      mobileServerPort: Number(document.getElementById('settings-mobile-port').value) || 8080,
    });
    defaultTaxPercent = defaultTaxValue;
    await loadMobileServerInfo();
    btn.textContent = 'Saved';
    setTimeout(() => { btn.textContent = originalText; }, 1200);
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- Staff management (Settings, owner only) ----------------
async function renderStaffManageList() {
  const list = document.getElementById('staff-manage-list');
  let staffRows;
  try {
    staffRows = await window.pos.staff.list();
  } catch (err) {
    // Not an owner (or somehow not logged in) — the Settings tab is already
    // hidden for everyone else, so reaching this is only a defensive path.
    list.innerHTML = `<p class="category-manage-empty">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!staffRows.length) {
    list.innerHTML = '<p class="category-manage-empty">No staff yet — add one below.</p>';
    return;
  }
  list.innerHTML = '';
  staffRows.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'category-manage-row staff-manage-row';
    row.innerHTML = `
      <span class="category-manage-name">${escapeHtml(s.name)}</span>
      ${!s.isActive ? '<span class="staff-inactive-tag">Inactive</span>' : ''}
      <select class="staff-role-select" data-action="role"></select>
      <button class="link-btn" data-action="reset-pin">Reset PIN</button>
      <button class="link-btn" data-action="toggle-active">${s.isActive ? 'Deactivate' : 'Reactivate'}</button>
      <button class="link-btn danger" data-action="delete">Delete</button>
    `;

    const roleSelect = row.querySelector('[data-action="role"]');
    ['owner', 'manager', 'staff'].forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = capitalize(r);
      if (r === s.role) opt.selected = true;
      roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener('change', async () => {
      try {
        await window.pos.staff.update({ id: s.id, role: roleSelect.value });
        await syncSessionAfterStaffChange();
      } catch (err) {
        alert(`Could not change role: ${err.message}`);
      }
      await renderStaffManageList();
    });

    row.querySelector('[data-action="reset-pin"]').addEventListener('click', () => {
      openStaffPinModal(s);
    });

    row.querySelector('[data-action="toggle-active"]').addEventListener('click', async () => {
      try {
        await window.pos.staff.update({ id: s.id, isActive: !s.isActive });
        await syncSessionAfterStaffChange();
      } catch (err) {
        alert(`Could not update status: ${err.message}`);
      }
      await renderStaffManageList();
    });

    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete staff account "${s.name}"? This can't be undone — past orders keep their attribution either way.`))) return;
      try {
        await window.pos.staff.delete(s.id);
        await syncSessionAfterStaffChange();
      } catch (err) {
        alert(`Could not delete: ${err.message}`);
      }
      await renderStaffManageList();
    });

    list.appendChild(row);
  });
}

let pinResetStaff = null;

function openStaffPinModal(staff) {
  pinResetStaff = staff;
  document.getElementById('staff-pin-modal-title').textContent = `Reset PIN — ${staff.name}`;
  document.getElementById('staff-pin-new').value = '';
  document.getElementById('staff-pin-confirm').value = '';
  document.getElementById('staff-pin-error').classList.add('hidden');
  document.getElementById('staff-pin-modal').classList.remove('hidden');
  document.getElementById('staff-pin-new').focus();
}

document.getElementById('staff-pin-cancel-btn').addEventListener('click', () => {
  document.getElementById('staff-pin-modal').classList.add('hidden');
  pinResetStaff = null;
});

document.getElementById('staff-pin-save-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('staff-pin-error');
  errEl.classList.add('hidden');
  const newPin = document.getElementById('staff-pin-new').value;
  const confirmPin = document.getElementById('staff-pin-confirm').value;
  if (!/^\d{4,6}$/.test(newPin)) { showAuthError(errEl, 'PIN must be 4-6 digits.'); return; }
  if (newPin !== confirmPin) { showAuthError(errEl, 'PINs do not match.'); return; }
  try {
    await window.pos.staff.update({ id: pinResetStaff.id, pin: newPin });
    document.getElementById('staff-pin-modal').classList.add('hidden');
    pinResetStaff = null;
  } catch (err) {
    showAuthError(errEl, err.message);
  }
});

document.getElementById('add-staff-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-staff-name');
  const pinInput = document.getElementById('new-staff-pin');
  const roleSelect = document.getElementById('new-staff-role');
  const name = nameInput.value.trim();
  const pin = pinInput.value;
  if (!name) { alert('Enter a name.'); return; }
  try {
    await window.pos.staff.add({ name, pin, role: roleSelect.value });
    nameInput.value = '';
    pinInput.value = '';
    roleSelect.value = 'staff';
    await renderStaffManageList();
  } catch (err) {
    alert(`Could not add staff: ${err.message}`);
  }
});

// ---------------- Utils ----------------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------------- Init ----------------
loadReferenceData();
renderTicket();
initAuth();
