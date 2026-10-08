// ============================================
// app.js - 核心逻辑（纯动态 + 点击录音 + 悬浮按钮 + Toast）
// ============================================

function today() { return new Date().toISOString().slice(0, 10); }

function getStudyDay() {
  const start = new Date(CONFIG.study.startDate);
  const now = new Date();
  const diff = Math.floor((now - start) / 86400000) + 1;
  return Math.max(1, Math.min(180, diff));
}

function loadState() {
  const s = localStorage.getItem('speak6_state');
  if (s) return JSON.parse(s);
  return { completedDays: [], xp: 0, streak: 0, lastDate: null, currentDay: 1, reviewData: [], chatHistory: [] };
}

function saveState(state) { localStorage.setItem('speak6_state', JSON.stringify(state)); }
let STATE = loadState();

function getDayInfo(dayNum) {
  let count = 0;
  for (const m of CURRICULUM.months) {
    for (const w of m.weeks) {
      for (const d of w.days) {
        count++;
        if (count === dayNum) return { month: m, week: w, day: d, dayNum };
      }
    }
  }
  return null;
}

// ---------- Toast 轻提示 ----------
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ---------- 视图切换 ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(item.dataset.view).classList.add('active');
    
    // 控制悬浮录音按钮的显示
    const fab = document.getElementById('fabRecord');
    if (item.dataset.view === 'view-chat') {
      fab.style.display = 'flex';
    } else {
      fab.style.display = 'none';
    }
    
    if (item.dataset.view === 'view-history') renderHistory();
  });
});

// ---------- 录音逻辑（点击开始/结束） ----------
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioContext = null;
let scriptProcessor = null;
let mediaStream = null;

async function startRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  audioChunks = [];
  scriptProcessor.onaudioprocess = (e) => { audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
}

function stopRecording() {
  return new Promise((resolve) => {
    try { scriptProcessor.disconnect(); mediaStream.getTracks().forEach(t => t.stop()); audioContext.close(); } catch (e) {}
    const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of audioChunks) { merged.set(chunk, offset); offset += chunk.length; }
    resolve(new Blob([encodeWAV(merged, 16000)], { type: 'audio/wav' }));
  });
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2;
  }
  return buffer;
}
function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }

// ---------- 浏览器自带语音识别 ----------
let recognition = null;
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-GB';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
}

// ---------- 百度语音识别（备用） ----------
let baiduToken = null, baiduTokenExpire = 0;
async function getBaiduToken() {
  const now = Date.now();
  if (baiduToken && now < baiduTokenExpire) return baiduToken;
  const res = await fetch(`${CONFIG.proxyUrl}?path=baidu-token`);
  const data = await res.json();
  if (!data.access_token) throw new Error('获取百度token失败');
  baiduToken = data.access_token;
  baiduTokenExpire = now + (data.expires_in - 600) * 1000;
  return baiduToken;
}

async function baiduASR(audioBlob) {
  const token = await getBaiduToken();
  const buffer = await audioBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  const base64 = btoa(binary);
  const res = await fetch(`${CONFIG.proxyUrl}?path=baidu-asr`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'wav', rate: 16000, channel: 1, cuid: 'speak6_user', token, speech: base64, len: buffer.byteLength })
  });
  const data = await res.json();
  if (data.err_no === 0 && data.result && data.result[0]) return data.result[0];
  throw new Error('识别失败：' + (data.err_msg || JSON.stringify(data)));
}

// ---------- TTS ----------
function speak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CONFIG.study.accent; u.rate = 0.9;
    const voices = speechSynthesis.getVoices();
    const gbVoice = voices.find(v => v.lang === 'en-GB');
    if (gbVoice) u.voice = gbVoice;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

// ---------- DeepSeek AI ----------
async function askAI(messages) {
  const res = await fetch(`${CONFIG.proxyUrl}?path=deepseek`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 800 })
  });
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error('AI返回异常：' + JSON.stringify(data));
  return data.choices[0].message.content;
}

