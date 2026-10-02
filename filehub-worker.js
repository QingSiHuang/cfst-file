// =====================================================================
// filehub - 中科云 S3 文件分发系统 (Cloudflare Worker)
// 架构：浏览器 --分片--> Worker --SigV4签名转发--> s3.cstcloud.cn
//       下载：分享链接 -> Worker 代理(Range透传) -> 中科云
// 特性：8MB分片突破100MB限制 / 并发3 / 断点续传 / HMAC限时分享链接
// Secrets: S3_AK / S3_SK / S3_BUCKET / ADMIN_TOKEN / SHARE_SECRET
// Vars(可选): S3_ENDPOINT(默认s3.cstcloud.cn) / S3_REGION(默认cn-north-1)
// =====================================================================

const DEFAULT_ENDPOINT = 's3.cstcloud.cn';
const DEFAULT_REGION = 'cn-north-1';
const CHUNK_SIZE = 8 * 1024 * 1024;          // 8MB/片
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
  const payloadHash = opts.payloadHash || 'UNSIGNED-PAYLOAD';
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
  return String(name).replace(/[\r\n\t\0\\/]/g, '_').replace(/\.{2,}/g, '.').replace(/[<>:"|?*]/g, '_').slice(0, 180) || 'unnamed';
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
// ---------------- API handlers ----------------
async function handleInit(request, env) {
  const body = await request.json();
  const name = String(body.name || ''), size = Number(body.size || 0);
  if (!name || !Number.isFinite(size)) return json(400, { error: '参数错误' });
  if (size > MAX_FILE) return json(400, { error: '单文件超过20GB上限（中科云免费额度限制）' });
  const used = await accountUsage(env);
  if (used >= 0 && size + used > QUOTA) return json(400, { error: '中科云免费额度共20GB，本系统已用 ' + fmtG(used) + '，放不下此文件（' + fmtG(size) + '），请先删除旧文件' });
  const mime = guessMime(name, body.mime);
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
  if (r.status !== 200) return json(502, { error: '上传失败', s3: r.status, detail: (await r.text()).slice(0, 200) });

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
  if (r.status !== 200 || !etag) return json(502, { error: '分片上传失败', s3: r.status, detail: (await r.text()).slice(0, 200) });
  return json(200, { etag });
}

async function handleComplete(request, env) {
  const body = await request.json();
  const { key, uploadId, parts, mode } = body;
  if (!key || !String(key).startsWith('files/')) return json(400, { error: '非法key' });
  if (mode === 'direct') return json(200, { ok: true, key });
  if (!uploadId || !Array.isArray(parts) || parts.length === 0) return json(400, { error: '参数错误' });
  const xmlBody = '<CompleteMultipartUpload>' + parts.map(p => '<Part><PartNumber>' + Number(p[0]) + '</PartNumber><ETag>' + String(p[1]).replace(/"/g, '') + '</ETag></Part>').join('') + '</CompleteMultipartUpload>';
  const r = await s3Fetch(env, 'POST', key, { uploadId }, { body: xmlBody, contentType: 'application/xml', payloadHash: await sha256Hex(xmlBody) });
  const t = await r.text();
  if (r.status !== 200 || !/<CompleteMultipartUploadResult/.test(t) || /<Error>/.test(t)) return json(502, { error: '合并失败', s3: r.status, detail: t.slice(0, 250) });

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
  return json(200, { items: items.slice(0, 2000), total, count: items.length });
}

async function handleShare(env, url) {
  const key = url.searchParams.get('key') || '';
  const days = Number(url.searchParams.get('days') || '30');
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  let exp = 0;
  if (days > 0) exp = Math.floor(Date.now() / 1000) + days * 86400;
  const sig = await shareSig(env, key, exp);
  const keyPath = key.split('/').map(encodeURIComponent).join('/');
  const link = 'https://' + url.host + '/f/' + keyPath + '?e=' + exp + '&s=' + sig;
  return json(200, { link, expire: exp });
}

async function handleDelete(env, url) {
  const key = url.searchParams.get('key') || '';
  if (!key.startsWith('files/')) return json(400, { error: '非法key' });
  const r = await s3Fetch(env, 'DELETE', key, {}, {});
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) return json(502, { error: '删除失败', s3: r.status });

  return json(200, { ok: true });
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
  const range = request.headers.get('range');
  const r = await s3Fetch(env, 'GET', key, {}, { extraHeaders: range ? { range } : undefined });
  if (r.status !== 200 && r.status !== 206) {
    return new Response(r.status === 404 ? '文件不存在或已删除' : '源站读取失败', { status: r.status === 404 ? 404 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const fileName = (key.split('/').pop() || 'file').replace(/^[0-9a-f]{8}-/, '');
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  const disposition = (INLINE_MIME.test(ct) && !url.searchParams.get('dl')) ? 'inline' : 'attachment';
  const h = new Headers();
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'accept-ranges', 'content-range']) {
    const v = r.headers.get(name); if (v != null) h.set(name, v);
  }
  h.set('content-disposition', disposition + "; filename*=UTF-8''" + encodeURIComponent(fileName));
  h.set('cache-control', 'no-store');
  return new Response(r.body, { status: r.status, headers: h });
}

// ---------------- 前端页面 ----------------
const HTML_PAGE = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>文件分发系统</title>\n<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22%232563eb%22 d=%22M13 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z%22/%3E%3Cpath fill=%22white%22 d=%22M13 2v7h7z%22/%3E%3C/svg%3E">\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:#f0f2f5;color:#1f2329;min-height:100vh}\n.wrap{max-width:980px;margin:0 auto;padding:24px 16px}\nh1{font-size:22px;margin-bottom:4px}\n.sub{color:#6b7280;font-size:13px;margin-bottom:20px}\n.card{background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}\n.card h2{font-size:16px;margin-bottom:14px}\n.btn{display:inline-block;padding:8px 18px;border:none;border-radius:6px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}\n.btn:hover{background:#1d4ed8}\n.btn.ghost{background:#e5e7eb;color:#374151}.btn.ghost:hover{background:#d1d5db}\n.btn.danger{background:#dc2626}.btn.danger:hover{background:#b91c1c}\n.btn.small{padding:4px 10px;font-size:12px}\ninput[type=password]{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;width:100%}\n.drop{border:2px dashed #9ca3af;border-radius:10px;padding:36px;text-align:center;color:#6b7280;cursor:pointer;transition:all .15s}\n.drop.on{border-color:#2563eb;background:#eff6ff;color:#2563eb}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth{background:#f9fafb;text-align:left;padding:9px 8px;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap}\ntd{padding:9px 8px;border-bottom:1px solid #f3f4f6;vertical-align:middle}\ntr:hover td{background:#f9fafb}\n.fname{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.bar{height:14px;background:#e5e7eb;border-radius:7px;overflow:hidden;margin:8px 0}\n.bar>div{height:100%;background:#2563eb;border-radius:7px;transition:width .2s}\n.mono{font-family:Consolas,monospace;font-size:12px;word-break:break-all}\n.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}\n.up{margin-bottom:14px;padding:12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px}\n#loginBox{max-width:400px;margin:80px auto}\n.hide{display:none!important}\nselect{padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}\n.msg{padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:12px}\n.msg.ok{background:#ecfdf5;color:#065f46}.msg.err{background:#fef2f2;color:#991b1b}\n</style>\n</head>\n<body>\n<div id="loginBox" class="card">\n  <h2>登录文件分发系统</h2>\n  <div style="margin:12px 0"><input type="password" id="tk" placeholder="请输入管理口令" onkeydown="if(event.key===\'Enter\')doLogin()"></div>\n  <button class="btn" onclick="doLogin()">进入</button>\n  <div id="loginMsg" style="margin-top:10px"></div>\n</div>\n<div id="main" class="wrap hide">\n  <h1>文件分发系统</h1>\n  <div class="sub">分片直传中科云对象存储 · 免费额度20GB · 分享链接限时有效</div>\n  <div id="gmsg"></div>\n  <div class="card">\n    <h2>上传文件</h2>\n    <div class="drop" id="drop" onclick="document.getElementById(\'fi\').click()">点击选择 或 拖拽文件到此处<br><span style="font-size:12px">支持任意类型，超过8MB自动分片并发上传</span></div>\n    <input type="file" id="fi" style="display:none" multiple>\n    <div id="ups"></div>\n  </div>\n  <div class="card">\n    <h2 class="row" style="justify-content:space-between">文件列表 <span><button class="btn small ghost" onclick="refresh()">刷新</button></span></h2>\n    <div style="margin-bottom:8px;color:#6b7280;font-size:12px" id="stat"></div>\n    <div style="overflow-x:auto">\n    <table id="tbl"><thead><tr><th>文件名</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody id="tb"></tbody></table>\n    </div>\n  </div>\n  <div class="sub" style="text-align:center;margin-top:8px">GitHub · Cloudflare Worker + 中科云S3</div>\n</div>\n<script>var TOKEN=localStorage.getItem("fh_token")||"";\nvar CONC=3,RETRY=2;\nfunction api(method,url,body,rawBody){var h={"x-auth-token":TOKEN};var opt={method:method,headers:h};if(body){h["content-type"]="application/json";opt.body=JSON.stringify(body);}if(rawBody){opt.body=rawBody;}return fetch(url,opt).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP"+r.status));return j;})});}\nfunction doLogin(){var v=document.getElementById("tk").value.trim();if(!v)return;fetch("/api/login",{method:"POST",headers:{"content-type":"application/json","x-auth-token":v},body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.ok){TOKEN=v;localStorage.setItem("fh_token",v);enter();}else{document.getElementById("loginMsg").innerHTML=\'<span style="color:#dc2626">口令错误</span>\';}}).catch(function(){document.getElementById("loginMsg").innerHTML=\'<span style="color:#dc2626">网络错误</span>\';});}\nfunction enter(){document.getElementById("loginBox").classList.add("hide");document.getElementById("main").classList.remove("hide");refresh();}\nfunction fmtSize(n){if(n<1024)return n+"B";var u=["KB","MB","GB","TB"],i=-1;do{n/=1024;i++;}while(n>=1024&&i<3);return n.toFixed(n>=100?0:1)+u[i];}\nfunction fmtTime(s){return s?s.replace("T"," ").replace(/\\.[0-9]+Z/,""):"-";}\nfunction gmsg(t,ok){document.getElementById("gmsg").innerHTML=t?\'<div class="msg \'+(ok?"ok":"err")+\'">\'+t+"</div>":"";}\nfunction esc(s){var d={"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"};return String(s).replace(/[&<>"]/g,function(c){return d[c];});}\nfunction fmtEta(sec){sec=Math.round(sec||0);if(sec<=0)return"即将完成";if(sec<60)return sec+"秒";if(sec<3600)return Math.floor(sec/60)+"分"+(sec%60>0?sec%60+"秒":"");return Math.floor(sec/3600)+"时"+Math.floor(sec%3600/60)+"分";}\nvar queue=[],busy=0;\nfunction addFiles(files){for(var i=0;i<files.length;i++){var item={f:files[i],state:"wait",xhrs:[],cancelled:false};item.el=makeCard(item);document.getElementById("ups").prepend(item.el);queue.push(item);}refreshQueue();pump();}\nfunction makeCard(item){var div=document.createElement("div");div.className="up";var row=document.createElement("div");row.className="row";row.style.justifyContent="space-between";var b=document.createElement("b");b.textContent=item.f.name;b.title=item.f.name;b.className="fname";var right=document.createElement("span");right.className="row";var st=document.createElement("span");var btn2=document.createElement("button");btn2.className="btn small ghost";btn2.textContent="插队";btn2.onclick=function(){promoteItem(item);};btn2.style.display="none";var btn=document.createElement("button");btn.className="btn small danger";btn.textContent="取消";btn.onclick=function(){cancelItem(item);};right.appendChild(btn2);right.appendChild(st);right.appendChild(btn);row.appendChild(b);row.appendChild(right);var bar=document.createElement("div");bar.className="bar";bar.style.display="none";bar.innerHTML="<div></div>";var info=document.createElement("div");info.style.color="#6b7280";info.style.fontSize="12px";div.appendChild(row);div.appendChild(bar);div.appendChild(info);item.qTxt=st;item.bar=bar;item.barIn=bar.firstChild;item.info=info;item.btn2=btn2;return div;}\nfunction refreshQueue(){for(var i=0;i<queue.length;i++){var it=queue[i];if(it.state==="wait"){var ahead=0;for(var j=0;j<i;j++){if(queue[j].state==="wait")ahead++;}it.qTxt.textContent=ahead>0?("等待中（前面还有 "+ahead+" 个）"):"下一个待传";it.btn2.style.display="inline";it.bar.style.display="none";it.info.textContent="大小 "+fmtSize(it.f.size);}else if(it.state==="up"){it.qTxt.textContent="上传中…";it.btn2.style.display="none";}else{it.btn2.style.display="none";}}}\nfunction pump(){if(busy>0)return;var next=null;for(var i=0;i<queue.length;i++){if(queue[i].state==="wait"){next=queue[i];break;}}if(!next)return;busy=1;next.state="up";refreshQueue();startUpload(next);}\nfunction cancelItem(item){item.cancelled=true;var wasUp=item.state==="up";for(var i=0;i<item.xhrs.length;i++){try{item.xhrs[i].abort();}catch(_){}}if(wasUp&&item.uploadId&&item.key){try{fetch("/api/abort",{method:"POST",headers:{"content-type":"application/json","x-auth-token":TOKEN},body:JSON.stringify({key:item.key,uploadId:item.uploadId})});}catch(e){}}try{localStorage.removeItem(resumeKey(item.f));}catch(e){}item.qTxt.textContent="已取消";item.bar.style.display="none";item.info.textContent="该任务已中止，可重新选择文件重传";item.btn2.style.display="none";setTimeout(function(){var idx=queue.indexOf(item);if(idx>=0)queue.splice(idx,1);item.el.remove();if(wasUp){busy=0;refreshQueue();pump();}else{refreshQueue();}},1200);}\nfunction promoteItem(item){if(item.state!=="wait")return;var firstWait=-1;for(var i=0;i<queue.length;i++){if(queue[i].state==="wait"){firstWait=i;break;}}var idx=queue.indexOf(item);if(firstWait<0||idx===firstWait)return;queue.splice(idx,1);queue.splice(firstWait,0,item);refreshQueue();}\nfunction resumeKey(f){return "fh_up|"+f.name+"|"+f.size;}\nfunction xhrPut(url,blob,onProg){var x=new XMLHttpRequest();var p=new Promise(function(res,rej){x.open("PUT",url);x.setRequestHeader("x-auth-token",TOKEN);x.upload.onprogress=function(e){if(e.lengthComputable&&onProg)onProg(e.loaded,e.total);};x.onload=function(){var j=null;try{j=JSON.parse(x.responseText);}catch(_){j=null;}if(x.status>=200&&x.status<300&&j)res(j);else rej(new Error((j&&j.error)||("HTTP"+x.status)));};x.onerror=function(){rej(new Error("网络错误"));};x.send(blob);});p._x=x;return p;}\nfunction startUpload(item){var f=item.f,total=f.size,t0=Date.now();var doneMap={},curMap={},chunkSize=0,pc=0,key="",uploadId="",mode="";var prevT=Date.now(),sentB=0,v=null,timer=null,finished=false;\nfunction show(){if(finished||item.cancelled)return;var bytes=0,kk;for(kk in doneMap)bytes+=Math.min(chunkSize||total,total-(Number(kk)-1)*(chunkSize||total));for(kk in curMap)bytes+=curMap[kk];var now=Date.now(),dt=(now-prevT)/1000;prevT=now;var inst=dt>0.2?(bytes-sentB)/dt:0;sentB=bytes;if(isFinite(inst)&&inst>0){v=(v==null)?inst:v*0.7+inst*0.3;}else if(v==null){v=0;}var pct=total?Math.min(100,bytes/total*100):100;var eta=v>120?Math.round((total-bytes)/v):0;var pTxt=pc>0?("分片 "+Object.keys(doneMap).length+"/"+pc+" · "):"";item.qTxt.textContent=pTxt+fmtSize(bytes)+" / "+fmtSize(total);item.bar.style.display="";item.barIn.style.width=pct+"%";item.info.textContent="大小 "+fmtSize(total)+" · 速度 "+(v>120?fmtSize(Math.round(v))+"/s":"—")+" · 进度 "+pct.toFixed(0)+"% · 预计剩余 "+fmtEta(eta);}\ntimer=setInterval(show,500);\nfunction settle(){if(timer){clearInterval(timer);timer=null;}}\nvar rawSt=JSON.parse(localStorage.getItem(resumeKey(f))||"null");\nvar st=(rawSt&&rawSt.name===f.name&&rawSt.size===f.size&&rawSt.uploadId&&rawSt.done)?rawSt:null;\nif(st){chunkSize=st.chunkSize;doneMap=st.done||{};}\nshow();\napi("POST","/api/init",{name:f.name,size:f.size,mime:f.type||"",resume:st?{key:st.key,uploadId:st.uploadId}:null}).then(function(res){if(item.cancelled)return;chunkSize=res.chunkSize;pc=res.partCount;key=res.key;uploadId=res.uploadId;mode=res.mode;item.uploadId=uploadId;item.key=key;if(!(st&&st.key===key&&st.uploadId===uploadId&&st.chunkSize===chunkSize)){doneMap={};}if(mode==="direct"){var xp=xhrPut("/api/direct?key="+encodeURIComponent(key),f,function(loaded){curMap[0]=loaded;show();});item.xhrs.push(xp._x);return xp.then(function(j){if(j.error)throw new Error(j.error);settle();finished=true;localStorage.removeItem(resumeKey(f));item.state="done";item.qTxt.textContent="上传完成 ✓";item.bar.style.display="none";item.info.textContent="大小 "+fmtSize(total);gmsg("【"+esc(f.name)+"】上传成功",true);refresh();},function(e){throw e;});}var todo=[];for(var n=1;n<=pc;n++){if(!doneMap[n])todo.push(n);}function save(){localStorage.setItem(resumeKey(f),JSON.stringify({name:f.name,size:f.size,key:key,uploadId:uploadId,chunkSize:chunkSize,done:doneMap}));}var active=0,stop=false,finishCb=null;function one(n){var off=(n-1)*chunkSize,blob=f.slice(off,Math.min(off+chunkSize,total));var att=0;function attempt(){var xp2=xhrPut("/api/part?key="+encodeURIComponent(key)+"&uploadId="+encodeURIComponent(uploadId)+"&partNumber="+n,blob,function(loaded){curMap[n]=loaded;show();});item.xhrs.push(xp2._x);return xp2.catch(function(e){if(item.cancelled)throw e;att++;if(att>RETRY)throw e;return attempt();});}return attempt().then(function(j){doneMap[n]=j.etag;delete curMap[n];sentB=0;prevT=Date.now();save();show();});}function runner(){while(active<CONC){var n2=todo.shift();if(n2===undefined)break;if(doneMap[n2])continue;active++;one(n2).then(next,fail);}}function fail(e){active--;stop=true;settle();if(finishCb)finishCb(e);}function next(){active--;runner();if(active===0&&todo.length===0&&!stop){var plist=[];for(var n3=1;n3<=pc;n3++){if(doneMap[n3])plist.push([n3,doneMap[n3]]);}if(plist.length<pc){stop=true;if(finishCb)finishCb(new Error("分片缺失"));return;}settle();finished=true;item.qTxt.textContent="正在合并分片…";item.bar.style.display="none";api("POST","/api/complete",{key:key,uploadId:uploadId,parts:plist,mode:mode}).then(function(){localStorage.removeItem(resumeKey(f));item.state="done";item.qTxt.textContent="上传完成 ✓";item.info.textContent="大小 "+fmtSize(total);gmsg("【"+esc(f.name)+"】上传成功",true);refresh();if(finishCb)finishCb(null);},function(e){gmsg("【"+esc(f.name)+"】合并失败："+esc(e.message||""),false);if(finishCb)finishCb(e);});}}return new Promise(function(res2,rej2){finishCb=function(e){finishCb=null;if(e)rej2(e);else res2();};runner();});}).then(function(){busy=0;refreshQueue();pump();},function(e){settle();if(!item.cancelled){item.state="fail";item.qTxt.textContent="上传失败";item.bar.style.display="none";item.info.textContent=(e&&e.message)||"未知错误";}busy=0;refreshQueue();pump();});}\nfunction refresh(){api("GET","/api/list").then(function(j){document.getElementById("stat").textContent="共 "+j.count+" 个文件 · 额度统计中…";fetch("/api/usage",{headers:{"x-auth-token":TOKEN}}).then(function(r2){return r2.json()}).then(function(u){if(u&&u.used>=0)document.getElementById("stat").textContent="共 "+j.count+" 个文件 · 已用 "+fmtSize(u.used)+" / 20GB";});var tb=document.getElementById("tb");tb.innerHTML="";j.items.forEach(function(it){var tr=document.createElement("tr");tr.innerHTML="<td class=\'fname\' title=\'"+esc(it.name)+"\'>"+esc(it.name)+"</td><td>"+fmtSize(it.size)+"</td><td style=\'white-space:nowrap\'>"+fmtTime(it.mtime)+"</td><td></td>";var op=tr.lastChild;op.className="row";var sel=document.createElement("select");sel.innerHTML=\'<option value="30">30天</option><option value="7">7天</option><option value="1">1天</option><option value="365">365天</option><option value="0">永久</option>\';var b1=document.createElement("button");b1.className="btn small ghost";b1.textContent="复制链接";b1.onclick=function(){api("GET","/api/share?key="+encodeURIComponent(it.key)+"&days="+sel.value).then(function(r){navigator.clipboard.writeText(r.link).then(function(){gmsg("链接已复制（有效期"+sel.options[sel.selectedIndex].text+"）：<span class=\'mono\'>"+r.link+"</span>",true);},function(){gmsg("链接：<span class=\'mono\'>"+r.link+"</span>",true);});},function(e){gmsg("生成链接失败："+esc(e.message),false);});};var b2=document.createElement("button");b2.className="btn small ghost";b2.textContent="下载";b2.onclick=function(){api("GET","/api/share?key="+encodeURIComponent(it.key)+"&days=0").then(function(r){location.href=r.link+"&dl=1";});};var b3=document.createElement("button");b3.className="btn small danger";b3.textContent="删除";b3.onclick=function(){if(!confirm("确定删除【"+it.name+"】？"))return;api("DELETE","/api/file?key="+encodeURIComponent(it.key)).then(function(){gmsg("已删除："+esc(it.name),true);refresh();},function(e){gmsg("删除失败："+esc(e.message),false);});};op.appendChild(sel);op.appendChild(b1);op.appendChild(b2);op.appendChild(b3);tb.appendChild(tr);});},function(e){gmsg("列取失败："+esc(e.message),false);});}\nvar dz=document.getElementById("drop");\ndz.addEventListener("dragover",function(e){e.preventDefault();dz.classList.add("on");});\ndz.addEventListener("dragleave",function(){dz.classList.remove("on");});\ndz.addEventListener("drop",function(e){e.preventDefault();dz.classList.remove("on");addFiles(e.dataTransfer.files);});\ndocument.getElementById("fi").addEventListener("change",function(e){addFiles(e.target.files);e.target.value="";});\nif(TOKEN){fetch("/api/login",{method:"POST",headers:{"content-type":"application/json","x-auth-token":TOKEN},body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.ok)enter();}).catch(function(){});}</script>\n</body>\n</html>';

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
      if (p === '/api/file' && request.method === 'DELETE') return await handleDelete(env, url);
      return json(404, { error: 'Not Found' });
    } catch (e) {
      return json(500, { error: '服务异常', detail: String((e && e.message) || e).slice(0, 200) });
    }
  },
};
