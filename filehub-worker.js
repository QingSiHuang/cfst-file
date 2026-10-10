// =====================================================================
// filehub - 中科云 S3 文件分发系统 (Cloudflare Worker)
// 架构：浏览器 --分片--> Worker --SigV4签名转发--> s3.cstcloud.cn
//       下载：分享链接 -> Worker 代理(Range透传) -> 中科云
// 特性：5.1MB分片突破100MB限制 / 并发5 / 断点续传 / HMAC限时分享链接
// Secrets: S3_AK / S3_SK / S3_BUCKET / ADMIN_TOKEN / SHARE_SECRET
// Vars(可选): S3_ENDPOINT(默认s3.cstcloud.cn) / S3_REGION(默认cn-north-1)
// =====================================================================

const DEFAULT_ENDPOINT = 's3.cstcloud.cn';
const DEFAULT_REGION = 'cn-north-1';
const CHUNK_SIZE = 5.1 * 1024 * 1024;        // 5.1MB/片（>S3单片5MB下限，留余量）
const MAX_PARTS = 9000;                       // S3上限10000，留余量
const MAX_FILE = 20 * 1024 * 1024 * 1024;    // 单文件上限 20GB（受免费额度约束）
const QUOTA = 20 * 1024 * 1024 * 1024;        // 中科云免费总额度 20GB（所有桶共享）

