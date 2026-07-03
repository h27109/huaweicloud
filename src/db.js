/**
 * 数据库操作模块
 * 封装 SQLite 数据库操作，管理文件信息和传输队列
 */
const Database = require('better-sqlite3');
const path = require('path');

class SyncDatabase {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  /**
   * 创建表结构
   */
  createTables() {
    const sql = `
      CREATE TABLE IF NOT EXISTS "fileinfos" (
        "id" TEXT,
        "fileName" TEXT,
        "mimeType" TEXT,
        "parentFolder" TEXT,
        "createdTime" TEXT,
        "editedTime" TEXT,
        "editedTimeMS" INTEGER,
        "syncTimeMS" INTEGER DEFAULT 0,
        "size" INTEGER,
        "sha256" TEXT,
        "version" INTEGER
      );

      CREATE TABLE IF NOT EXISTS "fileinfos_temp" (
        "id" TEXT,
        "fileName" TEXT,
        "mimeType" TEXT,
        "parentFolder" TEXT,
        "createdTime" TEXT,
        "editedTime" TEXT,
        "editedTimeMS" INTEGER,
        "size" INTEGER,
        "sha256" TEXT,
        "version" INTEGER
      );

      CREATE TABLE IF NOT EXISTS "transfer_list" (
        "t_id" INTEGER NOT NULL UNIQUE,
        "t_f_id" TEXT,
        "t_type" TEXT,
        "t_url" TEXT,
        "t_start" INTEGER,
        "t_end" INTEGER,
        "t_total" INTEGER,
        "t_parentFolder" TEXT,
        "t_file_path" TEXT,
        "t_info" TEXT,
        "t_mimeType" TEXT,
        "t_filename" TEXT,
        PRIMARY KEY("t_id" AUTOINCREMENT)
      );

      DELETE FROM fileinfos_temp;
    `;
    this.db.exec(sql);
  }

