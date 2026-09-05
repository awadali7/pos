const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  staff: {
    needsSetup: () => ipcRenderer.invoke('staff:needsSetup'),
    createFirstOwner: (payload) => ipcRenderer.invoke('staff:createFirstOwner', payload),
    login: (payload) => ipcRenderer.invoke('staff:login', payload),
    logout: () => ipcRenderer.invoke('staff:logout'),
    whoAmI: () => ipcRenderer.invoke('staff:whoAmI'),
    list: () => ipcRenderer.invoke('staff:list'),
    add: (payload) => ipcRenderer.invoke('staff:add', payload),
    update: (payload) => ipcRenderer.invoke('staff:update', payload),
    delete: (id) => ipcRenderer.invoke('staff:delete', id),
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    add: (name) => ipcRenderer.invoke('categories:add', name),
    delete: (id) => ipcRenderer.invoke('categories:delete', id),
  },
  subcategories: {
    list: () => ipcRenderer.invoke('subcategories:list'),
    add: (payload) => ipcRenderer.invoke('subcategories:add', payload),
    delete: (id) => ipcRenderer.invoke('subcategories:delete', id),
  },
  tables: {
    list: () => ipcRenderer.invoke('tables:list'),
    add: (payload) => ipcRenderer.invoke('tables:add', payload),
    delete: (id) => ipcRenderer.invoke('tables:delete', id),
  },
  menu: {
    list: () => ipcRenderer.invoke('menu:list'),
    add: (item) => ipcRenderer.invoke('menu:add', item),
    update: (item) => ipcRenderer.invoke('menu:update', item),
    delete: (id) => ipcRenderer.invoke('menu:delete', id),
    toggleAvailability: (id) => ipcRenderer.invoke('menu:toggleAvailability', id),
    bulkSetGstRate: (payload) => ipcRenderer.invoke('menu:bulkSetGstRate', payload),
  },
  modifiers: {
    listGroups: (menuItemId) => ipcRenderer.invoke('modifiers:listGroups', menuItemId),
    addGroup: (payload) => ipcRenderer.invoke('modifiers:addGroup', payload),
    deleteGroup: (groupId) => ipcRenderer.invoke('modifiers:deleteGroup', groupId),
    addOption: (payload) => ipcRenderer.invoke('modifiers:addOption', payload),
    deleteOption: (optionId) => ipcRenderer.invoke('modifiers:deleteOption', optionId),
  },
  orders: {
    listOpen: () => ipcRenderer.invoke('orders:listOpen'),
    listAll: () => ipcRenderer.invoke('orders:listAll'),
    create: (payload) => ipcRenderer.invoke('orders:create', payload),
    get: (orderId) => ipcRenderer.invoke('orders:get', orderId),
    addItem: (payload) => ipcRenderer.invoke('orders:addItem', payload),
    updateItemQty: (payload) => ipcRenderer.invoke('orders:updateItemQty', payload),
    removeItem: (payload) => ipcRenderer.invoke('orders:removeItem', payload),
    setDiscount: (payload) => ipcRenderer.invoke('orders:setDiscount', payload),
    cancel: (orderId) => ipcRenderer.invoke('orders:cancel', orderId),
  },
  billing: {
    finalize: (payload) => ipcRenderer.invoke('billing:finalize', payload),
    getReceipt: (orderId) => ipcRenderer.invoke('billing:getReceipt', orderId),
  },
  customers: {
    lookup: (phone) => ipcRenderer.invoke('customers:lookup', phone),
  },
  shifts: {
    current: () => ipcRenderer.invoke('shifts:current'),
    open: (payload) => ipcRenderer.invoke('shifts:open', payload),
    preview: () => ipcRenderer.invoke('shifts:preview'),
    close: (payload) => ipcRenderer.invoke('shifts:close', payload),
    history: () => ipcRenderer.invoke('shifts:history'),
  },
  printers: {
    listSystem: () => ipcRenderer.invoke('printers:listSystem'),
  },
  receipt: {
    print: (payload) => ipcRenderer.invoke('receipt:print', payload),
    testPrint: () => ipcRenderer.invoke('receipt:testPrint'),
    printKot: (payload) => ipcRenderer.invoke('receipt:printKot', payload),
    testPrintKot: () => ipcRenderer.invoke('receipt:testPrintKot'),
    confirmKotPrinted: (payload) => ipcRenderer.invoke('receipt:confirmKotPrinted', payload),
  },
  reports: {
    summary: (payload) => ipcRenderer.invoke('reports:summary', payload),
    exportExcel: (payload) => ipcRenderer.invoke('reports:exportExcel', payload),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (payload) => ipcRenderer.invoke('settings:update', payload),
  },
  mobile: {
    getServerInfo: () => ipcRenderer.invoke('mobile:getServerInfo'),
  },
});