// ---------------- SigV4 (Web Crypto) ----------------
const TE = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(data) {
  const buf = typeof data === 'string' ? TE.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', buf));
}
async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? TE.encode(data) : data));
}
async function s3Fetch(env, method, rawKeyPath, query, opts) {
  opts = opts || {};
  const endpoint = env.S3_ENDPOINT || DEFAULT_ENDPOINT;
  const region = env.S3_REGION || DEFAULT_REGION;
  const bucket = opts.bucket || env.S3_BUCKET;
  const host = endpoint.startsWith('http') ? new URL(endpoint).host : endpoint;
  const proto = endpoint.startsWith('http://') ? (endpoint.startsWith('https://') ? 'https:' : 'http:') : 'https:';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 空 body 的 SHA-256
  const payloadHash = opts.payloadHash || (opts.body ? 'UNSIGNED-PAYLOAD' : EMPTY_SHA);
  // canonical URI: root 模式为 /，否则 path-style /bucket/key，每段 RFC3986 编码（key 为原始未编码文本）
  const segs = opts.root ? '/' : ('/' + bucket + '/' + rawKeyPath).split('/').map(s => encodeURIComponent(s)).join('/');
  const qs = Object.entries(query || {}).filter(([k, v]) => v !== undefined).sort().map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
  const headers = { 'host': host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  if (opts.contentType) headers['content-type'] = opts.contentType;
  if (opts.contentLength != null) headers['content-length'] = String(opts.contentLength);
  const hkeys = Object.keys(headers).sort();
  const canonicalHeaders = hkeys.map(k => k + ':' + headers[k] + '\n').join('');
  const signedHeaders = hkeys.join(';');
  const canonicalRequest = [method, segs, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let sk = await hmac(TE.encode('AWS4' + env.S3_SK), dateStamp);
  sk = await hmac(sk, region); sk = await hmac(sk, 's3'); sk = await hmac(sk, 'aws4_request');
  const signature = hex(await hmac(sk, stringToSign));
  const auth = 'AWS4-HMAC-SHA256 Credential=' + env.S3_AK + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const url = proto + '//' + host + segs + (qs ? '?' + qs : '');
  const sendHeaders = { ...headers, 'authorization': auth, ...(opts.extraHeaders || {}) };
  return fetch(url, { method, headers: sendHeaders, body: opts.body || undefined });
}

// ---------------- 工具 ----------------
function json(status, obj) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
function xmlUnescape(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function safeName(name) {
  return String(name).replace(/[\r\n\t\0\\/]/g, '_').replace(/\.{2,}/g, '.').replace(/[<>:"|?*]/g, '_').replace(/\(/g, '（').replace(/\)/g, '）').slice(0, 180) || 'unnamed';
}
function randId(n) { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, n * 2); }
function buildKey(name) {
  const d = new Date();
  const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
  return 'files/' + ym + '/' + randId(4) + '-' + safeName(name);
}
function decodeKeyPath(segs) { return segs.map(s => { try { return decodeURIComponent(s); } catch { return s; } }).join('/'); }
async function shareSig(env, key, exp) {
  return hex(await hmac(TE.encode(env.SHARE_SECRET), 'dl|' + key + '|' + exp)).slice(0, 32);
}
const INLINE_MIME = /^(image\/|video\/|audio\/|text\/|application\/pdf$)/;
function guessMime(name, provided) {
  if (provided && provided !== 'application/octet-stream' && provided !== '') return provided;
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const map = { pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' };
  return (ext && map[ext]) || 'application/octet-stream';
}
function fmtG(b) { return b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(2) + 'GB' : (b / 1024 / 1024).toFixed(1) + 'MB'; }
async function accountUsage(env) {
  // 实时统计：ListBuckets 列出账号下所有桶，逐桶累加（不缓存，保证跨实例准确）
  try {
    const r = await s3Fetch(env, 'GET', '', null, { root: true });
    if (r.status !== 200) return -1;
    const t = await r.text();
    const buckets = [];
    const re = /<Bucket>([\s\S]*?)<\/Bucket>/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const nm = m[1].match(/<Name>([^<]+)<\/Name>/);
      if (nm) buckets.push(nm[1]);
    }
    let total = 0;
    for (const b of buckets) {
      let token = null, pages = 0;
      do {
        const q = { 'list-type': '2', 'max-keys': '1000' };
        if (token) q['continuation-token'] = token;
        const br = await s3Fetch(env, 'GET', '', q, { bucket: b });
        if (br.status !== 200) break;
        const bt = await br.text();
        const cre = /<Contents>([\s\S]*?)<\/Contents>/g;
        let cm;
        while ((cm = cre.exec(bt)) !== null) {
          const sm = cm[1].match(/<Size>(\d+)<\/Size>/);
          total += Number(sm ? sm[1] : 0);
        }
        token = (bt.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null;
        pages++;
      } while (token && pages < 10);
    }
    return total;
  } catch { return -1; }
}
// ---------------- UA 解析 + D1 ----------------
function parseUA(ua) {
  ua = ua || '';
  let os = '未知';
  if (/Windows NT 10/.test(ua)) os = 'Windows';
  else if (/Windows NT/.test(ua)) os = 'Windows(旧)';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = '未知';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';
  else if (/Chromium\//.test(ua)) browser = 'Chromium';
  return { os, browser };
}
async function ensureDB(env) {
  if (!env.DB) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS uploads (file_key TEXT PRIMARY KEY, ip TEXT, os TEXT, browser TEXT, ua TEXT, upload_time TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, file_key TEXT, ip TEXT, os TEXT, browser TEXT, ua TEXT, dl_time TEXT)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dl_key ON downloads(file_key)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT, action TEXT, ip TEXT, os TEXT, browser TEXT, ua TEXT, log_time TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, file_key TEXT, expire INTEGER, days INTEGER)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS hashes (hash TEXT PRIMARY KEY, file_key TEXT, size INTEGER, file_name TEXT, hash_time TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE shares ADD COLUMN days INTEGER').run(); } catch (e) {}
  // (file_key, days) 唯一索引：① 复制链接查询走索引不再全表扫 ② 同文件+同时长强制唯一，并发也不会重复生成
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_key_days ON shares(file_key, days)').run();
}

// ---------------- DPI 拦截识别 ----------------
// 运营商审查设备劫持回源链路时返回 405 + attack.jinxibei.com 攻击页，与 S3 真实错误截然不同
async function isDpiBlocked(r) {
  if (r.status !== 405) return false;
  try {
    const t = await r.clone().text();
    return t.includes('attack.jinxibei.com') || (t.includes('<html') && /saved from url/.test(t) && !t.includes('<?xml'));
  } catch { return false; }
}
const DPI_ERR = { error: '文件内容被运营商安全设备拦截（检测到脚本类特征），请将文件压缩成 zip 后重新上传' };

// ---------------- API handlers ----------------
async function handleInit(request, env) {
  const body = await request.json();
  const name = String(body.name || ''), size = Number(body.size || 0);
  if (!name || !Number.isFinite(size)) return json(400, { error: '参数错误' });
  if (size > MAX_FILE) return json(400, { error: '单文件超过20GB上限（中科云免费额度限制）' });
  const used = await accountUsage(env);
  if (used >= 0 && size + used > QUOTA) return json(400, { error: '中科云免费额度共20GB，本系统已用 ' + fmtG(used) + '，放不下此文件（' + fmtG(size) + '），请先删除旧文件' });
  const mime = guessMime(name, body.mime);
  // 秒传查重：同 SHA-256 直接复用已存在文件（校验 S3 上对象仍在，防删除后误判）
  const hash = String(body.hash || '');
  if (hash.length === 64 && env.DB) {
    try {
      await ensureDB(env);
      const dup = await env.DB.prepare('SELECT file_key, size FROM hashes WHERE hash=?').bind(hash).first();
      if (dup) {
        // 用 Range GET 校验对象存在（中科云对 HEAD 签名返回 401，Range GET 是下载代理已验证可行的路径）
        const head = await s3Fetch(env, 'GET', dup.file_key, {}, { extraHeaders: { range: 'bytes=0-0' } });
        if (head.status === 200 || head.status === 206) return json(200, { dup: true, key: dup.file_key, mode: 'dup', size: dup.size });
        await env.DB.prepare('DELETE FROM hashes WHERE hash=?').bind(hash).run(); // 对象已删，清理登记
      }
    } catch (e) {}
  }
  let chunkSize = CHUNK_SIZE;
  while (Math.ceil(size / chunkSize) > MAX_PARTS) chunkSize = Math.round(chunkSize * 1.5);
  const partCount = size === 0 ? 0 : Math.ceil(size / chunkSize);
  const mode = partCount <= 1 ? 'direct' : 'mpu';
  if (mode === 'mpu') {
    // 断点续传：复用上次会话（key+uploadId），分片边界由 size 决定，恒一致
    const resume = body.resume || {};
    if (resume.key && resume.uploadId && String(resume.key).startsWith('files/') && String(resume.key).length < 500) {
      return json(200, { key: String(resume.key), uploadId: String(resume.uploadId), chunkSize, partCount, mode });
    }
    const key = buildKey(name);
    const r = await s3Fetch(env, 'POST', key, { uploads: '' }, { contentType: mime });
    if (r.status !== 200) return json(502, { error: '中科云创建上传失败', detail: (await r.text()).slice(0, 200) });
    const t = await r.text();
    const uploadId = (t.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
    if (!uploadId) return json(502, { error: '中科云未返回uploadId' });
    return json(200, { key, uploadId, chunkSize, partCount, mode });
  }
  return json(200, { key: buildKey(name), mode, partCount, chunkSize });
}

async function handleDirect(request, env, url) {
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  const len = Number(request.headers.get('content-length') || '0');
  if (len > CHUNK_SIZE * 2) return json(413, { error: 'direct模式仅限小文件' });
  const mime = guessMime(key, request.headers.get('x-file-mime') || '');
  const r = await s3Fetch(env, 'PUT', key, {}, { body: request.body, contentLength: len, contentType: mime });
  if (r.status !== 200) {
    if (await isDpiBlocked(r)) return json(502, DPI_ERR);
    return json(502, { error: '上传失败', s3: r.status, detail: (await r.text()).slice(0, 200) });
  }
  const dHash = String(url.searchParams.get('hash') || '');
  try { await ensureDB(env); if (env.DB) { const ua = request.headers.get('user-agent') || ''; const { os, browser } = parseUA(ua); const ip = request.headers.get('CF-Connecting-IP') || ''; await env.DB.prepare('INSERT OR REPLACE INTO uploads (file_key, ip, os, browser, ua, upload_time) VALUES (?,?,?,?,?,?)').bind(key, ip, os, browser, ua, new Date().toISOString()).run(); if (dHash.length === 64) { const fn6=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); await env.DB.prepare('INSERT OR REPLACE INTO hashes (hash, file_key, size, file_name, hash_time) VALUES (?,?,?,?,?)').bind(dHash, key, len, fn6, new Date().toISOString()).run(); } } } catch {}
  try { const fn=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); const ua2=request.headers.get('user-agent')||''; const{os:os2,browser:br2}=parseUA(ua2); const ip2=request.headers.get('CF-Connecting-IP')||''; await env.DB.prepare('INSERT INTO logs (file_name, action, ip, os, browser, ua, log_time) VALUES (?,?,?,?,?,?,?)').bind(fn, 'upload', ip2, os2, br2, ua2, new Date().toISOString()).run(); } catch {}
  return json(200, { ok: true, key });
}

async function handlePart(request, env, url) {
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber') || '0');
  if (!key.startsWith('files/') || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return json(400, { error: '参数错误' });
  const len = Number(request.headers.get('content-length') || '0');
  if (len > 100 * 1024 * 1024) return json(413, { error: '分片超过100MB限制' });
  const r = await s3Fetch(env, 'PUT', key, { uploadId, partNumber }, { body: request.body, contentLength: len });
  const etag = r.headers.get('etag');
  if (r.status !== 200 || !etag) {
    if (r.status === 405 && await isDpiBlocked(r)) return json(502, DPI_ERR);
    return json(502, { error: '分片上传失败', s3: r.status, detail: (await r.text()).slice(0, 200) });
  }
  return json(200, { etag });
}

async function handleComplete(request, env) {
  const body = await request.json();
  const { key, uploadId, parts, mode } = body;
  const cHash = String(body.hash || ''); const cSize = Number(body.size || 0);
  if (!key || !String(key).startsWith('files/')) return json(400, { error: '非法key' });
  if (mode === 'direct') return json(200, { ok: true, key });
  if (!uploadId || !Array.isArray(parts) || parts.length === 0) return json(400, { error: '参数错误' });
  const xmlBody = '<CompleteMultipartUpload>' + parts.map(p => '<Part><PartNumber>' + Number(p[0]) + '</PartNumber><ETag>' + String(p[1]).replace(/"/g, '') + '</ETag></Part>').join('') + '</CompleteMultipartUpload>';
  const r = await s3Fetch(env, 'POST', key, { uploadId }, { body: xmlBody, contentType: 'application/xml', payloadHash: await sha256Hex(xmlBody) });
  const t = await r.text();
  if (r.status !== 200 || !/<CompleteMultipartUploadResult/.test(t) || /<Error>/.test(t)) return json(502, { error: '合并失败', s3: r.status, detail: t.slice(0, 250) });
  try { await ensureDB(env); if (env.DB) { const ua = request.headers.get('user-agent') || ''; const { os, browser } = parseUA(ua); const ip = request.headers.get('CF-Connecting-IP') || ''; if (cHash.length === 64) { const fn7=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); await env.DB.prepare('INSERT OR REPLACE INTO hashes (hash, file_key, size, file_name, hash_time) VALUES (?,?,?,?,?)').bind(cHash, key, cSize, fn7, new Date().toISOString()).run(); } } } catch {}
  try { const fn2=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); const ua3=request.headers.get('user-agent')||''; const{os:os3,browser:br3}=parseUA(ua3); const ip3=request.headers.get('CF-Connecting-IP')||''; await env.DB.prepare('INSERT INTO logs (file_name, action, ip, os, browser, ua, log_time) VALUES (?,?,?,?,?,?,?)').bind(fn2, 'upload', ip3, os3, br3, ua3, new Date().toISOString()).run(); } catch {}
  return json(200, { ok: true, key });
}

async function handleAbort(request, env) {
  const body = await request.json();
  const { key, uploadId } = body;
  if (!key || !uploadId) return json(400, { error: '参数错误' });
  const r = await s3Fetch(env, 'DELETE', key, { uploadId }, {});
  return json(200, { ok: true, status: r.status });
}

async function handleList(env, url) {
  const prefix = url.searchParams.get('prefix') || 'files/';
  let token = null, items = [], total = 0, pages = 0;
  do {
    const q = { 'list-type': '2', 'max-keys': '1000', prefix };
    if (token) q['continuation-token'] = token;
    const r = await s3Fetch(env, 'GET', '', q, {});
    if (r.status !== 200) return json(502, { error: '列取失败', s3: r.status, detail: (await r.text()).slice(0, 200) });
    const t = await r.text();
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const km = m[1].match(/<Key>([\s\S]*?)<\/Key>/);
      const sm = m[1].match(/<Size>(\d+)<\/Size>/);
      const lm = m[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/);
      if (km) {
        const key = xmlUnescape(km[1]);
        if (key.endsWith('/')) continue; // 目录占位对象
        const name = (key.split('/').pop() || '').replace(/^[0-9a-f]{8}-/, '');
        const size = Number(sm ? sm[1] : 0);
        items.push({ key, name, size, mtime: lm ? lm[1] : '' });
        total += size;
      }
    }
    token = (t.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null;
    pages++;
  } while (token && pages < 5);
  items.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  const used = await accountUsage(env);
  try { await ensureDB(env); if (env.DB && items.length) { const keys = items.map(i => i.key); const ph = keys.map(() => '?').join(','); const rows = await env.DB.prepare('SELECT file_key, ip, os, browser, upload_time FROM uploads WHERE file_key IN (' + ph + ')').bind(...keys).all(); const umap = {}; for (const r of rows.results) umap[r.file_key] = r; const dlCnt = await env.DB.prepare('SELECT file_key, COUNT(*) as c FROM downloads WHERE file_key IN (' + ph + ') GROUP BY file_key').bind(...keys).all(); const dcnt = {}; for (const r of dlCnt.results) dcnt[r.file_key] = r.c; for (const it of items) { const u = umap[it.key]; if (u) it.uploader = { ip: u.ip, os: u.os, browser: u.browser, time: u.upload_time }; it.dl_count = dcnt[it.key] || 0; } } } catch {}
  return json(200, { items: items.slice(0, 2000), total, count: items.length });
}

async function handleShare(env, url) {
  const key = url.searchParams.get('key') || '';
  const days = Number(url.searchParams.get('days') || '30');
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  let exp = 0;
  if (days > 0) exp = Math.floor(Date.now() / 1000) + days * 86400;
  // 短链用于所有时长的分享（含永久 days=0）；仅「下载」请求(dl=1)走 HMAC 长链，与前端 &dl=1 拼接兼容
  if (env.DB && url.searchParams.get('dl') !== '1') {
    await ensureDB(env);
    // 幂等复用：同文件+同时长固定一码。并发下若插入冲突(唯一索引)，回退读取已存在的那行，绝不丢短链
    let exist = await env.DB.prepare('SELECT code FROM shares WHERE file_key=? AND days=?').bind(key, days).first();
    let code = exist ? exist.code : null;
    if (!code) {
      code = await genShareCode(env);
      if (code) {
        try {
          await saveShare(env, code, key, exp, days);
        } catch (e) {
          // 唯一索引冲突：别的请求已先写入同一(file_key, days)，取它那行
          const dup = await env.DB.prepare('SELECT code FROM shares WHERE file_key=? AND days=?').bind(key, days).first();
          code = dup ? dup.code : null;
        }
      }
    }
    if (code) {
      const link = 'https://' + url.host + '/' + code;
      return json(200, { link, expire: exp, short: true });
    }
  }
  // 回退：无 D1 或生成失败时用 HMAC 限时签名长链
  const sig = await shareSig(env, key, exp);
  const keyPath = key.split('/').map(encodeURIComponent).join('/');
  const link = 'https://' + url.host + '/f/' + keyPath + '?e=' + exp + '&s=' + sig;
  return json(200, { link, expire: exp, short: false });
}

async function handleDelete(request, env, url) {
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  const r = await s3Fetch(env, 'DELETE', key, {}, {});
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) return json(502, { error: '删除失败', s3: r.status });
  try { await ensureDB(env); if (env.DB) { await env.DB.prepare('DELETE FROM uploads WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM downloads WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM shares WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM hashes WHERE file_key=?').bind(key).run(); } } catch {}
  try { const uaD=request.headers.get('user-agent')||''; const{os:osD,browser:brD}=parseUA(uaD); const ipD=request.headers.get('CF-Connecting-IP')||''; const fn4=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); await env.DB.prepare('INSERT INTO logs (file_name, action, ip, os, browser, ua, log_time) VALUES (?,?,?,?,?,?,?)').bind(fn4, 'delete', ipD, osD, brD, uaD, new Date().toISOString()).run(); } catch {}
  return json(200, { ok: true });
}

async function handleBatchDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) return json(400, { error: '未提供key列表' });
  let ok = 0, fail = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith('files/')) { fail++; continue; }
    const r = await s3Fetch(env, 'DELETE', key, {}, {});
    if (r.status === 204 || r.status === 200 || r.status === 404) {
      try { await ensureDB(env); if (env.DB) { await env.DB.prepare('DELETE FROM uploads WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM downloads WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM shares WHERE file_key=?').bind(key).run(); await env.DB.prepare('DELETE FROM hashes WHERE file_key=?').bind(key).run(); } } catch {}
      try { const uaD=request.headers.get('user-agent')||''; const{os:osD,browser:brD}=parseUA(uaD); const ipD=request.headers.get('CF-Connecting-IP')||''; const fn4=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); await env.DB.prepare('INSERT INTO logs (file_name, action, ip, os, browser, ua, log_time) VALUES (?,?,?,?,?,?,?)').bind(fn4, 'delete', ipD, osD, brD, uaD, new Date().toISOString()).run(); } catch {}
      ok++;
    } else { fail++; }
  }
  return json(200, { ok, fail, total: keys.length });
}

