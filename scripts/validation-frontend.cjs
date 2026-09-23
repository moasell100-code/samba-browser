// Standalone loopback pairing page. No real JAJA account, token, or service.
const http = require('node:http')
const port = 18301
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>자자 브라우저 검증 연결</title>
<style>body{font:17px system-ui;background:#f4f6fb;color:#17243a;max-width:720px;margin:80px auto;padding:24px}main{background:white;padding:40px;border-radius:20px}b{color:#6747d7}h1{font-size:28px}p{line-height:1.8}#status{padding:16px;background:#edf3fd;border-radius:12px}</style>
<main><b>검증 전용 · 운영 미연결</b><h1>별도 검증 서버에 연결</h1><p>가상 소싱 계정 8개와 이 컴퓨터의 검증 DB만 사용합니다.<br>기존 자동발주와 확장앱, 운영 계정은 연결하지 않습니다.</p><p id="status">검증 브라우저의 연결 요청을 기다리고 있습니다.</p></main>
<script>
let hostId = '', pairing = false;
addEventListener('message', async e => {
  if(e.source !== window || e.origin !== location.origin || e.data?.source !== 'samba-extension') return;
  if(e.data.type === 'DEVICE_ID') hostId = e.data.deviceId;
  if(e.data.type !== 'API_KEY_STATUS' || !hostId || pairing) return;
  pairing = true;
  try {
    const response = await fetch('http://127.0.0.1:18300/__validation__/pair', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hostId})});
    const value = await response.json();
    if(!response.ok || value.syntheticOnly !== true || !/^[a-f0-9]{64}$/.test(value.apiKey)) throw Error();
    window.postMessage({source:'samba-page',type:'SAMBA_SET_API_KEY',apiKey:value.apiKey},location.origin);
    document.querySelector('#status').textContent = '검증 키를 브라우저에 전달했습니다. 소싱 계정 화면에서 연결 상태를 확인하세요.';
  } catch { pairing = false; document.querySelector('#status').textContent = '검증 서버 연결 실패. 검증용 실행기를 다시 실행하세요.'; }
});
</script></html>`
const server = http.createServer((req, res) => {
  if (!['localhost:18301', '127.0.0.1:18301'].includes(req.headers.host) || req.method !== 'GET') {
    res.writeHead(403)
    return res.end('Validation request rejected')
  }
  if (req.url === '/__validation__/status') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(
      JSON.stringify({ environment: 'jaja-browser-validation-frontend', syntheticOnly: true })
    )
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:18300; frame-ancestors 'none'"
  })
  res.end(html)
})
server.listen(port, '127.0.0.1', () => console.log('JAJA_VALIDATION_FRONTEND_READY'))
