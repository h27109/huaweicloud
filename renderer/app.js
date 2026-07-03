/**
 * 渲染进程 UI 逻辑
 */
const API = window.electronAPI;

// ========== DOM 元素 ==========
const elLocalRoot = document.getElementById('localRoot');
const elBtnBrowse = document.getElementById('btnBrowse');
const elAuthStatus = document.getElementById('authStatus');
const elAccountInfo = document.getElementById('accountInfo');
const elUserName = document.getElementById('userName');
const elStorageInfo = document.getElementById('storageInfo');
const elBtnGetAuthUrl = document.getElementById('btnGetAuthUrl');
const elAuthUrlArea = document.getElementById('authUrlArea');
const elAuthUrlText = document.getElementById('authUrlText');
const elBtnCopyUrl = document.getElementById('btnCopyUrl');
const elBtnOpenUrl = document.getElementById('btnOpenUrl');
const elRedirectUrl = document.getElementById('redirectUrl');
const elBtnSubmitUrl = document.getElementById('btnSubmitUrl');

// 云盘浏览
const elBtnBrowseCloud = document.getElementById('btnBrowseCloud');
const elBtnRefreshCloud = document.getElementById('btnRefreshCloud');
const elCloudFolderList = document.getElementById('cloudFolderList');
const elCloudBreadcrumb = document.getElementById('cloudBreadcrumb');
const elCloudItems = document.getElementById('cloudItems');
const elCloudFolderHint = document.getElementById('cloudFolderHint');
const elSelectedHint = document.getElementById('selectedHint');
const elFolderTags = document.getElementById('folderTags');

// 同步
const elBtnSync = document.getElementById('btnSync');
const elBtnCancelSync = document.getElementById('btnCancelSync');
const elProgressArea = document.getElementById('progressArea');
const elProgressFill = document.getElementById('progressFill');
const elProgressText = document.getElementById('progressText');
const elLogArea = document.getElementById('logArea');
const elBtnClearLog = document.getElementById('btnClearLog');
const elSyncStatus = document.getElementById('syncStatus');

// ========== 状态 ==========
let config = null;
let syncFolders = [];        // [{name, cloudId}]
let isSyncing = false;
let cloudNavStack = [];      // [{id, name}] 导航栈，栈顶是当前目录
let cloudChecked = new Set(); // 已勾选的文件夹 id
let isLoggedIn = false;

// ========== 初始化 ==========
async function init() {
  config = await API.getConfig();
  syncFolders = (config.syncFolders || []).map(f => typeof f === 'string' ? { name: f, cloudId: '' } : f);
  elLocalRoot.value = config.localRoot || '';
  renderSelectedFolders();

  await checkAuth();

  API.onSyncStatus((type, data) => {
    handleSyncStatus(type, data);
  });

  log('应用就绪，请配置并登录。');
}

// ========== 事件绑定 ==========

// 选择本地目录
elBtnBrowse.addEventListener('click', async () => {
  const dir = await API.selectDirectory();
  if (dir) {
    elLocalRoot.value = dir;
    config.localRoot = dir;
    await API.saveConfig(config);
    log('本地同步目录已设置: ' + dir);
  }
});

// ===== 授权流程 =====

elBtnGetAuthUrl.addEventListener('click', async () => {
  log('正在获取授权链接...');
  const result = await API.getAuthUrl();
  if (result.success) {
    elAuthUrlText.value = result.authUrl;
    elAuthUrlArea.classList.remove('hidden');
    log('已获取授权链接，请复制并在浏览器中打开');
  } else {
    log('获取授权链接失败: ' + result.error, 'error');
  }
});

elBtnCopyUrl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elAuthUrlText.value);
    log('授权链接已复制到剪贴板');
  } catch (e) {
    elAuthUrlText.select();
    log('请手动复制上方链接 (Cmd+C)', 'warn');
  }
});

