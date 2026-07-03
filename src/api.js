/**
 * 华为云盘 API 封装模块
 * 所有 API 调用函数，accessToken 作为参数传入
 */
const https = require('https');
const url = require('url');
const querystring = require('querystring');

// API 基础地址
const AUTH_HOST = 'oauth-login.cloud.huawei.com';
const DRIVE_HOST = 'driveapis.cloud.huawei.com.cn';

// OAuth 相关常量（公开信息，可存在于源码中）
const SCOPE = 'openid+profile+https://www.huawei.com/auth/drive';
const OAUTH_STATE = 'h27109_huaweicloud';

/**
 * 构建授权 URL
 */
function buildAuthorizeUrl(clientId, redirectUri) {
  return 'https://' + AUTH_HOST + '/oauth2/v3/authorize?'
    + 'response_type=code&access_type=offline&state=' + OAUTH_STATE
    + '&client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&scope=' + SCOPE  // scope 中的 + 是空格分隔，不能 encode
    + '&prompt=consent';
}

/**
 * 用 authorization code 交换 token
 */
function exchangeCodeForToken(code, clientId, clientSecret, redirectUri) {
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    code: code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri
  });

  return httpsRequest({
    hostname: AUTH_HOST,
    port: 443,
    path: '/oauth2/v3/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData, 'utf8')
    }
  }, postData);
}

/**
 * 用 refresh_token 刷新 access_token
 */
function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const postData = querystring.stringify({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  return httpsRequest({
    hostname: AUTH_HOST,
    port: 443,
    path: '/oauth2/v3/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData, 'utf8')
    }
  }, postData);
}

/**
 * 获取用户信息和容量
 */
function getAbout(accessToken) {
  return httpsRequest({
    hostname: DRIVE_HOST,
    path: '/drive/v1/about?fields=*',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken
    }
  });
}

/**
 * 获取文件列表（支持分页和查询）
 */
function listFiles(accessToken, queryParam = '', cursor = '') {
  let query = '';
  if (cursor) query += '&cursor=' + encodeURIComponent(cursor);
  if (queryParam) query += '&queryParam=' + encodeURIComponent(queryParam);

  return httpsRequest({
    hostname: DRIVE_HOST,
    path: '/drive/v1/files?fields=*&pageSize=100' + query,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken
    }
  });
}

/**
 * 创建文件夹
 */
function createFolder(accessToken, folderObj) {
  const body = typeof folderObj === 'string' ? folderObj : JSON.stringify(folderObj);
  return httpsRequest({
    hostname: DRIVE_HOST,
    port: 443,
    path: '/drive/v1/files?fields=*',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      Authorization: 'Bearer ' + accessToken
    }
  }, body);
}

/**
 * 下载文件内容（返回 Buffer）
 */
function downloadFile(accessToken, fileId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: DRIVE_HOST,
      path: '/drive/v1/files/' + fileId + '?form=content',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + accessToken
      }
    };

    const req = https.get(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 删除文件或文件夹
 */
function deleteFile(accessToken, fileId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: DRIVE_HOST,
      port: 443,
      path: '/drive/v1/files/' + fileId,
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 0,
        Authorization: 'Bearer ' + accessToken
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 创建断点续传会话（新文件上传）
 */
function createUploadSession(accessToken, fileObj, contentLength, contentType) {
  const body = typeof fileObj === 'string' ? fileObj : JSON.stringify(fileObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: DRIVE_HOST,
      port: 443,
      path: '/upload/drive/v1/files?uploadType=resume',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': contentLength,
        Authorization: 'Bearer ' + accessToken
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(json);
          } else {
            resolve({ ...json, headers: res.headers, statusCode: res.statusCode });
          }
        } catch (e) {
          resolve({ headers: res.headers, statusCode: res.statusCode });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 上传文件分片
 */
function uploadChunk(accessToken, uploadUrl, chunk, start, end, total, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(uploadUrl);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.path,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': end - start,
        'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + total,
        Authorization: 'Bearer ' + accessToken
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(json);
          } else {
            resolve({ ...json, statusCode: res.statusCode, headers: res.headers });
          }
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(chunk);
    req.end();
  });
}

/**
 * 更新文件（创建更新上传会话）
 */
function updateFileUpload(accessToken, fileId, updateInfo, contentLength, contentType) {
  const body = typeof updateInfo === 'string' ? updateInfo : JSON.stringify(updateInfo);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: DRIVE_HOST,
      port: 443,
      path: '/upload/drive/v1/files/' + fileId + '?uploadType=resume&fields=*',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': contentLength,
        Authorization: 'Bearer ' + accessToken
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(json);
          } else {
            resolve({ ...json, headers: res.headers, statusCode: res.statusCode });
          }
        } catch (e) {
          resolve({ headers: res.headers, statusCode: res.statusCode });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 通用 HTTPS 请求辅助函数
 */
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject({ ...json, statusCode: res.statusCode });
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data.substring(0, 200)));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getAbout,
  listFiles,
  createFolder,
  downloadFile,
  deleteFile,
  createUploadSession,
  uploadChunk,
  updateFileUpload,
  AUTH_HOST,
  DRIVE_HOST,
  SCOPE,
  OAUTH_STATE
};
