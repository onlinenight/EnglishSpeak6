// ============================================
// app.js - 核心逻辑（Vercel + 代理版本）
// ============================================

// ---------- 日期与状态 ----------
function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStudyDay() {
  const start = new Date(CONFIG.study.startDate);
  const now = new Date();
  const diff = Math.floor((now - start) / 86400000) + 1;
  return Math.max(1, Math.min(180, diff));
}

function loadState() {
  const s = localStorage.getItem('speak6_state');
  if (s) return JSON.parse(s);
  return {
    completedDays: [],
    xp: 0,
    streak: 0,
    lastDate: null,
    currentDay: 1,
    reviewData: []
  };
}

function saveState(state) {
  localStorage.setItem('speak6_state', JSON.stringify(state));
}

let STATE = loadState();

// ---------- 获取当天课程 ----------
function getDayInfo(dayNum) {
  let count = 0;
  for (const m of CURRICULUM.months) {
    for (const w of m.weeks) {
      for (const d of w.days) {
        count++;
        if (count === dayNum) {
          return { month: m, week: w, day: d, dayNum };
        }
      }
    }
  }
  return null;
}

// ---------- 录音：AudioContext 采集 PCM ----------
let audioContext = null;
let scriptProcessor = null;
let mediaStream = null;
let audioChunks = [];
let isRecording = false;

async function startRecording() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  audioChunks = [];

  scriptProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    audioChunks.push(new Float32Array(input));
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);
}

