const CONFIG = {
  proxyUrl: '/api/proxy',
  study: {
    accent: 'en-GB',
    level: 'LV2',
    dailyMinutes: 30,
    totalMonths: 6,
    startDate: '2026-10-08'
  },
  // 改回浏览器原生识别，彻底解决音频格式报错
  asrProvider: 'browser',
  // 保留百度 TTS（声音好听，无需麦克风）
  ttsProvider: 'baidu',
  baiduTtsPer: 4189
};