async function handleStats(env, url) {
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  await ensureDB(env);
  if (!env.DB) return json(200, { uploader: null, downloaders: [] });
  const up = await env.DB.prepare('SELECT ip, os, browser, ua, upload_time FROM uploads WHERE file_key=?').bind(key).first();
  const dlRows = await env.DB.prepare('SELECT ip, os, browser, COUNT(*) as times, MIN(dl_time) as first, MAX(dl_time) as last FROM downloads WHERE file_key=? GROUP BY ip, os, browser ORDER BY last DESC LIMIT 100').bind(key).all();
  return json(200, { uploader: up, downloaders: dlRows.results });
}

async function handleLog(env, url) {
  await ensureDB(env);
  if (!env.DB) return json(200, { items: [], total: 0 });
  const limit = Math.min(Number(url.searchParams.get('limit') || '10'), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || '0'), 0);
  const SORTABLE = ['id', 'file_name', 'action', 'ip', 'log_time'];
  const sp = url.searchParams.get('sort') || 'id';
  const sortCol = SORTABLE.includes(sp) ? sp : 'id';
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM logs').first();
  const rows = await env.DB.prepare('SELECT id, file_name, action, ip, os, browser, log_time FROM logs ORDER BY ' + sortCol + ' ' + dir + ', id ' + dir + ' LIMIT ? OFFSET ?').bind(limit, offset).all();
  return json(200, { items: rows.results, total: cnt ? cnt.c : 0 });
}

