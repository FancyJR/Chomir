const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('aifrontDesktop', {
  isDesktop: true,
  platform: process.platform
})