elBtnOpenUrl.addEventListener('click', () => {
  if (elAuthUrlText.value) {
    API.openExternal(elAuthUrlText.value);
    log('已在浏览器中打开授权链接');
  }
});

elBtnSubmitUrl.addEventListener('click', async () => {
  const redirectUrl = elRedirectUrl.value.trim();
  if (!redirectUrl) {
    log('请先粘贴浏览器地址栏中的完整 URL', 'warn');
    return;
  }
  elBtnSubmitUrl.disabled = true;
  elBtnSubmitUrl.textContent = '正在验证...';
  log('正在提取授权码并交换 token...');

  try {
    const result = await API.submitAuthUrl(redirectUrl);
    if (result.success) {
      log('✅ 授权成功！token 已保存到本地');
      elRedirectUrl.value = '';
      await checkAuth();
    } else {
      log('授权失败: ' + result.error, 'error');
    }
  } catch (err) {
    log('授权异常: ' + err.message, 'error');
  }
  elBtnSubmitUrl.disabled = false;
  elBtnSubmitUrl.textContent = '提交';
});

elRedirectUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') elBtnSubmitUrl.click();
});

// ===== 云盘浏览 =====

elBtnBrowseCloud.addEventListener('click', () => navigateTo(null));

elBtnRefreshCloud.addEventListener('click', async () => {
  const current = cloudNavStack.length > 0 ? cloudNavStack[cloudNavStack.length - 1] : null;
  await navigateTo(current ? current.id : null);
});

// ===== 同步操作 =====

elBtnSync.addEventListener('click', async () => {
  if (isSyncing) return;
  if (!config.localRoot) {
    log('请先配置本地同步目录', 'warn');
    return;
  }
  if (syncFolders.length === 0) {
    log('请先在云盘中选择要同步的文件夹', 'warn');
    return;
  }

  // 保存配置（兼容旧格式也存一份纯名字数组）
  config.syncFolders = syncFolders.map(f => f.name);
  config._syncFoldersDetail = syncFolders;
  await API.saveConfig(config);

  isSyncing = true;
  elBtnSync.classList.add('hidden');
  elBtnCancelSync.classList.remove('hidden');
  elProgressArea.classList.remove('hidden');
  elSyncStatus.textContent = '同步中...';
  elSyncStatus.className = 'sync-badge syncing';
  elLogArea.innerHTML = '';

  const result = await API.startSync();
  if (!result.success) {
    log('启动同步失败: ' + result.error, 'error');
    resetSyncUI();
  }
});

elBtnCancelSync.addEventListener('click', async () => {
  await API.cancelSync();
  log('正在取消同步...', 'warn');
});

elBtnClearLog.addEventListener('click', () => {
  elLogArea.innerHTML = '';
});

// ========== 云盘导航 ==========

async function navigateTo(folderId) {
  elBtnBrowseCloud.disabled = true;
  elBtnBrowseCloud.textContent = '加载中...';

  const result = await API.listCloudFiles(folderId);

  if (!result.success) {
    log('获取云盘文件列表失败: ' + result.error, 'error');
    elBtnBrowseCloud.disabled = false;
    elBtnBrowseCloud.textContent = '📂 浏览云盘';
    return;
  }

  elBtnBrowseCloud.textContent = '📂 浏览云盘';
  elBtnBrowseCloud.disabled = false;
  elCloudFolderList.classList.remove('hidden');
  elBtnRefreshCloud.classList.remove('hidden');
  elCloudFolderHint.classList.add('hidden');

  // 如果是导航到子目录，压栈；如果是根目录，清栈
  if (folderId) {
    // 找到对应文件夹名
    const currentFiles = result.files;
    // 从父目录结果中找到当前文件夹名（不太方便，用另一种方式）
  }

  renderCloudItems(result.files, folderId);
}