  /**
   * 批量插入文件信息
   */
  insertFiles(files, inTemp = true) {
    const tableName = inTemp ? 'fileinfos_temp' : 'fileinfos';
    if (!files || files.length === 0) return;

    const insert = this.db.prepare(
      `INSERT INTO ${tableName} (id, fileName, mimeType, createdTime, size, sha256, parentFolder, editedTime, editedTimeMS, version)
       VALUES (@id, @fileName, @mimeType, @createdTime, @size, @sha256, @parentFolder, @editedTime, @editedTimeMS, @version)`
    );

    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        insert.run({
          id: item.id,
          fileName: item.fileName,
          mimeType: item.mimeType,
          createdTime: item.createdTime,
          size: item.size || 0,
          sha256: item.sha256 || '',
          parentFolder: Array.isArray(item.parentFolder) ? item.parentFolder.toString() : (item.parentFolder || ''),
          editedTime: item.editedTime,
          editedTimeMS: new Date(item.editedTime).getTime(),
          version: item.version || 0
        });
      }
    });

    insertMany(files);
  }

  /**
   * 查询指定父目录下的文件
   */
  getFilesByParent(parentFolder) {
    return this.db.prepare('SELECT * FROM fileinfos WHERE parentFolder = ?').all(parentFolder);
  }

  /**
   * 合并 temp 表到正式表（检测新增/删除/变更）
   */
  mergeTables() {
    // 1. 新增文件：从 temp 插入到 fileinfos
    this.db.exec(`
      INSERT INTO fileinfos(id, fileName, mimeType, parentFolder, createdTime, editedTime, editedTimeMS, size, sha256, version)
      SELECT id, fileName, mimeType, parentFolder, createdTime, editedTime, editedTimeMS, size, sha256, version
      FROM fileinfos_temp ft
      WHERE NOT EXISTS (SELECT 1 FROM fileinfos f WHERE f.id = ft.id)
    `);

    // 2. 删除文件：添加 delete_local 传输任务
    this.db.exec(`
      INSERT INTO transfer_list (t_f_id, t_type, t_parentFolder, t_mimeType, t_filename)
      SELECT id, 'delete_local', parentFolder, mimeType, fileName
      FROM fileinfos
      WHERE NOT EXISTS (SELECT 1 FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id)
    `);

    // 3. 从 fileinfos 删除云端已不存在的记录
    this.db.exec(`
      DELETE FROM fileinfos
      WHERE NOT EXISTS (SELECT 1 FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id)
    `);

    // 4. 更新变更文件
    this.db.exec(`
      UPDATE fileinfos SET
        editedTime = (SELECT editedTime FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1),
        editedTimeMS = (SELECT editedTimeMS FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1),
        size = (SELECT size FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1),
        version = (SELECT version FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1),
        sha256 = (SELECT sha256 FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1),
        parentFolder = (SELECT parentFolder FROM fileinfos_temp WHERE fileinfos_temp.id = fileinfos.id LIMIT 0,1)
      WHERE EXISTS (
        SELECT 1 FROM fileinfos_temp
        WHERE fileinfos_temp.id = fileinfos.id
          AND (fileinfos_temp.editedTime != fileinfos.editedTime
            OR fileinfos_temp.size != fileinfos.size
            OR fileinfos_temp.version != fileinfos.version
            OR fileinfos_temp.sha256 != fileinfos.sha256
            OR fileinfos_temp.parentFolder != fileinfos.parentFolder)
      )
    `);
  }

  /**
   * 更新同步时间
   */
  updateSyncTime(fileId, syncTimeMS) {
    this.db.prepare('UPDATE fileinfos SET syncTimeMS = @syncTimeMS WHERE id = @id').run({
      id: fileId,
      syncTimeMS: syncTimeMS
    });
  }

  /**
   * 批量更新同步时间
   */
  batchUpdateSyncTime(updates) {
    if (!updates || updates.length === 0) return;
    const stmt = this.db.prepare('UPDATE fileinfos SET syncTimeMS = @syncTimeMS WHERE id = @id');
    const batch = this.db.transaction((items) => {
      for (const item of items) stmt.run(item);
    });
    batch(updates);
  }

  /**
   * 添加传输任务
   */
  addTransfers(transfers) {
    if (!transfers || transfers.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO transfer_list (t_f_id, t_type, t_parentFolder, t_file_path, t_info)
       SELECT @t_f_id, @t_type, @t_parentFolder, @t_file_path, @t_info
       WHERE NOT EXISTS (
         SELECT 1 FROM transfer_list WHERE t_file_path = @t_file_path AND t_file_path IS NOT NULL LIMIT 0,1
       )`
    );
    const insertMany = this.db.transaction((items) => {
      for (const item of items) insert.run(item);
    });
    insertMany(transfers);
  }

  /**
   * 获取待处理的传输任务
   */
  getPendingTransfers(excludeIds, limit) {
    const ids = excludeIds.length > 0 ? excludeIds.join(',') : '0';
    return this.db.prepare(
      `SELECT * FROM transfer_list
       WHERE t_id NOT IN (${ids}) AND t_type != 'delete_local'
       ORDER BY t_id ASC LIMIT 0, ?`
    ).all(limit);
  }

  /**
   * 更新传输任务进度
   */
  updateTransfer(transfer) {
    this.db.prepare(
      `UPDATE transfer_list SET t_url=@t_url, t_start=@t_start, t_end=@t_end, t_total=@t_total WHERE t_id=@t_id`
    ).run(transfer);
  }

  /**
   * 删除传输任务
   */
  removeTransfer(transferId) {
    this.db.prepare('DELETE FROM transfer_list WHERE t_id = ?').run(transferId);
  }

  /**
   * 获取本地删除任务
   */
  getDeleteLocalTransfers(folderId) {
    return this.db.prepare(
      "SELECT * FROM transfer_list WHERE t_parentFolder = ? AND t_type = 'delete_local'"
    ).all(folderId);
  }

  /**
   * 清理本地删除任务
   */
  clearDeleteLocalTransfers(folderId) {
    this.db.prepare(
      "DELETE FROM transfer_list WHERE t_parentFolder = ? AND t_type = 'delete_local'"
    ).run(folderId);
  }

  /**
   * 查询传输队列数量
   */
  getTransferCount() {
    return this.db.prepare(
      "SELECT COUNT(*) as count FROM transfer_list WHERE t_type != 'delete_local'"
    ).get().count;
  }

  /**
   * 删除指定文件夹及其所有子文件的数据库记录
   * @param {string} folderId - 云盘文件夹 ID
   */
  deleteFolderTree(folderId) {
    // 递归收集所有后代 ID
    const collectDescendants = (parentId) => {
      const children = this.db.prepare(
        "SELECT id FROM fileinfos WHERE parentFolder = ?"
      ).all(parentId);
      let ids = [];
      for (const child of children) {
        ids.push(child.id);
        ids = ids.concat(collectDescendants(child.id));
      }
      return ids;
    };

    const allIds = [folderId, ...collectDescendants(folderId)];

    if (allIds.length === 0) return;

    // 批量删除
    const placeholders = allIds.map(() => '?').join(',');
    this.db.prepare(
      `DELETE FROM fileinfos WHERE id IN (${placeholders})`
    ).run(...allIds);

    this.db.prepare(
      `DELETE FROM transfer_list WHERE t_f_id IN (${placeholders})`
    ).run(...allIds);

    // 也清理以这些 ID 为 parentFolder 的 delete_local 条目
    const parentPlaceholders = allIds.map(() => '?').join(',');
    this.db.prepare(
      `DELETE FROM transfer_list WHERE t_parentFolder IN (${parentPlaceholders}) AND t_type = 'delete_local'`
    ).run(...allIds);
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = SyncDatabase;
