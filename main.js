const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { loadConfig, saveConfig, getDbPath } = require('./src/config');
const { getAuthUrl, exchangeRedirectUrl, getValidToken, saveToken, isAuthorized } = require('./src/auth');
const { getAbout, listFiles } = require('./src/api');
const SyncDatabase = require('./src/db');
const SyncEngine = require('./src/sync');

let mainWindow = null;
let syncEngine = null;
let db = null;

function getDb() {
  if (!db) {
    db = new SyncDatabase(getDbPath());
  }
  return db;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    title: '华为云盘同步工具',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ==================== IPC Handlers ====================

// 获取配置
ipcMain.handle('get-config', () => {
  return loadConfig();
});

// 保存配置
ipcMain.handle('save-config', (event, config) => {
  try {
    saveConfig(config);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 选择目录
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择本地同步目录'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// 获取登录状态
ipcMain.handle('auth-status', async () => {
  try {
    if (!isAuthorized()) {
      return { authorized: false };
    }
    const config = loadConfig();
    const tokenResult = await getValidToken(config);
    if (!tokenResult) {
      return { authorized: false };
    }
    const about = await getAbout(tokenResult.token);
    return {
      authorized: true,
      userName: about.user?.displayName || '未知',
      usedSpace: about.storageQuota?.usedSpace || 0,
      totalCapacity: about.storageQuota?.userCapacity || 0
    };
  } catch (err) {
    return { authorized: false };
  }
});

// 获取授权 URL
ipcMain.handle('get-auth-url', () => {
  try {
    const config = loadConfig();
    if (!config.clientId) {
      return { success: false, error: '请先配置 Client ID' };
    }
    const authUrl = getAuthUrl(config);
    return { success: true, authUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 提交回调 URL（用户粘贴的授权后跳转链接）
ipcMain.handle('submit-auth-url', async (event, redirectUrl) => {
  try {
    const config = loadConfig();
    if (!config.clientId || !config.clientSecret) {
      return { success: false, error: '请先配置 Client ID 和 Client Secret' };
    }
    if (!redirectUrl || typeof redirectUrl !== 'string') {
      return { success: false, error: '请输入回调 URL' };
    }
    await exchangeRedirectUrl(redirectUrl.trim(), config);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 开始同步
ipcMain.handle('start-sync', async (event) => {
  try {
    const config = loadConfig();

    if (!config.localRoot) {
      return { success: false, error: '请先配置本地同步目录' };
    }
    if (!config.syncFolders || config.syncFolders.length === 0) {
      return { success: false, error: '请先添加至少一个同步文件夹' };
    }

    // 初始化数据库
    const dbPath = getDbPath();
    db = new SyncDatabase(dbPath);

    // 创建同步引擎
    syncEngine = new SyncEngine(db, (type, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-status', { type, data });
      }
    }, config);

    // 异步执行同步
    syncEngine.runFullSync().catch((err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-status', {
          type: 'error',
          data: { message: err.message }
        });
      }
      syncEngine = null;
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 浏览云盘文件列表
ipcMain.handle('list-cloud-files', async (event, parentFolderId) => {
  try {
    const config = loadConfig();
    const tokenResult = await getValidToken(config);
    if (!tokenResult) {
      return { success: false, error: '未登录，请先授权登录' };
    }

    let queryParam;
    if (parentFolderId) {
      queryParam = `'${parentFolderId}' in parentFolder`;
    } else {
      queryParam = "'root' in parentFolder";
    }

    const result = await listFiles(tokenResult.token, queryParam);
    const files = (result.files || []).map(f => ({
      id: f.id,
      name: f.fileName,
      mimeType: f.mimeType,
      size: f.size,
      editedTime: f.editedTime,
      isFolder: f.mimeType === 'application/vnd.huawei-apps.folder'
    }));

    // 文件夹在前，文件在后
    files.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    return { success: true, files, nextCursor: result.nextCursor || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 移除同步文件夹时清理数据库
ipcMain.handle('clean-folder-db', (event, folderId) => {
  try {
    if (folderId) {
      getDb().deleteFolderTree(folderId);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 打开外部链接
ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

// 取消同步
ipcMain.handle('cancel-sync', () => {
  if (syncEngine) {
    syncEngine.cancel();
    return { success: true };
  }
  return { success: false, error: '没有正在进行的同步任务' };
});

// ==================== App 生命周期 ====================

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (db) db.close();
  app.quit();
});

app.on('before-quit', () => {
  if (db) db.close();
});
