# 华为云盘同步工具

华为云空间云盘双向同步工具，提供 **macOS 桌面应用**（Electron）和 **命令行版本**（h.js）。

## macOS 桌面应用

### 使用方法

```bash
npm install
npm start
# 或双击 start.sh
```

### 操作步骤

1. **选择本地目录** — 点击「选择目录」，设置 Mac 上的同步文件夹
2. **登录华为云盘** — 点击「获取授权链接」→ 在浏览器中打开 → 登录华为账号 → 授权后复制地址栏中的完整 URL → 粘贴回应用 → 提交
3. **选择同步文件夹** — 点击「📂 浏览云盘」，勾选云盘根目录下需要同步的文件夹（可进入子目录浏览）
4. **开始同步** — 点击「开始同步」，应用会自动双向同步选中的文件夹

### 打包

```bash
npm run build   # 生成 .dmg 安装包
```

### 数据存储

| 数据 | 位置 |
|------|------|
| 配置 | `~/.huaweicloud-sync/config.json` |
| Token | `~/.huaweicloud-sync/access_token.json` |
| 数据库 | `~/.huaweicloud-sync/sync.db` |

## 命令行版本

原始 CLI 工具 `h.js`，适用于 NAS、Linux、无 GUI 环境。

```bash
npm install
node h.js
```

首次运行按提示粘贴授权 URL，后续运行自动刷新 token。

## 同步机制

双向同步，以云端编辑时间和本地同步时间判断冲突：

| 云端 | 本地 | 条件 | 操作 |
|------|------|------|------|
| 有 | 有 | 云端更新 且 hash 不同 | 下载（云→地） |
| 有 | 有 | 尺寸/hash 不同 | 上传（地→云） |
| 有 | 无 | 之前同步过（本地被删） | 删除云端 |
| 有 | 无 | 未同步过 | 下载（云→地） |
| 无 | 有 | — | 上传（地→云） |

## 参考文档

- [华为 OAuth 授权](https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/web-get-access-token-0000001050048946)
- [华为云盘 API](https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-dev-process-0000001064314366)
