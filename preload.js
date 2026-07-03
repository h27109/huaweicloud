const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 配置管理
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // 目录选择
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // 授权（原始复制粘贴方式）
  getAuthUrl: () => ipcRenderer.invoke('get-auth-url'),
  submitAuthUrl: (url) => ipcRenderer.invoke('submit-auth-url', url),
  getAuthStatus: () => ipcRenderer.invoke('auth-status'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 云盘浏览
  listCloudFiles: (parentFolderId) => ipcRenderer.invoke('list-cloud-files', parentFolderId || null),
  cleanFolderDb: (folderId) => ipcRenderer.invoke('clean-folder-db', folderId),

  // 同步
  startSync: () => ipcRenderer.invoke('start-sync'),
  cancelSync: () => ipcRenderer.invoke('cancel-sync'),

  // 状态监听
  onSyncStatus: (callback) => {
    ipcRenderer.on('sync-status', (event, data) => callback(data.type, data.data));
  },

  // 移除监听
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('sync-status');
  }
});
