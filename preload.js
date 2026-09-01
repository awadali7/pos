const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
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
  menu: {
    list: () => ipcRenderer.invoke('menu:list'),
    add: (item) => ipcRenderer.invoke('menu:add', item),
    update: (item) => ipcRenderer.invoke('menu:update', item),
    delete: (id) => ipcRenderer.invoke('menu:delete', id),
    toggleAvailability: (id) => ipcRenderer.invoke('menu:toggleAvailability', id),
    bulkSetGstRate: (payload) => ipcRenderer.invoke('menu:bulkSetGstRate', payload),
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
  reports: {
    summary: (payload) => ipcRenderer.invoke('reports:summary', payload),
    exportExcel: (payload) => ipcRenderer.invoke('reports:exportExcel', payload),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (payload) => ipcRenderer.invoke('settings:update', payload),
  },
});
