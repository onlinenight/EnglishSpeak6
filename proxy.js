// api/proxy.js - Vercel Serverless Function

export default async function handler(req, res) {
  // 统一设置CORS响应头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 处理浏览器的预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 从查询参数中获取目标API的路径
  const { path } = req.query;

  if (!path) {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }

  try {
    let targetUrl = '';
    let headers = {};
    let body = req.body;

    // 路由到不同的目标API
    if (path === 'deepseek') {
      targetUrl = 'https://api.deepseek.com/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      };
    } else if (path === 'baidu-token') {
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

    // 转发请求
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(body) : undefined
    });

    const data = await response.json();
    res.status(200).json(data);

  } catch (error) {
    console.error('代理请求失败:', error);
    res.status(500).json({ error: '内部服务器错误', message: error.message });
  }
}