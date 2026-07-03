# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

华为云盘同步 macOS 桌面应用（Electron）。从原始 CLI 工具 `h.js` 重构而来，提供 GUI 界面进行双向文件同步。

## 常用命令

```bash
npm start          # 启动 Electron 应用（开发模式）
npm run build      # 打包 macOS .app / .dmg（electron-builder）
npm install        # 安装依赖（postinstall 自动 electron-rebuild better-sqlite3）
```

**注意**：`better-sqlite3` 是 native 模块，需要针对 Electron 的 Node ABI 重新编译。如果 `npm install` 后 Electron 启动报错，手动运行：
```bash
rm -rf node_modules/electron
npm install electron@33 --ignore-scripts
cd node_modules/electron && node install.js && cd -
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

## 架构

```
main.js                     # Electron 主进程：窗口管理、IPC handlers、生命周期
preload.js                  # contextBridge：暴露安全 API 给渲染进程
src/
  config.js                 # 配置读写（~/.huaweicloud-sync/config.json）
  auth.js                   # OAuth 2.0 授权码流程（生成链接 → 用户粘贴回调 URL → 换 token）
  api.js                    # 华为云盘 HTTPS API 封装
  db.js                     # SQLite 数据库（SyncDatabase 类）
  sync.js                   # 同步引擎（SyncEngine 类）
renderer/
  index.html / style.css / app.js   # 前端 UI（原生 HTML/CSS/JS，无框架）
h.js                        # 原始 CLI 工具（参考，不再使用）
```

### 数据流

```
渲染进程 (app.js)
  ── ipcRenderer.invoke() ──→  preload.js (contextBridge)
    ── ipcMain.handle() ──→  main.js
      ──→  auth.js → api.js → 华为云服务器
      ──→  sync.js → db.js → SQLite (~/.huaweicloud-sync/sync.db)
  ←── webContents.send() ──  sync-status 推送进度
```

### 同步引擎核心流程

`SyncEngine.runFullSync()` 在 `sync.js` 中：

1. **认证检查** — `auth.getValidToken()` 自动用 refresh_token 刷新
2. **列出云盘文件** — `_fetchAllFiles()` 递归遍历 `syncFolders` 中每个文件夹的子树，写入 `fileinfos_temp` 表
3. **合并数据库** — `db.mergeTables()` 比较 `fileinfos_temp` 与 `fileinfos`，检测新增/删除/变更
4. **双向比较** — `_mergeFile()` 递归比较每个同步文件夹对：
   - 云端有/本地有 → 比较 hash 和编辑时间 → download 或 update
   - 云端有/本地无 + `editedTimeMS < syncTimeMS` → 删除云端（用户删了本地）
   - 本地有/云端无 → upload 或创建文件夹
5. **处理传输队列** — `_processTransfers()` 并发下载/上传/删除

### 数据库

三个表（`db.js` — `SyncDatabase` 类）：

- **`fileinfos`** — 云端文件元数据（id, fileName, parentFolder, editedTimeMS, syncTimeMS, sha256, size）
- **`fileinfos_temp`** — 本次扫描的临时数据，用于 diff 检测变更
- **`transfer_list`** — 传输队列（t_type: download/upload/update/delete/delete_local）

`~/.huaweicloud-sync/sync.db` 在项目目录外，不提交到 Git。

### OAuth 流程

原始 CLI 的复制粘贴方式（`auth.js`）：
1. `getAuthUrl()` — 生成授权链接（scope 中的 `+` 是空格分隔，不能 encode）
2. 用户浏览器登录 → 华为回调到 `https://github.com/h27109/huaweicloud?code=...`
3. 用户复制完整 URL 粘贴回应用
4. `exchangeRedirectUrl()` — 从 URL 提取 code → POST `/oauth2/v3/token` 换 token
5. Token 保存到 `~/.huaweicloud-sync/access_token.json`

OAuth 凭据（clientId/clientSecret）为内置默认值（`config.js` DEFAULT_CONFIG），UI 不暴露。

### 敏感数据

| 数据 | 位置 |
|------|------|
| OAuth 凭据 | `src/config.js`（内置默认值） |
| OAuth token | `~/.huaweicloud-sync/access_token.json` |
| 同步数据库 | `~/.huaweicloud-sync/sync.db` |
| 用户配置 | `~/.huaweicloud-sync/config.json` |

`~/.huaweicloud-sync/` 在项目仓库外。`.gitignore` 排除了 `.h.db`、`ACCESS_TOKEN.DATA`、`dist/`、`out/`。

### 云盘 API 端点

- 认证：`oauth-login.cloud.huawei.com` — `/oauth2/v3/authorize`、`/oauth2/v3/token`
- 业务：`driveapis.cloud.huawei.com.cn` — `/drive/v1/files`、`/drive/v1/about`
- 上传：`/upload/drive/v1/files?uploadType=resume`（断点续传，20MB 分片）

### 同步删除机制

双向同步的分支判断：

| 云端 | 本地 | 条件 | 操作 |
|------|------|------|------|
| 有 | 有 | `editedTimeMS > syncTimeMS` 且 hash 不同 | 下载（云→地） |
| 有 | 有 | 尺寸/hash 不同 | 更新上传（地→云） |
| 有 | 无 | `editedTimeMS < syncTimeMS` | **删除云端**（本地之前同步过后来删了） |
| 有 | 无 | `editedTimeMS >= syncTimeMS` | 下载（云→地） |
| 无 | 有 | — | 上传（地→云） |

取消勾选同步文件夹时，应用会调用 `db.deleteFolderTree()` 递归清理该文件夹在数据库中的所有记录，不触发任何一端删除。