function renderCloudItems(files, parentId) {
  elCloudItems.innerHTML = '';

  // 更新面包屑
  updateBreadcrumb(parentId);

  if (!files || files.length === 0) {
    elCloudItems.innerHTML = '<div style="padding:20px;text-align:center;color:#999;">此目录为空</div>';
    return;
  }

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'cloud-item' + (file.isFolder && cloudChecked.has(file.id) ? ' selected' : '') + (!file.isFolder ? ' is-file' : '');
    item.dataset.id = file.id;
    item.dataset.name = file.name;
    item.dataset.isFolder = file.isFolder ? '1' : '0';

    if (file.isFolder) {
      item.innerHTML = `
        <span class="checkbox">✓</span>
        <span class="item-icon">📁</span>
        <span class="item-name">${escapeHtml(file.name)}</span>
        <span class="item-size">${file.editedTime ? formatDate(file.editedTime) : ''}</span>
        <span class="item-arrow">›</span>
      `;

      // 点击文件夹 → 选中/取消
      item.addEventListener('click', (e) => {
        // 如果点击的是箭头区域 → 进入子目录
        const arrow = e.target.closest('.item-arrow');
        if (arrow) {
          e.stopPropagation();
          enterFolder(file.id, file.name);
          return;
        }
        toggleFolder(file.id, file.name);
      });
    } else {
      const sizeStr = file.size ? formatSize(file.size) : '';
      item.innerHTML = `
        <span class="checkbox" style="visibility:hidden;"></span>
        <span class="item-icon">📄</span>
        <span class="item-name">${escapeHtml(file.name)}</span>
        <span class="item-size">${sizeStr}</span>
        <span class="item-arrow" style="visibility:hidden;">›</span>
      `;
    }

    elCloudItems.appendChild(item);
  });
}

function updateBreadcrumb(parentId) {
  // 构建面包屑
  let html = '📁 ';
  if (cloudNavStack.length === 0 && !parentId) {
    html += '根目录';
  } else {
    html += '<span class="link" data-nav="root">根目录</span>';
    for (const item of cloudNavStack) {
      html += ' › <span class="link" data-nav="' + item.id + '">' + escapeHtml(item.name) + '</span>';
    }
  }
  elCloudBreadcrumb.innerHTML = html;

  // 绑定面包屑点击
  elCloudBreadcrumb.querySelectorAll('.link').forEach(el => {
    el.addEventListener('click', () => {
      const navId = el.dataset.nav;
      if (navId === 'root') {
        cloudNavStack = [];
        navigateTo(null);
      } else {
        // 回退到该层级
        const idx = cloudNavStack.findIndex(item => item.id === navId);
        if (idx >= 0) {
          cloudNavStack = cloudNavStack.slice(0, idx + 1);
          navigateTo(navId);
        }
      }
    });
  });
}

async function enterFolder(folderId, folderName) {
  cloudNavStack.push({ id: folderId, name: folderName });
  await navigateTo(folderId);
}

function toggleFolder(folderId, folderName) {
  if (cloudChecked.has(folderId)) {
    cloudChecked.delete(folderId);
    syncFolders = syncFolders.filter(f => f.cloudId !== folderId);
    log('取消选择: ' + folderName + '（已清理同步记录）');
    // 清理数据库中的该目录记录
    API.cleanFolderDb(folderId);
  } else {
    cloudChecked.add(folderId);
    if (!syncFolders.find(f => f.cloudId === folderId)) {
      syncFolders.push({ name: folderName, cloudId: folderId });
    }
    log('已选择同步文件夹: ' + folderName);
  }

  document.querySelectorAll('.cloud-item[data-is-folder="1"]').forEach(el => {
    if (cloudChecked.has(el.dataset.id)) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });

  renderSelectedFolders();

  config.syncFolders = syncFolders.map(f => f.name);
  config._syncFoldersDetail = syncFolders;
  API.saveConfig(config);
}

