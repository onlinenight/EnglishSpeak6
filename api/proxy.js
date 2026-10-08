// api/proxy.js - Vercel Serverless Function
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { path } = req.query;
  if (!path) { res.status(400).json({ error: '缺少 path 参数' }); return; }

  try {
    let targetUrl = '';
    let headers = {};
    let body = req.body;

    if (path === 'deepseek') {
      if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少环境变量 DEEPSEEK_API_KEY");
      targetUrl = 'https://api.deepseek.com/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` };
    } else if (path === 'baidu-token') {
      if (!process.env.BAIDU_API_KEY || !process.env.BAIDU_SECRET_KEY) throw new Error("缺少百度环境变量");
      targetUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${process.env.BAIDU_API_KEY}&client_secret=${process.env.BAIDU_SECRET_KEY}`;
      headers = { 'Content-Type': 'application/json' };
      body = undefined;
    } else if (path === 'baidu-asr') {
      const token = body.token;
      const cuid = body.cuid || 'speak6_user';
      targetUrl = `https://vop.baidu.com/server_api?token=${token}&cuid=${encodeURIComponent(cuid)}`;
      headers = { 'Content-Type': 'application/json' };
      delete body.token; delete body.cuid;
    } else if (path === 'baidu-tts') {
      // 百度语音合成
      if (!process.env.BAIDU_API_KEY || !process.env.BAIDU_SECRET_KEY) throw new Error("缺少百度环境变量");
      // 先获取 token
      const tokenRes = await fetch(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${process.env.BAIDU_API_KEY}&client_secret=${process.env.BAIDU_SECRET_KEY}`);
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error('获取百度token失败');
      
      const text = body.text || '';
      const per = body.per || 4189; // 度涵竹-开朗女声
      const spd = body.spd || 5;
      const pit = body.pit || 5;
      
      // 调用百度TTS
      const ttsUrl = `https://tsn.baidu.com/text2audio?tex=${encodeURIComponent(text)}&lan=en&per=${per}&spd=${spd}&pit=${pit}&aue=3&cuid=speak6_user&tok=${tokenData.access_token}`;
      const ttsRes = await fetch(ttsUrl);
      
      // 检查返回的是音频还是错误JSON
      const contentType = ttsRes.headers.get('content-type');
      if (contentType && contentType.includes('audio')) {
        // 返回音频流
        const audioBuffer = await ttsRes.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).send(Buffer.from(audioBuffer));
        return;
      } else {
        // 返回了错误JSON
        const errorData = await ttsRes.json();
        throw new Error('百度TTS错误: ' + JSON.stringify(errorData));
      }
    } else {
      res.status(404).json({ error: '未知的 path 参数' }); return;
    }

    // 非TTS路径走通用转发
    const response = await fetch(targetUrl, {
      method: req.method, headers: headers,
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