// ---------------- 短链分享 ----------------
const SHORT_RE = /^\/[A-Za-z0-9]{8}$/;
const SHORT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
async function genShareCode(env) {
  if (!env.DB) return null;
  for (let i = 0; i < 8; i++) {
    const b = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (const x of b) code += SHORT_CHARS[x % 62];
    const ex = await env.DB.prepare('SELECT 1 FROM shares WHERE code=?').bind(code).first();
    if (!ex) return code;
  }
  return null;
}
async function saveShare(env, code, key, exp, days) {
  await env.DB.prepare('INSERT OR REPLACE INTO shares (code, file_key, expire, days) VALUES (?,?,?,?)').bind(code, key, exp, days).run();
}
async function lookupShare(env, code) {
  const row = await env.DB.prepare('SELECT file_key, expire FROM shares WHERE code=?').bind(code).first();
  if (!row) return null;
  if (row.expire && row.expire < Math.floor(Date.now() / 1000)) {
    try { await env.DB.prepare('DELETE FROM shares WHERE code=?').bind(code).run(); } catch {}
    return null;
  }
  return row.file_key;
}

// ---------------- 分享下载代理 ----------------
async function handleDownload(request, env, url) {
  const keyPath = url.pathname.replace(/^\/f\//, '');
  const key = decodeKeyPath(keyPath.split('/'));
  if (!key.startsWith('files/')) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const e = Number(url.searchParams.get('e') || '0');
  const s = url.searchParams.get('s') || '';
  if (e !== 0 && e < Math.floor(Date.now() / 1000)) return new Response('链接已过期', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const expectSig = await shareSig(env, key, e);
  if (s !== expectSig) return new Response('无效链接', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return await serveFile(request, env, key, !!url.searchParams.get('dl'));
}
async function serveFile(request, env, key, dl) {
  const range = request.headers.get('range');
  const r = await s3Fetch(env, 'GET', key, {}, { extraHeaders: range ? { range } : undefined });
  if (r.status !== 200 && r.status !== 206) {
    return new Response(r.status === 404 ? '文件不存在或已删除' : '源站读取失败', { status: r.status === 404 ? 404 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const fileName = (key.split('/').pop() || 'file').replace(/^[0-9a-f]{8}-/, '');
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  const disposition = (INLINE_MIME.test(ct) && !dl) ? 'inline' : 'attachment';
  const h = new Headers();
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'accept-ranges', 'content-range']) {
    const v = r.headers.get(name); if (v != null) h.set(name, v);
  }
  h.set('content-disposition', disposition + "; filename*=UTF-8''" + encodeURIComponent(fileName));
  h.set('cache-control', 'no-store');
  try { await ensureDB(env); if (env.DB) { const ua = request.headers.get('user-agent') || ''; const { os, browser } = parseUA(ua); const ip = request.headers.get('CF-Connecting-IP') || ''; const ago = new Date(Date.now() - 60000).toISOString(); const exist = await env.DB.prepare('SELECT 1 FROM downloads WHERE file_key=? AND ip=? AND dl_time>?').bind(key, ip, ago).first(); if (!exist) { await env.DB.prepare('INSERT INTO downloads (file_key, ip, os, browser, ua, dl_time) VALUES (?,?,?,?,?,?)').bind(key, ip, os, browser, ua, new Date().toISOString()).run(); try { const fn3=(key.split('/').pop()||'').replace(/^[0-9a-f]{8}-/,''); await env.DB.prepare('INSERT INTO logs (file_name, action, ip, os, browser, ua, log_time) VALUES (?,?,?,?,?,?,?)').bind(fn3, 'download', ip, os, browser, ua, new Date().toISOString()).run(); } catch {} } } } catch {}
  return new Response(r.body, { status: r.status, headers: h });
}

// ---------------- 前端页面 ----------------
const HTML_PAGE = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>文件分发系统</title>\n<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22%232563eb%22 d=%22M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z%22/%3E%3Cpath fill=%22white%22 d=%22M13 2v7h7z%22/%3E%3C/svg%3E">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f0f2f5;color:#1f2329;min-height:100vh}\n.wrap{max-width:980px;margin:0 auto;padding:24px 16px}\nh1{font-size:22px;margin-bottom:4px}\n.sub{color:#6b7280;font-size:13px;margin-bottom:20px}\n.card{background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}\n.card h2{font-size:16px;margin-bottom:14px}\n.btn{display:inline-block;padding:8px 18px;border:none;border-radius:6px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}\n.btn:hover{background:#1d4ed8}\n.btn.ghost{background:#e5e7eb;color:#374151}.btn.ghost:hover{background:#d1d5db}\n.btn.danger{background:#dc2626}.btn.danger:hover{background:#b91c1c}\n.btn.small{padding:4px 10px;font-size:12px}\ninput[type=password]{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;width:100%}\n.drop{border:2px dashed #9ca3af;border-radius:10px;padding:36px;text-align:center;color:#6b7280;cursor:pointer;transition:all .15s}\n.drop.on{border-color:#2563eb;background:#eff6ff;color:#2563eb}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth{background:#f9fafb;text-align:left;padding:9px 8px;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap}\ntd{padding:9px 8px;border-bottom:1px solid #f3f4f6;vertical-align:middle}\ntr:hover td{background:#f9fafb}\n.fname{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.bar{height:14px;background:#e5e7eb;border-radius:7px;overflow:hidden;margin:8px 0}\n.bar>div{height:100%;background:#2563eb;border-radius:7px;transition:width .2s}\n.mono{font-family:Consolas,monospace;font-size:12px;word-break:break-all}\n.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}\n.up{margin-bottom:14px;padding:12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px}\n#loginBox{max-width:400px;margin:80px auto}\n.hide{display:none!important}\nselect{padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}\n.msg{padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:12px}\n.msg.ok{background:#ecfdf5;color:#065f46}.msg.err{background:#fef2f2;color:#991b1b}\n.tip{position:relative;cursor:help}\n.tip:hover .tip-bubble{display:block}\n.tip-bubble{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;line-height:1.6;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.2);margin-bottom:4px;text-align:left;max-height:320px;overflow-y:auto}\n.tip-bubble::after{content:\'\';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#1f2329}\n.tip-ico{font-size:15px}\n</style>\n</head>\n<body>\n<div id="loginBox" class="card">\n  <h2>登录文件分发系统</h2>\n  <div style="margin:12px 0"><input type="password" id="tk" placeholder="请输入管理口令" onkeydown="if(event.key===\'Enter\')doLogin()"></div>\n  <button class="btn" onclick="doLogin()">进入</button>\n  <div id="loginMsg" style="margin-top:10px"></div>\n</div>\n<div id="main" class="wrap hide">\n  <h1>文件分发系统</h1>\n  <div class="sub">分片直传中科云对象存储 · 免费额度20GB · 分享链接限时有效</div>\n  <div id="gmsg"></div>\n  <div class="card">\n    <h2>上传文件</h2>\n    <div class="drop" id="drop" onclick="document.getElementById(\'fi\').click()">点击选择 或 拖拽文件到此处<br><span style="font-size:12px">支持任意类型，超过5.1MB自动分片并发上传 · 大文件建议压缩成zip后上传</span></div>\n    <input type="file" id="fi" style="display:none" multiple>\n    <div id="ups"></div>\n  </div>\n  <div class="card">\n    <h2 class="row" style="justify-content:space-between">文件列表 <span><button class="btn small ghost" onclick="refresh()">刷新</button></span></h2>\n    <div style="margin-bottom:8px;color:#6b7280;font-size:12px" id="stat"></div>\n    <div>\n    <div id="batchBar" style="margin-bottom:8px;display:none"><label style="font-size:13px;cursor:pointer"><input type="checkbox" id="selAll"> 全选</label> <button class="btn small danger" id="delSel">批量删除选中</button> <span id="selCount" style="color:#6b7280;font-size:12px"></span></div>\n    <table id="tbl"><thead><tr><th style="width:36px"><input type="checkbox" id="selAll2" title="全选"></th><th>文件名</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody id="tb"></tbody></table>\n    </div>\n  </div>\n  <div class="card">\n    <h2 class="row" style="justify-content:space-between">使用记录 <span><button class="btn small ghost" onclick="loadLog(true)">刷新</button></span></h2>\n    <div style="overflow-x:auto">\n    <table id="logTbl"><thead><tr><th>序号</th><th id="th-file_name">文件名<span id="sa-file_name" style="color:#2563eb"></span></th><th id="th-action">动作<span id="sa-action" style="color:#2563eb"></span></th><th id="th-log_time">时间<span id="sa-log_time" style="color:#2563eb"></span></th><th id="th-ip">IP地址<span id="sa-ip" style="color:#2563eb"></span></th><th>设备</th></tr></thead><tbody id="logTb"></tbody></table>\n    </div>\n    <div style="text-align:center;margin-top:12px"><button class="btn small ghost" id="logMoreBtn" onclick="loadMoreLog()">加载更多</button></div>\n  </div>\n  <div class="sub" style="text-align:center;margin-top:8px"><a href="https://github.com/QingSiHuang/cfst-file" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none">GitHub</a> · Cloudflare Worker + 中科云S3</div>\n</div>\n<script>var TOKEN=localStorage.getItem("fh_token")||"";\nvar CONC=5,RETRY=3;\nfunction api(method,url,body,rawBody){var h={"x-auth-token":TOKEN};var opt={method:method,headers:h};if(body){h["content-type"]="application/json";opt.body=JSON.stringify(body);}if(rawBody){opt.body=rawBody;}return fetch(url,opt).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP"+r.status));return j;})});}\nfunction doLogin(){var v=document.getElementById("tk").value.trim();if(!v)return;fetch("/api/login",{method:"POST",headers:{"content-type":"application/json","x-auth-token":v},body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.ok){TOKEN=v;localStorage.setItem("fh_token",v);enter();}else{document.getElementById("loginMsg").innerHTML=\'<span style="color:#dc2626">口令错误</span>\';}}).catch(function(){document.getElementById("loginMsg").innerHTML=\'<span style="color:#dc2626">网络错误</span>\';});}\nfunction enter(){document.getElementById("loginBox").classList.add("hide");document.getElementById("main").classList.remove("hide");refresh();loadLog(true);}\nfunction fmtSize(n){if(n<1024)return n+"B";var u=["KB","MB","GB","TB"],i=-1;do{n/=1024;i++;}while(n>=1024&&i<3);return n.toFixed(n>=100?0:1)+u[i];}\nfunction fmtTime(s){if(!s)return "-";var d=new Date(s);if(isNaN(d))return s;var p=function(x){return (x<10?"0":"")+x;};return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());}\nfunction gmsg(t,ok){document.getElementById("gmsg").innerHTML=t?\'<div class="msg \'+(ok?"ok":"err")+\'">\'+t+"</div>":"";}\nfunction esc(s){var d={"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"};return String(s).replace(/[&<>"]/g,function(c){return d[c];});}\nfunction fmtEta(sec){sec=Math.round(sec||0);if(sec<=0)return"即将完成";if(sec<60)return sec+"秒";if(sec<3600)return Math.floor(sec/60)+"分"+(sec%60>0?sec%60+"秒":"");return Math.floor(sec/3600)+"时"+Math.floor(sec%3600/60)+"分";}\nvar queue=[],busy=0;\nfunction addFiles(files){for(var i=0;i<files.length;i++){var item={f:files[i],state:"wait",xhrs:[],cancelled:false};item.el=makeCard(item);document.getElementById("ups").prepend(item.el);queue.push(item);}refreshQueue();pump();}\nfunction makeCard(item){var div=document.createElement("div");div.className="up";var row=document.createElement("div");row.className="row";row.style.justifyContent="space-between";var b=document.createElement("b");b.textContent=item.f.name;b.title=item.f.name;b.className="fname";var right=document.createElement("span");right.className="row";var st=document.createElement("span");var btn2=document.createElement("button");btn2.className="btn small ghost";btn2.textContent="插队";btn2.onclick=function(){promoteItem(item);};btn2.style.display="none";var btn=document.createElement("button");btn.className="btn small danger";btn.textContent="取消";btn.onclick=function(){cancelItem(item);};right.appendChild(btn2);right.appendChild(st);right.appendChild(btn);row.appendChild(b);row.appendChild(right);var bar=document.createElement("div");bar.className="bar";bar.style.display="none";bar.innerHTML="<div></div>";var info=document.createElement("div");info.style.color="#6b7280";info.style.fontSize="12px";div.appendChild(row);div.appendChild(bar);div.appendChild(info);item.qTxt=st;item.bar=bar;item.barIn=bar.firstChild;item.info=info;item.btn2=btn2;return div;}\nfunction refreshQueue(){for(var i=0;i<queue.length;i++){var it=queue[i];if(it.state==="wait"){var ahead=0;for(var j=0;j<i;j++){if(queue[j].state==="wait")ahead++;}it.qTxt.textContent=ahead>0?("等待中（前面还有 "+ahead+" 个）"):"下一个待传";it.btn2.style.display="inline";it.bar.style.display="none";it.info.textContent="大小 "+fmtSize(it.f.size);}else if(it.state==="up"){it.qTxt.textContent="上传中…";it.btn2.style.display="none";}else{it.btn2.style.display="none";}}}\nfunction pump(){if(busy>0)return;var next=null;for(var i=0;i<queue.length;i++){if(queue[i].state==="wait"){next=queue[i];break;}}if(!next)return;busy=1;next.state="up";refreshQueue();startUpload(next);}\nfunction cancelItem(item){item.cancelled=true;var wasUp=item.state==="up";for(var i=0;i<item.xhrs.length;i++){try{item.xhrs[i].abort();}catch(_){}}if(wasUp&&item.uploadId&&item.key){try{fetch("/api/abort",{method:"POST",headers:{"content-type":"application/json","x-auth-token":TOKEN},body:JSON.stringify({key:item.key,uploadId:item.uploadId})});}catch(e){}}try{localStorage.removeItem(resumeKey(item.f));}catch(e){}item.qTxt.textContent="已取消";item.bar.style.display="none";item.info.textContent="该任务已中止，可重新选择文件重传";item.btn2.style.display="none";setTimeout(function(){var idx=queue.indexOf(item);if(idx>=0)queue.splice(idx,1);item.el.remove();if(wasUp){busy=0;refreshQueue();pump();}else{refreshQueue();}},1200);}\nfunction promoteItem(item){if(item.state!=="wait")return;var firstWait=-1;for(var i=0;i<queue.length;i++){if(queue[i].state==="wait"){firstWait=i;break;}}var idx=queue.indexOf(item);if(firstWait<0||idx===firstWait)return;queue.splice(idx,1);queue.splice(firstWait,0,item);refreshQueue();}\nfunction resumeKey(f){return "fh_up|"+f.name+"|"+f.size;}\nfunction xhrPut(url,blob,onProg){var x=new XMLHttpRequest();var p=new Promise(function(res,rej){x.open("PUT",url);x.setRequestHeader("x-auth-token",TOKEN);x.upload.onprogress=function(e){if(e.lengthComputable&&onProg)onProg(e.loaded,e.total);};x.onload=function(){var j=null;try{j=JSON.parse(x.responseText);}catch(_){j=null;}if(x.status>=200&&x.status<300&&j)res(j);else rej(new Error((j&&j.error)||("HTTP"+x.status)));};x.onerror=function(){rej(new Error("网络错误"));};x.send(blob);});p._x=x;return p;}\nfunction startUpload(item){var f=item.f,total=f.size,t0=Date.now();var doneMap={},curMap={},chunkSize=0,pc=0,key="",uploadId="",mode="",fileHash="";var prevT=Date.now(),sentB=0,v=null,timer=null,finished=false;\nfunction calcHash(){\nif(f.size>512*1048576){return Promise.resolve("");}\nreturn f.arrayBuffer().then(function(ab){return crypto.subtle.digest("SHA-256",ab);})\n.then(function(dg){return Array.from(new Uint8Array(dg)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");});}\nfunction show(){if(finished||item.cancelled)return;var bytes=0,kk;for(kk in doneMap)bytes+=Math.min(chunkSize||total,total-(Number(kk)-1)*(chunkSize||total));for(kk in curMap)bytes+=curMap[kk];var now=Date.now(),dt=(now-prevT)/1000;prevT=now;var inst=dt>0.2?(bytes-sentB)/dt:0;sentB=bytes;if(isFinite(inst)&&inst>0){v=(v==null)?inst:v*0.7+inst*0.3;}else if(v==null){v=0;}var pct=total?Math.min(100,(bytes/total)*95+((pc>0?Object.keys(doneMap).length/pc:1))*5):100;var eta=v>120?Math.round((total-bytes)/v):0;var pTxt=pc>0?("分片 "+Object.keys(doneMap).length+"/"+pc+" · "):"";item.qTxt.textContent=pTxt+fmtSize(bytes)+" / "+fmtSize(total);item.bar.style.display="";item.barIn.style.width=pct+"%";item.info.textContent="大小 "+fmtSize(total)+" · 速度 "+(v>120?fmtSize(Math.round(v))+"/s":"—")+" · 进度 "+pct.toFixed(0)+"% · 预计剩余 "+fmtEta(eta);}\ntimer=setInterval(show,500);\nfunction settle(){if(timer){clearInterval(timer);timer=null;}}\nvar rawSt=JSON.parse(localStorage.getItem(resumeKey(f))||"null");\nvar st=(rawSt&&rawSt.name===f.name&&rawSt.size===f.size&&rawSt.uploadId&&rawSt.done)?rawSt:null;\nif(st){chunkSize=st.chunkSize;doneMap=st.done||{};}\nshow();\ncalcHash().then(function(fh){fileHash=fh;return api("POST","/api/init",{name:f.name,size:f.size,mime:f.type||"",hash:fileHash,resume:st?{key:st.key,uploadId:st.uploadId}:null});}).then(function(res){if(item.cancelled)return;if(res.dup){settle();finished=true;key=res.key;item.state="done";item.qTxt.textContent="秒传成功 ✓";item.bar.style.display="none";item.info.textContent="大小 "+fmtSize(total)+"（服务器已有相同文件，免上传）";gmsg("【"+esc(f.name)+"】秒传成功（已存在相同内容文件）",true);refresh();return;}chunkSize=res.chunkSize;pc=res.partCount;key=res.key;uploadId=res.uploadId;mode=res.mode;item.uploadId=uploadId;item.key=key;if(!(st&&st.key===key&&st.uploadId===uploadId&&st.chunkSize===chunkSize)){doneMap={};}if(mode==="direct"){var attD=0;function tryDirect(){var xp=xhrPut("/api/direct?key="+encodeURIComponent(key)+"&hash="+encodeURIComponent(fileHash||""),f,function(loaded){curMap[0]=loaded;show();});item.xhrs.push(xp._x);return xp.then(function(j){if(j.error)throw new Error(j.error);settle();finished=true;localStorage.removeItem(resumeKey(f));item.state="done";item.qTxt.textContent="上传完成 ✓";item.bar.style.display="none";item.info.textContent="大小 "+fmtSize(total);gmsg("【"+esc(f.name)+"】上传成功",true);refresh();},function(e){if(item.cancelled)throw e;attD++;if(attD<3){item.info.textContent="网络波动，第"+attD+"次自动重试中…";return new Promise(function(res2){setTimeout(function(){res2(tryDirect());},800*attD);});}throw e;});}return tryDirect();}var todo=[];for(var n=1;n<=pc;n++){if(!doneMap[n])todo.push(n);}function save(){localStorage.setItem(resumeKey(f),JSON.stringify({name:f.name,size:f.size,key:key,uploadId:uploadId,chunkSize:chunkSize,done:doneMap}));}var active=0,stop=false,finishCb=null;function one(n){var off=(n-1)*chunkSize,blob=f.slice(off,Math.min(off+chunkSize,total));var att=0;function attempt(){var xp2=xhrPut("/api/part?key="+encodeURIComponent(key)+"&uploadId="+encodeURIComponent(uploadId)+"&partNumber="+n,blob,function(loaded){curMap[n]=loaded;show();});item.xhrs.push(xp2._x);return xp2.catch(function(e){if(item.cancelled)throw e;att++;if(att>RETRY)throw e;return attempt();});}return attempt().then(function(j){doneMap[n]=j.etag;delete curMap[n];sentB=0;prevT=Date.now();save();show();});}function runner(){while(active<CONC){var n2=todo.shift();if(n2===undefined)break;if(doneMap[n2])continue;active++;one(n2).then(next,fail);}}function fail(e){active--;stop=true;settle();if(finishCb)finishCb(e);}function next(){active--;runner();if(active===0&&todo.length===0&&!stop){var plist=[];for(var n3=1;n3<=pc;n3++){if(doneMap[n3])plist.push([n3,doneMap[n3]]);}if(plist.length<pc){stop=true;if(finishCb)finishCb(new Error("分片缺失"));return;}settle();finished=true;item.qTxt.textContent="正在合并分片…";item.bar.style.display="none";api("POST","/api/complete",{key:key,uploadId:uploadId,parts:plist,mode:mode,hash:fileHash,size:total}).then(function(){localStorage.removeItem(resumeKey(f));item.state="done";item.qTxt.textContent="上传完成 ✓";item.info.textContent="大小 "+fmtSize(total);gmsg("【"+esc(f.name)+"】上传成功",true);refresh();if(finishCb)finishCb(null);},function(e){gmsg("【"+esc(f.name)+"】合并失败："+esc(e.message||""),false);if(finishCb)finishCb(e);});}}return new Promise(function(res2,rej2){finishCb=function(e){finishCb=null;if(e)rej2(e);else res2();};runner();});}).then(function(){busy=0;refreshQueue();pump();},function(e){settle();if(!item.cancelled){item.state="fail";item.qTxt.textContent="上传失败";item.bar.style.display="none";item.info.textContent=(e&&e.message)||"未知错误";}busy=0;refreshQueue();pump();});}\nvar logOffset=0,logTotal=-1,logSortCol="id",logSortDir="desc";\nfunction sortBy(col){\n  if(logSortCol===col){logSortDir=logSortDir==="asc"?"desc":"asc";}\n  else{logSortCol=col;logSortDir="asc";}\n  updateSortArrows();loadLog(true);\n}\nfunction updateSortArrows(){\n  var cols=["file_name","action","log_time","ip"];\n  cols.forEach(function(c){\n    var el=document.getElementById("sa-"+c);\n    if(el){el.textContent=(logSortCol===c)?(logSortDir==="asc"?" ↑":" ↓"):"";}\n  });\n}\nfunction loadMoreLog(){loadLog(false);}\nfunction loadLog(reset){\n  if(reset){logOffset=0;logTotal=-1;}\n  api("GET","/api/log?offset="+logOffset+"&limit=10&sort="+logSortCol+"&dir="+logSortDir).then(function(j){\n    logTotal=j.total;\n    var tb=document.getElementById("logTb");\n    if(logOffset===0){tb.innerHTML="";}\n    j.items.forEach(function(r,idx){\n      var tr=document.createElement("tr");\n      var act=r.action==="upload"?"上传":(r.action==="download"?"下载":"删除");\n      var actColor=r.action==="delete"?"#dc2626":(r.action==="upload"?"#2563eb":"#059669");\n      tr.innerHTML="<td>"+(logOffset+idx+1)+"</td><td class=\'fname\' title=\'"+esc(r.file_name)+"\'>"+esc(r.file_name)+"</td><td style=\'color:"+actColor+";font-weight:600\'>"+act+"</td><td style=\'white-space:nowrap\'>"+fmtTime(r.log_time)+"</td><td>"+esc(r.ip)+"</td><td>"+esc(r.os)+" / "+esc(r.browser)+"</td>";\n      tb.appendChild(tr);\n    });\n    logOffset+=j.items.length;\n    var more=document.getElementById("logMoreBtn");\n    if(more){\n      if(logTotal>=0&&logOffset>=logTotal){more.textContent="已全部加载（共"+logTotal+"条）";more.disabled=true;}\n      else{more.textContent="加载更多";more.disabled=false;}\n    }\n  },function(e){gmsg("记录加载失败："+esc(e.message),false);});\n}\n(function(){\n  var cols=["file_name","action","log_time","ip"];\n  cols.forEach(function(c){\n    var th=document.getElementById("th-"+c);\n    if(th){th.style.cursor="pointer";th.onclick=function(){sortBy(c);};}\n  });\n})();\nfunction refresh(){api("GET","/api/list").then(function(j){document.getElementById("stat").textContent="共 "+j.count+" 个文件 · 额度统计中…";fetch("/api/usage",{headers:{"x-auth-token":TOKEN}}).then(function(r2){return r2.json()}).then(function(u){if(u&&u.used>=0)document.getElementById("stat").textContent="共 "+j.count+" 个文件 · 已用 "+fmtSize(u.used)+" / 20GB";});var tb=document.getElementById("tb");tb.innerHTML="";j.items.forEach(function(it){var tr=document.createElement("tr");var chk=document.createElement("input");chk.type="checkbox";chk.className="rowchk";chk.setAttribute("data-key",encodeURIComponent(it.key));var td0=document.createElement("td");td0.appendChild(chk);tr.appendChild(td0);tr.innerHTML+="<td class=\'fname\' title=\'"+esc(it.name)+"\'>"+esc(it.name)+"</td><td>"+fmtSize(it.size)+"</td><td style=\'white-space:nowrap\'>"+fmtTime(it.mtime)+"</td><td></td>";var op=tr.lastChild;op.className="row";var sel=document.createElement("select");sel.innerHTML=\'<option value="30">30天</option><option value="7">7天</option><option value="1">1天</option><option value="365">365天</option><option value="0">永久</option>\';var b1=document.createElement("button");b1.className="btn small ghost";b1.textContent="复制链接";b1.onclick=function(){var ck=it.key+"|"+sel.value;if(window.__shareCache&&window.__shareCache[ck]){var c=window.__shareCache[ck];navigator.clipboard.writeText(c).then(function(){gmsg("链接已复制（有效期"+sel.options[sel.selectedIndex].text+"）：<span class=\'mono\'>"+c+"</span>",true);},function(){gmsg("链接：<span class=\'mono\'>"+c+"</span>",true);});return;}api("GET","/api/share?key="+encodeURIComponent(it.key)+"&days="+sel.value).then(function(r){try{window.__shareCache=window.__shareCache||{};window.__shareCache[ck]=r.link;}catch(_){}navigator.clipboard.writeText(r.link).then(function(){gmsg("链接已复制（有效期"+sel.options[sel.selectedIndex].text+"）：<span class=\'mono\'>"+r.link+"</span>",true);},function(){gmsg("链接：<span class=\'mono\'>"+r.link+"</span>",true);});},function(e){gmsg("生成链接失败："+esc(e.message),false);});};var b2=document.createElement("button");b2.className="btn small ghost";b2.textContent="下载";b2.onclick=function(){api("GET","/api/share?key="+encodeURIComponent(it.key)+"&days=0&dl=1").then(function(r){location.href=r.link+"&dl=1";});};var b3=document.createElement("button");b3.className="btn small danger";b3.textContent="删除";b3.onclick=function(){if(!confirm("确定删除【"+it.name+"】？"))return;api("DELETE","/api/file?key="+encodeURIComponent(it.key)).then(function(){try{if(window.__shareCache){for(var k in window.__shareCache){if(k.indexOf(it.key+"|")===0)delete window.__shareCache[k];}}}catch(_){}gmsg("已删除："+esc(it.name),true);refresh();},function(e){gmsg("删除失败："+esc(e.message),false);});};op.appendChild(sel);op.appendChild(b1);op.appendChild(b2);op.appendChild(b3);tb.appendChild(tr);});syncBatchBar();},function(e){gmsg("列取失败："+esc(e.message),false);});}\nvar dz=document.getElementById("drop");\ndz.addEventListener("dragover",function(e){e.preventDefault();dz.classList.add("on");});\ndz.addEventListener("dragleave",function(){dz.classList.remove("on");});\ndz.addEventListener("drop",function(e){e.preventDefault();dz.classList.remove("on");addFiles(e.dataTransfer.files);});\ndocument.getElementById("fi").addEventListener("change",function(e){addFiles(e.target.files);e.target.value="";});\nif(TOKEN){fetch("/api/login",{method:"POST",headers:{"content-type":"application/json","x-auth-token":TOKEN},body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.ok)enter();}).catch(function(){});}function syncBatchBar(){var chks=document.querySelectorAll(".rowchk");var sel=document.querySelectorAll(".rowchk:checked");var bar=document.getElementById("batchBar");var cnt=document.getElementById("selCount");if(bar){if(chks.length>0){bar.style.display="block";}else{bar.style.display="none";}}if(cnt){if(sel.length>0){cnt.textContent="已选 "+sel.length+" 个";}else{cnt.textContent="";}}}\nfunction getSelKeys(){var arr=[];document.querySelectorAll(".rowchk:checked").forEach(function(c){arr.push(decodeURIComponent(c.getAttribute("data-key")));});return arr;}\n(function(){var sa=document.getElementById("selAll");var sa2=document.getElementById("selAll2");var del=document.getElementById("delSel");var tb=document.getElementById("tb");\nif(sa){sa.onchange=function(){document.querySelectorAll(".rowchk").forEach(function(c){c.checked=sa.checked;});syncBatchBar();};}\nif(sa2){sa2.onchange=function(){document.querySelectorAll(".rowchk").forEach(function(c){c.checked=sa2.checked;});if(sa){sa.checked=sa2.checked;}syncBatchBar();};}\nif(tb){tb.addEventListener("change",function(ev){if(ev.target&&ev.target.className==="rowchk"){var chks=document.querySelectorAll(".rowchk");var sel=document.querySelectorAll(".rowchk:checked");if(sa){sa.checked=chks.length>0&&sel.length===chks.length;}if(sa2){sa2.checked=chks.length>0&&sel.length===chks.length;}syncBatchBar();}});}\nif(del){del.onclick=function(){var keys=getSelKeys();if(keys.length===0){gmsg("请先勾选要删除的文件",false);return;}if(!confirm("确定批量删除选中的 "+keys.length+" 个文件？此操作不可恢复")){return;}gmsg("正在删除 "+keys.length+" 个文件…",true);api("POST","/api/batch-delete",{keys:keys}).then(function(j){if(j.fail===0){gmsg("已删除 "+j.ok+" 个文件",true);}else{gmsg("删除完成："+j.ok+" 成功 / "+j.fail+" 失败",false);}refresh();},function(e){gmsg("批量删除失败："+esc(e.message),false);refresh();});};}\n})();</script>\n</body>\n</html>';

// ---------------- 路由 ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/' || p === '/index.html') return new Response(HTML_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', 'pragma': 'no-cache', 'expires': '0' } });
      if (p === '/favicon.ico') return new Response(null, { status: 204 });
      if (p === '/api/login') {
        if (!env.ADMIN_TOKEN) return json(500, { error: '未配置ADMIN_TOKEN' });
        return json(200, { ok: request.headers.get('x-auth-token') === env.ADMIN_TOKEN });
      }
      if (p.startsWith('/f/')) return await handleDownload(request, env, url);
      if (SHORT_RE.test(p)) {
        await ensureDB(env);
        if (!env.DB) return json(404, { error: 'Not Found' });
        const key = await lookupShare(env, p.slice(1));
        if (!key) return new Response('链接不存在或已过期', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return await serveFile(request, env, key, false);
      }
      if (request.headers.get('x-auth-token') !== env.ADMIN_TOKEN) return json(401, { error: '未授权' });
      if (p === '/api/init' && request.method === 'POST') return await handleInit(request, env);
      if (p === '/api/direct' && request.method === 'PUT') return await handleDirect(request, env, url);
      if (p === '/api/part' && request.method === 'PUT') return await handlePart(request, env, url);
      if (p === '/api/complete' && request.method === 'POST') return await handleComplete(request, env);
      if (p === '/api/abort' && request.method === 'POST') return await handleAbort(request, env);
      if (p === '/api/list' && request.method === 'GET') return await handleList(env, url);
      if (p === '/api/usage' && request.method === 'GET') {
        const used = await accountUsage(env);
        return json(200, { used });
      }
      if (p === '/api/share' && request.method === 'GET') return await handleShare(env, url);
      if (p === '/api/stats' && request.method === 'GET') return await handleStats(env, url);
      if (p === '/api/log' && request.method === 'GET') return await handleLog(env, url);
      if (p === '/api/file' && request.method === 'DELETE') return await handleDelete(request, env, url);
      if (p === '/api/batch-delete' && request.method === 'POST') return await handleBatchDelete(request, env);
      return json(404, { error: 'Not Found' });
    } catch (e) {
      return json(500, { error: '服务异常', detail: String((e && e.message) || e).slice(0, 200) });
    }
  },
};