function renderSelectedFolders() {
  if (syncFolders.length === 0) {
    elSelectedHint.classList.remove('hidden');
    elFolderTags.innerHTML = '';
  } else {
    elSelectedHint.classList.add('hidden');
    elFolderTags.innerHTML = syncFolders.map(f =>
      `<span class="folder-tag">📁 ${escapeHtml(f.name)} <span class="remove" data-id="${escapeHtml(f.cloudId || f.name)}">×</span></span>`
    ).join('');

    elFolderTags.querySelectorAll('.remove').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        cloudChecked.delete(id);
        syncFolders = syncFolders.filter(f => (f.cloudId || f.name) !== id);
        renderSelectedFolders();
        document.querySelectorAll('.cloud-item.selected').forEach(item => {
          if (item.dataset.id === id) item.classList.remove('selected');
        });
        config.syncFolders = syncFolders.map(f => f.name);
        API.saveConfig(config);
        // 清理数据库记录
        API.cleanFolderDb(id);
        log('已移除同步文件夹（同步记录已清理）');
      });
    });
  }
}

// ========== 授权状态 ==========

async function checkAuth() {
  try {
    const status = await API.getAuthStatus();
    if (status.authorized) {
      isLoggedIn = true;
      elAuthStatus.innerHTML = '<span class="status-dot online"></span><span>已登录</span>';
      elAccountInfo.classList.remove('hidden');
      elUserName.textContent = '👤 ' + status.userName;
      const usedGb = formatGb(status.usedSpace);
      const totalGb = formatGb(status.totalCapacity);
      elStorageInfo.textContent = `💾 ${usedGb} / ${totalGb}`;
      elBtnBrowseCloud.disabled = false;
      elCloudFolderHint.textContent = '点击"浏览云盘"查看并选择要同步的文件夹';
    } else {
      isLoggedIn = false;
      elAuthStatus.innerHTML = '<span class="status-dot offline"></span><span>未登录</span>';
      elAccountInfo.classList.add('hidden');
      elBtnBrowseCloud.disabled = true;
      elCloudFolderHint.textContent = '登录后可浏览云盘文件夹并选择要同步的内容';
    }
  } catch (err) {
    elAuthStatus.innerHTML = '<span class="status-dot offline"></span><span>状态检查失败</span>';
  }
}

// ========== 同步状态处理 ==========

function handleSyncStatus(type, data) {
  switch (type) {
    case 'log':
      log(data.message, data.level);
      break;
    case 'progress':
      elProgressText.textContent = data.message;
      if (data.total > 0) {
        elProgressFill.style.width = Math.round((data.current / data.total) * 100) + '%';
      }
      break;
    case 'transfer':
      log(`[${data.action}] ${data.filePath}`);
      break;
    case 'auth':
      if (data.status === 'needed') log('需要重新登录', 'warn');
      break;
    case 'complete':
      log('✅ 同步完成！', 'info');
      resetSyncUI();
      break;
    case 'error':
      log('❌ 同步错误: ' + data.message, 'error');
      resetSyncUI();
      break;
  }
}

function resetSyncUI() {
  isSyncing = false;
  elBtnSync.classList.remove('hidden');
  elBtnCancelSync.classList.add('hidden');
  elSyncStatus.textContent = '就绪';
  elSyncStatus.className = 'sync-badge idle';
  elProgressFill.style.width = '0%';
  checkAuth();
}

// ========== 工具函数 ==========

function log(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  entry.textContent = `[${timestamp}] ${message}`;
  elLogArea.appendChild(entry);
  elLogArea.scrollTop = elLogArea.scrollHeight;
  while (elLogArea.children.length > 500) {
    elLogArea.removeChild(elLogArea.firstChild);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch (e) { return ''; }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatGb(bytes) {
  if (!bytes) return '0Gb';
  return Math.round(bytes / (1024 * 1024 * 1024)) + 'Gb';
}

// ========== 启动 ==========
document.addEventListener('DOMContentLoaded', init);
