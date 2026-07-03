/**
 * OAuth 认证模块
 * 保持原始流程：打开浏览器授权 → 跳转到 GitHub → 用户复制 URL → 粘贴回应用
 * 所有密钥从 config 读取，源码中不包含任何敏感信息
 */
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { getTokenPath } = require('./config');

/**
 * 生成授权 URL
 * 用户需在浏览器中打开此 URL 进行登录授权
 */
function getAuthUrl(config) {
  if (!config.clientId) {
    throw new Error('请先配置 Client ID');
  }
  // 使用 GitHub 页面作为回调地址（与原始 h.js 一致）
  const redirectUri = 'https://github.com/h27109/huaweicloud';
  return api.buildAuthorizeUrl(config.clientId, redirectUri);
}

/**
 * 处理用户粘贴的回调 URL，提取 code 并交换 token
 * @param {string} redirectUrl - 用户从浏览器地址栏复制的完整 URL
 * @param {Object} config - 配置对象，包含 clientId 和 clientSecret
 * @returns {Promise<Object>} token 数据
 */
async function exchangeRedirectUrl(redirectUrl, config) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('请先配置 Client ID 和 Client Secret');
  }

  // 从 URL 中提取 code（处理 # 和 ? 两种分隔符）
  const urlObj = new URL(redirectUrl.replace('#', '?'));
  const code = urlObj.searchParams.get('code');

  if (!code) {
    // 尝试从 hash 中提取（某些 OAuth 流程用 # 传递参数）
    const hashMatch = redirectUrl.match(/[#?&]code=([^&]+)/);
    if (hashMatch) {
      return exchangeCode(hashMatch[1], config);
    }
    throw new Error('未从 URL 中找到授权码(code)，请确认复制了完整的回调地址');
  }

  return exchangeCode(code, config);
}

/**
 * 用 authorization code 交换 token
 */
async function exchangeCode(code, config) {
  const redirectUri = 'https://github.com/h27109/huaweicloud';
  const tokenData = await api.exchangeCodeForToken(
    code, config.clientId, config.clientSecret, redirectUri
  );

  // 保存 token
  saveToken(tokenData);
  return tokenData;
}

/**
 * 获取有效 token（自动刷新）
 * @returns {Object|null} { token, refreshToken } 或 null（需要重新授权）
 */
async function getValidToken(config) {
  const tokenPath = getTokenPath();

  if (fs.existsSync(tokenPath)) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      if (tokenData.error) {
        throw new Error('Token file contains error');
      }

      // 用 refresh_token 获取新 access_token
      const newToken = await api.refreshAccessToken(
        tokenData.refresh_token,
        config.clientId,
        config.clientSecret
      );

      // 保存新 token
      saveToken(newToken);
      return { token: newToken.access_token, refreshToken: newToken.refresh_token };
    } catch (err) {
      // Token 文件损坏或刷新失败，需要重新授权
      return null;
    }
  }

  return null;
}

/**
 * 保存 token 数据到文件
 */
function saveToken(tokenData) {
  const tokenPath = getTokenPath();
  const dir = path.dirname(tokenPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

/**
 * 检查是否已授权
 */
function isAuthorized() {
  const tokenPath = getTokenPath();
  return fs.existsSync(tokenPath);
}

module.exports = {
  getAuthUrl,
  exchangeRedirectUrl,
  getValidToken,
  saveToken,
  isAuthorized
};
