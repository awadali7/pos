// ---------------- State ----------------
let categories = [];
let subcategories = [];
let menuItems = [];
let activeCategory = 'all';
let activeSubcategory = 'all';
let currentOrder = null; // { id, items: [...], subtotal, tax_amount, discount, total, ... }
let selectedPaymentMode = null;
let allOrders = [];
let ordersStatusFilter = 'all';
let viewingHistoricalReceipt = false;
let reportsRangeKey = 'today';
let defaultTaxPercent = 5;

const money = (n) => Number(n || 0).toFixed(2);

// ---------------- View switching ----------------
const VIEWS = ['order', 'orders', 'reports', 'menu', 'settings'];

function switchToView(view) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  VIEWS.forEach((v) => document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view));
  if (view === 'menu') renderItemTable();
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
  const settings = await window.pos.settings.get();
  defaultTaxPercent = settings.defaultTaxPercent;
  renderCategoryTabs();
  renderSubcategoryTabs();
  renderMenuGrid();
  populateCategorySelect();
  populateSubcategoryParentSelect();
  populateBulkGstScopeSelect();
  renderCategoryManageList();
  renderTicket();
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
      if (!confirm(`Delete category "${c.name}"? Its subcategories will be removed too.`)) return;
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
        if (!confirm(`Delete subcategory "${sub.name}"?`)) return;
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
  const rate = Number(document.getElementById('bulk-gst-rate').value);
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
  if (!confirm(`Set GST % to ${rate}% for ${affected} item(s) in ${scopeLabel}?`)) return;

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
document.getElementById('new-order-btn').addEventListener('click', () => startNewOrder(false));

async function startNewOrder(force) {
  if (!force && currentOrder) {
    if (!currentOrder.items || currentOrder.items.length === 0) {
      // Already sitting on a fresh, unused order — repeated clicks shouldn't spawn more.
      return;
    }
    const label = currentOrder.table_label ? ` (${currentOrder.table_label})` : '';
    const proceed = confirm(
      `Order #${currentOrder.id}${label} is still open with items in it. Start a separate new order?\n\nThe current one stays open — resume it later from the Orders tab.`
    );
    if (!proceed) return;
  }
  const orderType = document.getElementById('order-type').value;
  const tableLabel = document.getElementById('table-label').value.trim();
  const source = document.getElementById('order-source').value;
  currentOrder = await window.pos.orders.create({ orderType, tableLabel, source });
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
  if (!confirm(warning)) return;
  await window.pos.orders.cancel(currentOrder.id);
  currentOrder = null;
  document.getElementById('table-label').value = '';
  renderTicket();
});

async function addItemToOrder(menuItem) {
  await ensureOrder();
  const updatedOrder = await window.pos.orders.addItem({
    orderId: currentOrder.id,
    menuItemId: menuItem.id,
    name: menuItem.name,
    price: menuItem.price,
    quantity: 1,
  });
  await refreshCurrentOrder(updatedOrder);
}

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

  if (!currentOrder) {
    idEl.textContent = '—';
    itemsEl.innerHTML = '<p class="ticket-empty">No items yet. Tap a dish to add it.</p>';
    cancelOrderBtn.classList.add('hidden');
    setTotals(0, 0, 0, 0);
    checkoutBtn.disabled = true;
    return;
  }

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
      row.innerHTML = `
        <span class="ticket-line-name">${escapeHtml(line.item_name)}</span>
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
  const updated = await window.pos.orders.updateItemQty({
    orderItemId: line.id, quantity: newQty, orderId: currentOrder.id,
  });
  await refreshCurrentOrder(updated);
}

document.getElementById('discount-input').addEventListener('change', async (e) => {
  await ensureOrder();
  const updated = await window.pos.orders.setDiscount({ orderId: currentOrder.id, discount: Number(e.target.value) });
  await refreshCurrentOrder(updated);
});

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
  const orders = allOrders.filter((o) => ordersStatusFilter === 'all' || o.status === ordersStatusFilter);

  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="category-manage-empty">No orders yet.</td></tr>';
    return;
  }

  orders.forEach((o) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${o.id}</td>
      <td>${escapeHtml(o.order_type)}</td>
      <td>${escapeHtml(o.table_label || '—')}</td>
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
        if (!confirm(`Cancel order #${o.id}? This can't be undone.`)) return;
        await window.pos.orders.cancel(o.id);
        if (currentOrder && currentOrder.id === o.id) {
          currentOrder = null;
          renderTicket();
        }
        await loadOrdersList();
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
}