function stopRecording() {
  return new Promise((resolve) => {
    try {
      scriptProcessor.disconnect();
      mediaStream.getTracks().forEach(t => t.stop());
      audioContext.close();
    } catch (e) { /* ignore */ }

    // 合并 PCM
    const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of audioChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // 封装为 WAV
    const wavBuffer = encodeWAV(merged, 16000);
    resolve(new Blob([wavBuffer], { type: 'audio/wav' }));
  });
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// ---------- 百度语音识别（通过代理） ----------
let baiduToken = null;
let baiduTokenExpire = 0;

async function getBaiduToken() {
  const now = Date.now();
  if (baiduToken && now < baiduTokenExpire) return baiduToken;

  const res = await fetch(`${CONFIG.proxyUrl}?path=baidu-token`);
  const data = await res.json();
  if (!data.access_token) throw new Error('获取百度token失败：' + JSON.stringify(data));
  baiduToken = data.access_token;
  baiduTokenExpire = now + (data.expires_in - 600) * 1000; // 提前10分钟过期
  return baiduToken;
}

async function baiduASR(audioBlob) {
  const token = await getBaiduToken();
  const buffer = await audioBlob.arrayBuffer();

  // 分块 base64，避免大数组导致栈溢出
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);

  const res = await fetch(`${CONFIG.proxyUrl}?path=baidu-asr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: 'wav',
      rate: 16000,
      channel: 1,
      cuid: 'speak6_user',
      token: token,
      speech: base64,
      len: buffer.byteLength
    })
  });

  const data = await res.json();
  if (data.err_no === 0 && data.result && data.result[0]) {
    return data.result[0];
  }
  throw new Error('识别失败：' + (data.err_msg || JSON.stringify(data)));
}

// ---------- 浏览器TTS（英音） ----------
function speak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CONFIG.study.accent;
    u.rate = 0.9;

    // 优先选英音
    const voices = speechSynthesis.getVoices();
    const gbVoice = voices.find(v => v.lang === 'en-GB');
    if (gbVoice) u.voice = gbVoice;

    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

// 部分浏览器需要等待 voices 加载
if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = () => {};
}

// ---------- DeepSeek AI（通过代理） ----------
async function askAI(messages) {
  const res = await fetch(`${CONFIG.proxyUrl}?path=deepseek`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 800
    })
  });
  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('AI返回异常：' + JSON.stringify(data));
  }
  return data.choices[0].message.content;
}

// ---------- 生成今日任务 ----------
async function generateTodayTask() {
  const dayNum = getStudyDay();
  const info = getDayInfo(dayNum);
  if (!info) return;

  document.getElementById('dayBadge').textContent = 'Day ' + dayNum;
  document.getElementById('monthTitle').textContent = '第' + info.month.month + '月 · ' + info.month.title;
  document.getElementById('weekTheme').textContent = '第' + info.week.week + '周 · ' + info.week.theme;

  // 进度
  const pct = (STATE.completedDays.length / 180 * 100).toFixed(1);
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('xpText').textContent = STATE.xp + ' XP';
  document.getElementById('progressText').textContent = STATE.completedDays.length + '/180天';
  document.getElementById('streak').textContent = '🔥 ' + STATE.streak + '天';

  // 今日任务列表
  const tasks = [
    '热身唤醒（3分钟）',
    '精听跟读（7分钟）',
    '句型替换（8分钟）',
    '输出实战（9分钟）',
    '复盘打卡（3分钟）'
  ];
  const taskList = document.getElementById('taskList');
  taskList.innerHTML = tasks.map((t, i) => `
    <li><span class="check" data-idx="${i}">${i + 1}</span>${t}</li>
  `).join('');

  // 让 AI 生成今日核心句
  document.getElementById('coreSentences').innerHTML =
    '<p class="subtitle"><span class="loading"></span> AI正在生成今日内容...</p>';

  const prompt = `你是英语口语教练，学生是中文母语者，水平CEFR A1-A2（流利说LV2），使用英式英语。
今天是第${dayNum}天，第${info.month.month}月，主题：${info.month.title}，本周主题：${info.week.theme}，今日任务：${info.day}。
请生成：
1. 6个今日核心句（英文+中文翻译，LV2难度，短句为主）
2. 一段6-8轮的对话示范（A和B，场景是今天的任务）
3. 3个重点发音提示（英音）
格式用JSON：
{"sentences":[{"en":"","cn":""}],"dialogue":[{"role":"A","text":""}],"pronunciation":[""]}
只返回JSON，不要其他文字。`;

  try {
    const raw = await askAI([
      { role: 'system', content: '你是英语口语教练，只返回JSON。' },
      { role: 'user', content: prompt }
    ]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    document.getElementById('coreSentences').innerHTML = data.sentences.map(s => `
      <div class="core-sentence">
        <div class="en">${s.en}</div>
        <div class="cn">${s.cn}</div>
      </div>
    `).join('');

    STATE.todayDialogue = data.dialogue;
    STATE.todaySentences = data.sentences;
    STATE.todayPronunciation = data.pronunciation || [];
    saveState(STATE);

    startConversation(data.dialogue);
  } catch (e) {
    document.getElementById('coreSentences').innerHTML =
      '<p class="subtitle">AI生成失败，请检查代理与环境变量。错误：' + e.message + '</p>';
  }
}

// ---------- 对话逻辑 ----------
let dialogueIndex = 0;
let currentDialogue = [];

function startConversation(dialogue) {
  currentDialogue = dialogue;
  dialogueIndex = 0;
  document.getElementById('chatBox').innerHTML = '';

  const first = dialogue.find(d => d.role === 'A');
  if (first) {
    addMessage('ai', first.text);
    speak(first.text);
    dialogueIndex = dialogue.indexOf(first) + 1;
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

// ---------- 按钮事件 ----------
const recordBtn = document.getElementById('recordBtn');

recordBtn.addEventListener('mousedown', startRec);
recordBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRec(); });
recordBtn.addEventListener('mouseup', endRec);
recordBtn.addEventListener('touchend', (e) => { e.preventDefault(); endRec(); });

async function startRec() {
  if (isRecording) return;
  isRecording = true;
  recordBtn.classList.add('recording');
  recordBtn.textContent = '🔴 松开结束';
  document.getElementById('status').textContent = '录音中...';
  try {
    await startRecording();
  } catch (e) {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtn.textContent = '🎤 按住说话';
    document.getElementById('status').textContent = '麦克风权限被拒绝：' + e.message;
  }
}

async function endRec() {
  if (!isRecording) return;
  isRecording = false;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '🎤 按住说话';
  document.getElementById('status').innerHTML = '<span class="loading"></span> 识别中...';

  try {
    const blob = await stopRecording();
    const text = await baiduASR(blob);
    addMessage('user', text);
    document.getElementById('status').textContent = '';
    await getAIFeedback(text);
  } catch (e) {
    document.getElementById('status').textContent = '识别失败：' + e.message;
  }
}

async function getAIFeedback(userText) {
  const info = getDayInfo(getStudyDay());
  const prompt = `学生说："${userText}"
今日主题：${info.day}。
请用JSON返回：
{
  "reply": "用英式英语自然回应的下一句（LV2难度，简短）",
  "feedback": "中文纠错反馈，包括：语法问题、更地道的说法、发音提示（英音）",
  "score": {"流利度":1-5, "发音":1-5, "词汇":1-5, "语法":1-5, "互动":1-5}
}
只返回JSON。`;

  try {
    const raw = await askAI([
      { role: 'system', content: '你是英式英语口语教练，只返回JSON。' },
      { role: 'user', content: prompt }
    ]);
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

    if (!STATE.reviewData) STATE.reviewData = [];
    STATE.reviewData.push({ day: getStudyDay(), userText, ...data, time: Date.now() });
    saveState(STATE);
  } catch (e) {
    addMessage('ai', 'Sorry, let me try again.');
  }
}

document.getElementById('skipBtn').addEventListener('click', () => {
  if (currentDialogue && dialogueIndex < currentDialogue.length) {
    const next = currentDialogue[dialogueIndex];
    addMessage('ai', next.text);
    speak(next.text);
    dialogueIndex++;
  }
});

document.getElementById('playAllBtn').addEventListener('click', () => {
  if (STATE.todaySentences) {
    STATE.todaySentences.forEach(s => speak(s.en));
  }
});

document.getElementById('reviewBtn').addEventListener('click', () => {
  const reviews = (STATE.reviewData || []).filter(r => r.day === getStudyDay());
  if (reviews.length === 0) {
    document.getElementById('reviewContent').innerHTML =
      '<p class="subtitle">还没有对话记录，先完成对话练习。</p>';
    return;
  }
  const avg = { 流利度: 0, 发音: 0, 词汇: 0, 语法: 0, 互动: 0 };
  reviews.forEach(r => {
    for (const k in avg) avg[k] += r.score[k];
  });
  for (const k in avg) avg[k] = (avg[k] / reviews.length).toFixed(1);

  document.getElementById('reviewContent').innerHTML = `
    <div class="core-sentence">
      <div class="en">今日对话次数：${reviews.length}次</div>
      <div class="cn">平均分：流利度 ${avg.流利度} · 发音 ${avg.发音} · 词汇 ${avg.词汇} · 语法 ${avg.语法} · 互动 ${avg.互动}</div>
    </div>
    <p class="subtitle" style="margin-top:8px;">继续加油！明天继续保持。</p>
  `;
});

document.getElementById('finishBtn').addEventListener('click', () => {
  const day = getStudyDay();
  if (!STATE.completedDays.includes(day)) {
    STATE.completedDays.push(day);
    STATE.xp += 40;
    const last = STATE.lastDate;
    const todayStr = today();
    if (last) {
      const diff = (new Date(todayStr) - new Date(last)) / 86400000;
      STATE.streak = diff === 1 ? STATE.streak + 1 : 1;
    } else {
      STATE.streak = 1;
    }
    STATE.lastDate = todayStr;
    saveState(STATE);
  }
  alert('✅ Day ' + day + ' 打卡完成！+40 XP');
  location.reload();
});

// ---------- 月度考核 ----------
function checkMonthlyExam() {
  const day = getStudyDay();
  if (day % 30 === 0) {
    const examCard = document.createElement('div');
    examCard.className = 'card';
    examCard.innerHTML = `
      <div class="step-title">🏆 月度考核</div>
      <p class="subtitle">今天进行第${Math.ceil(day / 30)}月考核，使用实时对话模式。</p>
      <button class="btn btn-primary" id="examBtn">开始月度考核</button>
    `;
    document.body.insertBefore(examCard, document.getElementById('reviewCard'));
    document.getElementById('examBtn').addEventListener('click', () => {
      alert('月度考核：请和AI进行10分钟自由对话，系统将自动评分。');
    });
  }
}

// ---------- 初始化 ----------
window.addEventListener('load', () => {
  generateTodayTask();
  setTimeout(checkMonthlyExam, 2000);
});