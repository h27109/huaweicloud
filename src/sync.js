/**
 * 同步引擎模块
 * 编排完整的云↔地双向同步流程
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Mutex } = require('async-mutex');
const api = require('./api');
const SyncDatabase = require('./db');
const { getValidToken, saveToken } = require('./auth');
const { loadConfig, getDbPath, getTokenPath } = require('./config');

// 常量
const MAX_UPLOAD_SIZE = 1024 * 1024 * 20; // 20MB 分片

// MIME 类型映射
const MIMETYPES = {
  '.3gp': 'video/3gpp', '.apk': 'application/vnd.android.package-archive',
  '.asf': 'video/x-ms-asf', '.avi': 'video/x-msvideo',
  '.bin': 'application/octet-stream', '.bmp': 'image/bmp',
  '.c': 'text/plain', '.class': 'application/octet-stream',
  '.conf': 'text/plain', '.cpp': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.exe': 'application/octet-stream', '.gif': 'image/gif',
  '.gz': 'application/x-gzip', '.h': 'text/plain',
  '.htm': 'text/html', '.html': 'text/html',
  '.jar': 'application/java-archive', '.java': 'text/plain',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.jpe': 'image/jpeg',
  '.js': 'application/x-javascript', '.log': 'text/plain',
  '.m4a': 'audio/mp4a-latm', '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime', '.mp3': 'audio/x-mpeg',
  '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
  '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf', '.sh': 'text/plain',
  '.tar': 'application/x-tar', '.tgz': 'application/x-compressed',
  '.txt': 'text/plain', '.wav': 'audio/x-wav',
  '.wma': 'audio/x-ms-wma', '.wmv': 'video/x-ms-wmv',
  '.xml': 'text/plain', '.zip': 'application/x-zip-compressed',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mkv': 'video/x-matroska', '.webm': 'video/x-matrosk',
  '.flv': 'video/x-flv',
  'def': 'application/octet-stream'
};

class SyncEngine {
  constructor(db, onStatus, config) {
    this.db = db;
    this.onStatus = onStatus || (() => {});
    this.config = config;
    this.accessToken = null;
    this.downList = [];
    this.locker = new Mutex();
    this.cancelled = false;
    this.concurrency = config.concurrency || 6;
  }

  log(message, level = 'info') {
    this.onStatus('log', { message, level });
  }

  progress(phase, current, total, message) {
    this.onStatus('progress', { phase, current, total, message });
  }

  transfer(action, filePath, bytesTransferred, totalBytes) {
    this.onStatus('transfer', { action, filePath, bytesTransferred, totalBytes });
  }

  /**
   * 取消同步
   */
  cancel() {
    this.cancelled = true;
    this.log('正在取消同步...', 'warn');
  }

  /**
   * 执行完整同步
   */
  async runFullSync() {
    this.cancelled = false;
    try {
      this.log('正在准备同步...');

      // 1. 确保 token 有效
      this.log('检查登录状态...');
      const tokenResult = await getValidToken(this.config);
      if (!tokenResult) {
        this.onStatus('auth', { status: 'needed', message: '需要登录华为云盘' });
        throw new Error('未登录，请先授权登录华为云盘');
      }
      this.accessToken = tokenResult.token;
      this.log('登录状态有效', 'info');

      // 2. 获取云盘文件列表
      this.log('正在获取云盘文件列表...');
      this.progress('listing', 0, 0, '获取云盘文件列表...');

      const rootFiles = await this._fetchAllFiles(false, '', "'root' in parentFolder", true);
      this.log('获取主目录列表完成', 'info');

      // 3. 确保同步文件夹存在
      const pairs = [];
      const syncFolderDetail = this.config._syncFoldersDetail || [];
      for (const folder of this.config.syncFolders) {
        if (this.cancelled) return;
        const folderName = typeof folder === 'string' ? folder : folder.name;
        // 尝试从详情中找到 cloudId
        const detail = syncFolderDetail.find(d => d.name === folderName);
        let cloudId = detail?.cloudId || '';

        if (cloudId) {
          // 用已知的 cloudId 验证文件夹还存在
          const stillExists = rootFiles.some(f => f.id === cloudId);
          if (!stillExists) cloudId = '';
        }

        if (!cloudId) {
          // 按名字查找
          const found = rootFiles.filter(f => f.fileName === folderName && f.mimeType === 'application/vnd.huawei-apps.folder');
          if (found.length === 0) {
            this.log('创建云盘文件夹: ' + folderName);
            const folderObj = JSON.stringify({
              fileName: folderName,
              description: 'Huawei Cloud Sync',
              mimeType: 'application/vnd.huawei-apps.folder',
              parentFolder: ['root']
            });
            const fileInfo = await api.createFolder(this.accessToken, folderObj);
            cloudId = fileInfo.id;
          } else {
            cloudId = found[0].id;
          }
        }

        this.log('遍历目录 [' + folderName + ']: ' + cloudId);
        await this._fetchAllFiles(true, '', "'" + cloudId + "' in parentFolder");
        pairs.push({ cloudId, local: path.join(this.config.localRoot, folderName) });
      }

      // 4. 合并数据库
      this.log('正在比较文件变更...');
      this.progress('comparing', 0, 0, '比较云端与本地文件...');
      this.db.mergeTables();

      // 5. 逐个文件夹双向同步
      for (const p of pairs) {
        if (this.cancelled) return;
        await this._mergeFile(p.cloudId, p.local);
      }

      // 6. 处理传输队列
      if (this.db.getTransferCount() > 0) {
        this.log('开始处理传输队列...');
        this.progress('transferring', 0, 0, '处理文件传输...');
        await this._processTransfers();
      }

      this.log('同步完成！', 'info');
      this.onStatus('complete', { stats: { message: '同步完成' } });
    } catch (err) {
      this.log('同步出错: ' + err.message, 'error');
      this.onStatus('error', { message: err.message });
    }
  }

  /**
   * 递归获取所有文件
   */
  async _fetchAllFiles(traversal, cursor, queryParam, noInsert) {
    let allFiles = [];
    const result = await api.listFiles(this.accessToken, queryParam, cursor);

    const files = result.files || [];
    allFiles = allFiles.concat(files);

    if (!noInsert) this.db.insertFiles(files, true);

    // 处理分页
    if (result.nextCursor) {
      const more = await this._fetchAllFiles(traversal, result.nextCursor, queryParam, noInsert);
      allFiles = allFiles.concat(more);
    }

    // 递归遍历子目录
    if (traversal && files.length > 0) {
      for (const file of files) {
        if (this.cancelled) break;
        if (file.mimeType === 'application/vnd.huawei-apps.folder') {
          await this._fetchAllFiles(true, '', "'" + file.id + "' in parentFolder");
        }
      }
    }

    return allFiles;
  }

  /**
   * 双向合并比较（递归处理子目录）
   */
  async _mergeFile(folderId, localPath) {
    this._ensureDir(localPath);

    // 处理本地删除任务
    const deleteTransfers = this.db.getDeleteLocalTransfers(folderId);
    for (const transfer of deleteTransfers) {
      const fullPath = path.join(localPath, transfer.t_filename);
      if (fs.existsSync(fullPath)) {
        this.log('删除本地: ' + fullPath);
        if (transfer.t_mimeType === 'application/vnd.huawei-apps.folder' && fs.statSync(fullPath).isDirectory()) {
          this._deleteFolder(fullPath);
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
    this.db.clearDeleteLocalTransfers(folderId);

    const dbFiles = this.db.getFilesByParent(folderId);
    let localFiles = [];
    try {
      localFiles = fs.readdirSync(localPath);
    } catch (e) {
      localFiles = [];
    }

    const updateList = [];
    const transferList = [];
    const insertList = [];

    // 处理云端文件
    for (const dbItem of dbFiles) {
      const fullPath = path.join(localPath, dbItem.fileName);
      let foundItem = false;

      for (const locItem of localFiles) {
        if (!foundItem && dbItem.fileName === locItem) {
          try {
            const fileStat = fs.statSync(path.join(localPath, locItem));
            const isDir = fileStat.isDirectory();
            const isCloudDir = dbItem.mimeType === 'application/vnd.huawei-apps.folder';
            if (isDir === isCloudDir) {
              foundItem = { name: locItem, stat: fileStat };
            }
          } catch (e) { /* skip */ }
        }
      }

      if (foundItem) {
        // 云端有，本地有
        if (dbItem.mimeType !== 'application/vnd.huawei-apps.folder') {
          const fileHash = this._hash256(fullPath);
          if (dbItem.editedTimeMS > dbItem.syncTimeMS && fileHash !== dbItem.sha256) {
            this.log('下载（云→地）: ' + dbItem.fileName);
            transferList.push({
              t_f_id: dbItem.id, t_type: 'download', t_parentFolder: folderId,
              t_file_path: fullPath, t_info: ''
            });
          } else if (dbItem.size !== foundItem.stat.size || fileHash !== dbItem.sha256) {
            this.log('更新（地→云）: ' + dbItem.fileName);
            transferList.push({
              t_f_id: dbItem.id, t_type: 'update', t_parentFolder: folderId,
              t_file_path: fullPath,
              t_info: JSON.stringify({ sha256: fileHash, editedTime: new Date().toISOString() })
            });
          } else {
            updateList.push({ id: dbItem.id, syncTimeMS: Date.now() });
          }
        } else {
          await this._mergeFile(dbItem.id, fullPath);
          updateList.push({ id: dbItem.id, syncTimeMS: Date.now() });
        }
      } else {
        // 云端有，本地没有
        if (dbItem.editedTimeMS < dbItem.syncTimeMS) {
          this.log('删除云端: ' + dbItem.fileName);
          transferList.push({
            t_f_id: dbItem.id, t_type: 'delete', t_parentFolder: folderId,
            t_file_path: fullPath, t_info: ''
          });
        } else {
          if (dbItem.mimeType !== 'application/vnd.huawei-apps.folder') {
            this.log('下载（云→地）: ' + dbItem.fileName);
            transferList.push({
              t_f_id: dbItem.id, t_type: 'download', t_parentFolder: folderId,
              t_file_path: fullPath, t_info: ''
            });
          } else {
            this._ensureDir(fullPath);
            await this._mergeFile(dbItem.id, fullPath);
            updateList.push({ id: dbItem.id, syncTimeMS: Date.now() });
          }
        }
      }
    }

    // 处理本地有、云端没有的文件
    for (const locItem of localFiles) {
      const fullPath = path.join(localPath, locItem);
      let fileStat;
      try { fileStat = fs.statSync(fullPath); } catch (e) { continue; }

      let found = false;
      for (const dbItem of dbFiles) {
        if (dbItem.fileName === locItem) {
          const isDir = fileStat.isDirectory();
          const isCloudDir = dbItem.mimeType === 'application/vnd.huawei-apps.folder';
          if (isDir === isCloudDir) found = true;
        }
      }

      if (!found) {
        if (fileStat.isDirectory()) {
          const folderObj = JSON.stringify({
            fileName: locItem,
            mimeType: 'application/vnd.huawei-apps.folder',
            parentFolder: [folderId]
          });
          const fileInfo = await api.createFolder(this.accessToken, folderObj);
          insertList.push({
            id: fileInfo.id, fileName: fileInfo.fileName, mimeType: fileInfo.mimeType,
            createdTime: fileInfo.createdTime, size: fileInfo.size || 0,
            sha256: fileInfo.sha256 || '',
            parentFolder: fileInfo.parentFolder,
            editedTime: fileInfo.editedTime, version: fileInfo.version || 0
          });
          await this._mergeFile(fileInfo.id, fullPath);
        } else {
          this.log('上传文件: ' + fullPath);
          transferList.push({
            t_f_id: '', t_type: 'upload', t_parentFolder: folderId,
            t_file_path: fullPath, t_info: ''
          });
        }
      }
    }

    this.db.insertFiles(insertList, false);
    this.db.batchUpdateSyncTime(updateList);
    this.db.addTransfers(transferList);
  }

  /**
   * 处理传输队列
   */
  async _processTransfers() {
    return new Promise((resolve) => {
      const checkQueue = () => {
        if (this.cancelled) {
          resolve();
          return;
        }

        if (this.downList.length >= this.concurrency) {
          setTimeout(checkQueue, 1000);
          return;
        }

        const limit = this.concurrency - this.downList.length;
        const ids = this.downList.length > 0 ? this.downList.map(t => t.t_id) : [];
        const transfers = this.db.getPendingTransfers(ids, limit);

        if (transfers.length === 0 && this.downList.length === 0) {
          this.log('传输任务全部完成！');
          resolve();
          return;
        }

        for (const transfer of transfers) {
          this.downList.push(transfer);
          this._dispatchTransfer(transfer);
        }

        setTimeout(checkQueue, 2000);
      };

      checkQueue();
    });
  }

  /**
   * 分发传输任务
   */
  async _dispatchTransfer(transfer) {
    try {
      switch (transfer.t_type) {
        case 'download':
          this.log('正在下载: ' + transfer.t_file_path);
          this.transfer('download', transfer.t_file_path, 0, 0);
          await this._downloadFile(transfer);
          this.log('下载完成: ' + transfer.t_file_path);
          this.db.updateSyncTime(transfer.t_f_id, Date.now());
          break;

        case 'update':
        case 'upload':
          await this._uploadFile(transfer);
          break;

        case 'delete':
          this.log('删除云盘文件: ' + transfer.t_f_id);
          await api.deleteFile(this.accessToken, transfer.t_f_id);
          this.log('删除完成: ' + transfer.t_file_path);
          break;
      }
    } catch (err) {
      this.log('传输失败 [' + transfer.t_type + ']: ' + transfer.t_file_path + ' - ' + err.message, 'error');
    }
    await this._removeFromList(transfer.t_id);
  }

  /**
   * 下载文件
   */
  async _downloadFile(transfer) {
    const _ensureDir = (p) => {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    };
    _ensureDir(transfer.t_file_path);

    const data = await api.downloadFile(this.accessToken, transfer.t_f_id);
    fs.writeFileSync(transfer.t_file_path, data);
  }

  /**
   * 上传文件（支持断点续传）
   */
  async _uploadFile(transfer) {
    if (!fs.existsSync(transfer.t_file_path)) {
      this.log('文件不存在，跳过上传: ' + transfer.t_file_path, 'warn');
      return;
    }

    const fileData = fs.readFileSync(transfer.t_file_path);
    const extname = path.extname(transfer.t_file_path);
    const contentType = MIMETYPES[extname] || MIMETYPES['def'];

    if (!transfer.t_url) {
      // 创建上传会话
      if (transfer.t_f_id) {
        // 更新现有文件
        const result = await api.updateFileUpload(
          this.accessToken, transfer.t_f_id, transfer.t_info,
          fileData.length, contentType
        );
        transfer.t_url = result.headers.location;
      } else {
        // 新建文件上传
        const fileObj = JSON.stringify({
          fileName: path.basename(transfer.t_file_path),
          parentFolder: [transfer.t_parentFolder]
        });
        const result = await api.createUploadSession(
          this.accessToken, fileObj, fileData.length, contentType
        );
        transfer.t_url = result.headers.location;
      }
      transfer.t_start = 0;
      transfer.t_end = Math.min(fileData.length, MAX_UPLOAD_SIZE);
      transfer.t_total = fileData.length;
    } else if (transfer.t_end !== transfer.t_total) {
      // 继续上传下一分片
      transfer.t_start = transfer.t_end;
      transfer.t_end = (transfer.t_total - transfer.t_end - 1) < MAX_UPLOAD_SIZE
        ? transfer.t_total
        : MAX_UPLOAD_SIZE + transfer.t_end;
    }

    this.log('正在上传: ' + path.basename(transfer.t_file_path) +
      ' (' + transfer.t_start + '-' + transfer.t_end + '/' + transfer.t_total + ')');
    this.transfer('upload', transfer.t_file_path, transfer.t_end, transfer.t_total);

    const chunk = fileData.slice(transfer.t_start, transfer.t_end);
    const result = await api.uploadChunk(
      this.accessToken, transfer.t_url, chunk,
      transfer.t_start, transfer.t_end, transfer.t_total, contentType
    );

    if (result.statusCode === 200) {
      this.log('上传成功: ' + transfer.t_file_path);
      if (transfer.t_f_id) {
        this.db.updateSyncTime(transfer.t_f_id, Date.now());
      }
    } else if (result.statusCode === 308) {
      // 继续上传
      if (result.rangeList && result.rangeList.length > 0) {
        this.db.updateTransfer(transfer);
        await this._uploadFile(transfer);
      }
    }
  }

  /**
   * 从传输列表中移除
   */
  async _removeFromList(transferId) {
    await this.locker.runExclusive(() => {
      this.db.removeTransfer(transferId);
      const idx = this.downList.findIndex(item => item.t_id === transferId);
      if (idx !== -1) this.downList.splice(idx, 1);
    });
  }

  /**
   * 计算文件 SHA256（流式读取，大文件不阻塞内存）
   */
  _hash256(filePath) {
    const stat = fs.statSync(filePath);
    // 超过 100MB 的文件跳过 hash，用 大小+修改时间 代替比较
    if (stat.size > 100 * 1024 * 1024) {
      return 'bigfile:' + stat.size + ':' + Math.floor(stat.mtimeMs);
    }
    const buffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return hash.digest('hex');
  }

  /**
   * 递归创建目录
   */
  _ensureDir(p) {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }

  /**
   * 递归删除目录
   */
  _deleteFolder(folderPath) {
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        const curPath = path.join(folderPath, file);
        if (fs.statSync(curPath).isDirectory()) {
          this._deleteFolder(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      }
      fs.rmdirSync(folderPath);
    }
  }
}

module.exports = SyncEngine;