async function viewReceipt(orderId) {
  viewingHistoricalReceipt = true;
  const receipt = await window.pos.billing.getReceipt(orderId);
  renderReceipt(receipt);
  document.getElementById('receipt-close-btn').textContent = 'Close';
  receiptModal.classList.remove('hidden');
}

// ---------------- Billing ----------------
const paymentModal = document.getElementById('payment-modal');
const receiptModal = document.getElementById('receipt-modal');

document.getElementById('checkout-btn').addEventListener('click', () => {
  selectedPaymentMode = null;
  document.querySelectorAll('.payment-mode-btn').forEach((b) => b.classList.remove('selected'));
  paymentModal.classList.remove('hidden');
});

document.getElementById('payment-cancel-btn').addEventListener('click', () => {
  paymentModal.classList.add('hidden');
});

document.querySelectorAll('.payment-mode-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.payment-mode-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedPaymentMode = btn.dataset.mode;
    await finalizeOrder();
  });
});

async function finalizeOrder() {
  viewingHistoricalReceipt = false;
  await window.pos.billing.finalize({ orderId: currentOrder.id, paymentMode: selectedPaymentMode });
  const receipt = await window.pos.billing.getReceipt(currentOrder.id);
  renderReceipt(receipt);
  document.getElementById('receipt-close-btn').textContent = 'New order';
  paymentModal.classList.add('hidden');
  receiptModal.classList.remove('hidden');
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
    </div>
  `;

  const itemsRows = order.items.map((i) => `
    <tr>
      <td>${escapeHtml(i.item_name)}</td>
      <td>${i.quantity}</td>
      <td>${money(i.unit_price)}</td>
      <td>${money(i.unit_price * i.quantity)}</td>
    </tr>
  `).join('');
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

  const paymentHtml = order.payment_mode ? `<div style="margin-top:8px;">Paid via ${escapeHtml(order.payment_mode)}</div>` : '';

  const qrHtml = order.qrDataUrl ? `
    <div class="receipt-qr">
      <img src="${order.qrDataUrl}" alt="Scan and pay QR code" />
      <div>Scan and Pay</div>
    </div>
  ` : '';

  const footerHtml = business.footerNote ? `<div class="receipt-footer">${escapeHtml(business.footerNote)}</div>` : '';

  body.innerHTML = headerHtml + metaHtml + itemsHtml + totalsHtml + gstHtml + paymentHtml + qrHtml + footerHtml;
}

document.getElementById('receipt-print-btn').addEventListener('click', () => {
  window.print();
});

document.getElementById('receipt-close-btn').addEventListener('click', () => {
  receiptModal.classList.add('hidden');
  if (!viewingHistoricalReceipt) {
    currentOrder = null;
    document.getElementById('table-label').value = '';
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
  const payload = {
    id: editingItemId,
    name: document.getElementById('item-name').value.trim(),
    price: Number(document.getElementById('item-price').value),
    categoryId: Number(document.getElementById('item-category').value),
    subcategoryId: subcategoryValue ? Number(subcategoryValue) : null,
    hsnCode: document.getElementById('item-hsn-code').value.trim(),
    gstRate: Number(document.getElementById('item-gst-rate').value),
    isAvailable: document.getElementById('item-available').checked,
  };
  if (!payload.name || isNaN(payload.price) || isNaN(payload.gstRate)) return;

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
      <td><span class="status-pill ${item.is_available ? 'available' : 'unavailable'}">${item.is_available ? 'Available' : 'Unavailable'}</span></td>
      <td><div class="row-actions">
        <button class="link-btn" data-action="edit">Edit</button>
        <button class="link-btn danger" data-action="delete">Delete</button>
      </div></td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openItemModal(item));
    tr.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${item.name}"?`)) return;
      await window.pos.menu.delete(item.id);
      menuItems = await window.pos.menu.list();
      renderMenuGrid();
      renderItemTable();
    });
    tr.querySelector('.status-pill').addEventListener('click', async () => {
      await window.pos.menu.toggleAvailability(item.id);
      menuItems = await window.pos.menu.list();
      renderMenuGrid();
      renderItemTable();
    });
    tbody.appendChild(tr);
  });
}

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
}

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('settings-save-btn');
  const defaultTaxValue = Number(document.getElementById('settings-tax-input').value);
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
    });
    defaultTaxPercent = defaultTaxValue;
    btn.textContent = 'Saved';
    setTimeout(() => { btn.textContent = originalText; }, 1200);
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
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
