// api/proxy.js - Vercel Serverless Function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { path } = req.query;

  if (!path) {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }

  try {
    let targetUrl = '';
    let headers = {};
    let body = req.body;

    if (path === 'deepseek') {
      if (!process.env.DEEPSEEK_API_KEY) {
        throw new Error("缺少环境变量 DEEPSEEK_API_KEY");
      }
      targetUrl = 'https://api.deepseek.com/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      };
    } else if (path === 'baidu-token') {
      if (!process.env.BAIDU_API_KEY || !process.env.BAIDU_SECRET_KEY) {
        throw new Error("缺少百度语音识别环境变量");
      }
      targetUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${process.env.BAIDU_API_KEY}&client_secret=${process.env.BAIDU_SECRET_KEY}`;
      headers = { 'Content-Type': 'application/json' };
      body = undefined;
    } else if (path === 'baidu-asr') {
      targetUrl = `https://vop.baidu.com/server_api?token=${process.env.BAIDU_ACCESS_TOKEN}`;
      headers = { 'Content-Type': 'application/json' };
    } else {
      res.status(404).json({ error: '未知的 path 参数' });
      return;
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.indexOf('application/json') === -1) {
       const text = await response.text();
       throw new Error(`上游 API 返回非 JSON 内容: ${text.substring(0, 100)}`);
    }

    const data = await response.json();
    res.status(200).json(data);

  } catch (error) {
    console.error('代理请求失败:', error);
    res.status(500).json({ error: '代理内部错误', message: error.message });
  }
}
