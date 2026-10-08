const CONFIG = {
  proxyUrl: '/api/proxy',
  study: {
    accent: 'en-GB',
    level: 'LV2',
    dailyMinutes: 30,
    totalMonths: 6,
    startDate: '2026-10-08'
  },
  // 核心修改：ASR 用回浏览器自带，避免百度 iOS 采样率报错
  asrProvider: 'browser', 
  ttsProvider: 'baidu', // 保留百度 TTS
  baiduTtsPer: 4189,    // 度涵竹（英文女声）
  baiduAsrDevPid: 1737
};
