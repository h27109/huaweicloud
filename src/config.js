/**
 * 配置管理模块
 * 所有敏感数据存储在 ~/.huaweicloud-sync/ 目录下，与项目仓库完全隔离
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置目录和文件路径（在用户 home 目录下，不在项目仓库内）
const CONFIG_DIR = path.join(os.homedir(), '.huaweicloud-sync');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'access_token.json');
const DB_FILE = path.join(CONFIG_DIR, 'sync.db');

// 默认配置（OAuth 凭据内置，开箱即用）
const DEFAULT_CONFIG = {
  localRoot: '',
  syncFolders: [],
  clientId: '105816847',
  clientSecret: '9dbef5edebd2dfec86700bc27ae606039d5d8cfe08a0206a48f05159d738a386',
  concurrency: 10
};

/**
 * 确保配置目录存在
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * 加载配置，如果不存在则创建默认配置
 */
function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data);
    // 合并默认值，确保所有字段存在
    return { ...DEFAULT_CONFIG, ...config };
  } catch (err) {
    console.error('读取配置文件失败，使用默认配置:', err.message);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存配置
 */
function saveConfig(config) {
  ensureConfigDir();
  const data = JSON.stringify(config, null, 2);
  // 原子写入：先写临时文件，再重命名
  const tmpFile = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, data, { mode: 0o600 });
  fs.renameSync(tmpFile, CONFIG_FILE);
}

/**
 * 获取数据库文件路径
 */
function getDbPath() {
  ensureConfigDir();
  return DB_FILE;
}

/**
 * 获取 token 文件路径
 */
function getTokenPath() {
  ensureConfigDir();
  return TOKEN_FILE;
}

/**
 * 获取配置目录路径
 */
function getConfigDir() {
  return CONFIG_DIR;
}

module.exports = {
  loadConfig,
  saveConfig,
  getDbPath,
  getTokenPath,
  getConfigDir,
  DEFAULT_CONFIG
};
