// ============================================
// config.js - 前端配置
// ============================================

const CONFIG = {
  // 通过 Vercel Serverless Function 代理，解决 CORS
  proxyUrl: '/api/proxy',

  // 学习设置
  study: {
    accent: 'en-GB',         // 英音
    level: 'LV2',            // 流利说 LV2
    dailyMinutes: 30,
    totalMonths: 6,
    startDate: '2026-10-08'  // 你的开始日期
  }
};