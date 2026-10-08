const CONFIG = {
  proxyUrl: '/api/proxy',
  study: {
    accent: 'en-GB',
    level: 'LV2',
    dailyMinutes: 30,
    totalMonths: 6,
    startDate: '2026-10-08'
  },
  // 语音识别提供方：'baidu' 或 'browser'
  asrProvider: 'baidu',
  // 语音合成提供方：'baidu' 或 'browser'
  ttsProvider: 'baidu',
  // 百度TTS发音人：4189=度涵竹(英文女声)
  baiduTtsPer: 4189,
  // 百度ASR英语模型ID
  baiduAsrDevPid: 1737
};
