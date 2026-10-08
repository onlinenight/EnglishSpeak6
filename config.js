const CONFIG = {
  proxyUrl: '/api/proxy',
  study: {
    accent: 'en-GB',
    level: 'LV2',
    dailyMinutes: 30,
    totalMonths: 6,
    startDate: '2026-10-08'
  },
  // 改回百度语音识别，彻底解决电脑端 network 报错，同时兼容手机
  asrProvider: 'baidu', 
  ttsProvider: 'baidu',
  baiduTtsPer: 4189,
  baiduAsrDevPid: 1737
};