// ---------- 生成今日任务（仅生成核心句） ----------
async function generateTodayTask() {
  const dayNum = getStudyDay();
  const info = getDayInfo(dayNum);
  if (!info) return;

  document.getElementById('dayBadge').textContent = 'Day ' + dayNum;
  document.getElementById('monthTitle').textContent = '第' + info.month.month + '月 · ' + info.month.title;
  document.getElementById('weekTheme').textContent = '第' + info.week.week + '周 · ' + info.week.theme;

  const pct = (STATE.completedDays.length / 180 * 100).toFixed(1);
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('xpText').textContent = STATE.xp + ' XP';
  document.getElementById('progressText').textContent = STATE.completedDays.length + '/180天';
  document.getElementById('streak').textContent = '🔥 ' + STATE.streak + '天';

  const tasks = ['热身唤醒（3分钟）','精听跟读（7分钟）','句型替换（8分钟）','输出实战（9分钟）','复盘打卡（3分钟）'];
  document.getElementById('taskList').innerHTML = tasks.map((t, i) => `<li><span class="check" data-idx="${i}">${i + 1}</span>${t}</li>`).join('');

  document.getElementById('coreSentences').innerHTML = '<p class="subtitle"><span class="loading"></span> AI正在生成今日核心句...</p>';
  const prompt = `你是英语口语教练，学生水平CEFR A1-A2，英式英语。
今天是第${dayNum}天，第${info.month.month}月，主题：${info.month.title}，本周：${info.week.theme}，今日：${info.day}。
请生成6个核心句。格式JSON：{"sentences":[{"en":"","cn":""}]}，只返回JSON。`;

  try {
    const raw = await askAI([{ role: 'system', content: '你是英语口语教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);
    document.getElementById('coreSentences').innerHTML = data.sentences.map(s => `<div class="core-sentence"><div class="en">${s.en}</div><div class="cn">${s.cn}</div></div>`).join('');
    STATE.todaySentences = data.sentences; saveState(STATE);
    
    STATE.chatHistory = [];
    saveState(STATE);
    initChat();
  } catch (e) {
    document.getElementById('coreSentences').innerHTML = '<p class="subtitle">AI生成失败：' + e.message + '</p>';
  }
}

// ---------- 纯动态对话逻辑 ----------
function initChat() {
  document.getElementById('chatBox').innerHTML = '';
  const info = getDayInfo(getStudyDay());
  const greeting = `Hi! I am your English speaking partner. Let's talk about today's topic: ${info?.day || 'free talk'}. Are you ready?`;
  addMessage('ai', greeting);
  speak(greeting);
}

async function getAIFeedback(userText) {
  const info = getDayInfo(getStudyDay());
  const history = STATE.chatHistory || [];
  
  const systemPrompt = `你是一名英语口语教练，学生是中文母语者，水平CEFR A1-A2（流利说LV2），使用英式英语。
今天是第${getStudyDay()}天，主题：${info.day}。
你需要：
1. 用英式英语自然回应用户（LV2难度，简短，保持对话继续）。
2. 用中文给出纠错反馈（语法、更地道说法、英音发音提示）。
3. 给出评分（流利度、发音、词汇、语法、互动，各1-5分）。
返回JSON格式：{"reply":"","feedback":"","score":{"流利度":1,"发音":1,"词汇":1,"语法":1,"互动":1}}`;

  const messages = [{ role: 'system', content: systemPrompt }];
  history.slice(-10).forEach(m => messages.push(m));
  messages.push({ role: 'user', content: userText });

  try {
    const raw = await askAI(messages);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    addMessage('ai', data.reply);
    speak(data.reply);

    addFeedback(`
      <div class="feedback-item"><span class="feedback-label">纠错：</span>${data.feedback}</div>
      <div class="feedback-item"><span class="feedback-label">评分：</span>
        流利度 ${data.score.流利度}/5 · 发音 ${data.score.发音}/5 · 词汇 ${data.score.词汇}/5 · 语法 ${data.score.语法}/5 · 互动 ${data.score.互动}/5
      </div>
    `);

    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: data.reply });
    STATE.chatHistory = history;
    STATE.reviewData.push({ day: getStudyDay(), userText, ...data, time: Date.now() });
    saveState(STATE);
  } catch (e) {
    addMessage('ai', 'Sorry, I am having trouble. Let me try again.');
  }
}

function addMessage(role, text) {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'msg msg-' + (role === 'ai' ? 'ai' : 'user');
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function addFeedback(html) {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'msg msg-feedback';
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ---------- 悬浮录音按钮逻辑 ----------
const fabRecord = document.getElementById('fabRecord');

fabRecord.addEventListener('click', async () => {
  if (!isRecording) {
    isRecording = true;
    fabRecord.classList.add('recording');
    fabRecord.textContent = '⏹️';
    document.getElementById('status').textContent = '录音中...';
    try {
      if (CONFIG.asrProvider === 'browser' && recognition) {
        recognition.start();
        recognition.onresult = (e) => { /* 收到结果后在停止时处理 */ };
      } else {
        await startRecording();
      }
    } catch (e) {
      isRecording = false; fabRecord.classList.remove('recording'); fabRecord.textContent = '🎤';
      document.getElementById('status').textContent = '麦克风权限被拒绝：' + e.message;
    }
  } else {
    isRecording = false;
    fabRecord.classList.remove('recording');
    fabRecord.textContent = '🎤';
    document.getElementById('status').innerHTML = '<span class="loading"></span> 识别中...';

    try {
      if (CONFIG.asrProvider === 'browser' && recognition) {
        recognition.stop();
        recognition.onresult = async (e) => {
          const text = e.results[0][0].transcript;
          addMessage('user', text);
          document.getElementById('status').textContent = '';
          await getAIFeedback(text);
        };
        // 处理未识别到的情况
        recognition.onerror = (e) => {
          document.getElementById('status').textContent = '未识别到声音，请重试。';
        };
      } else {
        const blob = await stopRecording();
        const text = await baiduASR(blob);
        addMessage('user', text);
        document.getElementById('status').textContent = '';
        await getAIFeedback(text);
      }
    } catch (e) {
      document.getElementById('status').textContent = '识别失败：' + e.message;
    }
  }
});

document.getElementById('skipBtn').addEventListener('click', () => {
  const msg = 'Let me ask you: What do you think about this topic?';
  addMessage('ai', msg);
  speak(msg);
});

document.getElementById('endChatBtn').addEventListener('click', () => {
  document.querySelector('.nav-item[data-view="view-today"]').click();
  showToast('已结束对话，请查看复盘');
});

document.getElementById('playAllBtn').addEventListener('click', () => {
  if (STATE.todaySentences) STATE.todaySentences.forEach(s => speak(s.en));
});

// ---------- 复盘与打卡 ----------
document.getElementById('reviewBtn').addEventListener('click', () => {
  const reviews = (STATE.reviewData || []).filter(r => r.day === getStudyDay());
  if (reviews.length === 0) { document.getElementById('reviewContent').innerHTML = '<p class="subtitle">还没有对话记录，先完成对话练习。</p>'; return; }
  const avg = { 流利度: 0, 发音: 0, 词汇: 0, 语法: 0, 互动: 0 };
  reviews.forEach(r => { for (const k in avg) avg[k] += r.score[k]; });
  for (const k in avg) avg[k] = (avg[k] / reviews.length).toFixed(1);
  document.getElementById('reviewContent').innerHTML = `
    <div class="core-sentence"><div class="en">今日对话次数：${reviews.length}次</div>
    <div class="cn">平均分：流利度 ${avg.流利度} · 发音 ${avg.发音} · 词汇 ${avg.词汇} · 语法 ${avg.语法} · 互动 ${avg.互动}</div></div>
    <p class="subtitle" style="margin-top:8px;">继续加油！明天继续保持。</p>`;
  showToast('复盘报告已生成');
});

document.getElementById('finishBtn').addEventListener('click', () => {
  const day = getStudyDay();
  if (!STATE.completedDays.includes(day)) {
    STATE.completedDays.push(day); STATE.xp += 40;
    const last = STATE.lastDate; const todayStr = today();
    if (last) { const diff = (new Date(todayStr) - new Date(last)) / 86400000; STATE.streak = diff === 1 ? STATE.streak + 1 : 1; } else { STATE.streak = 1; }
    STATE.lastDate = todayStr; saveState(STATE);
  }
  showToast('✅ Day ' + day + ' 打卡完成！+40 XP');
  setTimeout(() => location.reload(), 1500);
});

// ---------- 历史记录与设置 ----------
function renderHistory() {
  const list = document.getElementById('historyList');
  if (!STATE.completedDays || STATE.completedDays.length === 0) { list.innerHTML = '暂无记录，去完成今天的任务吧！'; return; }
  list.innerHTML = STATE.completedDays.map(d => `<div class="core-sentence"><div class="en">Day ${d}</div><div class="cn">完成打卡</div></div>`).join('');
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const dataStr = JSON.stringify(STATE, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'speak6_progress.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('已导出学习进度文件');
});

document.getElementById('importBtn').addEventListener('click', () => { document.getElementById('importFile').click(); });
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try { const imported = JSON.parse(ev.target.result); localStorage.setItem('speak6_state', JSON.stringify(imported)); showToast('导入成功！刷新页面生效'); setTimeout(() => location.reload(), 1500); }
    catch (err) { showToast('文件格式错误！'); }
  };
  reader.readAsText(file);
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (confirm('确定要重置所有进度吗？这将清空所有XP和打卡记录！')) { localStorage.removeItem('speak6_state'); location.reload(); }
});

// ---------- 月度考核 ----------
function checkMonthlyExam() {
  const day = getStudyDay();
  if (day % 30 === 0) {
    const examCard = document.createElement('div');
    examCard.className = 'glass-card';
    examCard.innerHTML = `
      <div class="step-title">🏆 月度考核</div>
      <p class="subtitle">今天进行第${Math.ceil(day / 30)}月考核，采用AI随机提问 + 自由对话模式。</p>
      <button class="btn btn-primary" id="examBtn">开始月度考核</button>
    `;
    document.getElementById('view-today').appendChild(examCard);
    document.getElementById('examBtn').addEventListener('click', () => {
      showToast('考核开始！请切换到对话练习标签');
      document.querySelector('.nav-item[data-view="view-chat"]').click();
      const msg = 'Welcome to your monthly exam. I will ask you 5 questions. Please answer in full sentences. Let\'s start: Can you introduce yourself briefly?';
      addMessage('ai', msg);
      speak(msg);
    });
  }
}

// ---------- 初始化 ----------
window.addEventListener('load', () => {
  generateTodayTask();
  setTimeout(checkMonthlyExam, 2000);
});
