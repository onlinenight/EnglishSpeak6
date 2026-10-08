// ============================================
// app.js - 核心逻辑 (拆解模式 + 跟读打分 + 累积计时 + 修复识别)
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
  return { completedDays: [], xp: 0, streak: 0, lastDate: null, currentDay: 1, reviewData: [], chatHistory: [], dailyTimeSpent: {} };
}

function saveState(state) { localStorage.setItem('speak6_state', JSON.stringify(state)); }
let STATE = loadState();
if (!STATE.dailyTimeSpent) STATE.dailyTimeSpent = {};

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

// ---------- Toast ----------
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ---------- 计时器（累积，跨会话保持） ----------
let timerInterval = null;
function initTimer() {
  const todayStr = today();
  if (!STATE.dailyTimeSpent[todayStr]) STATE.dailyTimeSpent[todayStr] = 0;
  updateTimerUI();
  
  timerInterval = setInterval(() => {
    if (document.hidden) return; // 页面隐藏时不计时
    STATE.dailyTimeSpent[todayStr] += 1;
    saveState(STATE);
    updateTimerUI();
  }, 1000);
}

function updateTimerUI() {
  const todayStr = today();
  const seconds = STATE.dailyTimeSpent[todayStr] || 0;
  const minutes = Math.floor(seconds / 60);
  document.getElementById('timerBadge').textContent = `⏱ ${minutes}/30m`;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 页面隐藏，时间依然在 localStorage，不需要做额外处理
  } else {
    updateTimerUI(); // 页面显示，立即刷新一次
  }
});

// ---------- 视图切换 ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(item.dataset.view).classList.add('active');
    
    const fab = document.getElementById('fabRecord');
    if (item.dataset.view === 'view-chat') { fab.style.display = 'flex'; } else { fab.style.display = 'none'; }
    if (item.dataset.view === 'view-history') renderHistory();
  });
});

// ---------- 浏览器语音识别 (Web Speech API) ----------
let recognition = null;
let recognitionActive = false;
let currentRecordingTarget = null; // 'chat' 或 跟读句子索引

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-GB';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
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
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 1200 })
  });
  const data = await res.json();
  if (!data.choices || !data.choices[0]) throw new Error('AI返回异常：' + JSON.stringify(data));
  return data.choices[0].message.content;
}

// ---------- 生成今日任务（拆解模式） ----------
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

  document.getElementById('coreSentences').innerHTML = '<p class="subtitle"><span class="loading"></span> AI正在拆解今日任务...</p>';
  
  const prompt = `你是英语口语教练，学生水平CEFR A1-A2，英式英语。
今天是第${dayNum}天，主题：${info.month.title}，本周：${info.week.theme}，今日任务：${info.day}。
请将今日任务拆解为3个步骤，每个步骤包含2个核心句。并设定一个终极挑战。
返回JSON格式：{"goal":"今日学习目标","steps":[{"stepName":"步骤1：...","sentences":[{"en":"","cn":""}]}],"challenge":"终极挑战描述"}。只返回JSON。`;

  try {
    const raw = await askAI([{ role: 'system', content: '你是英语口语教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    document.getElementById('dailyGoalText').textContent = data.goal || '完成今日拆解任务';
    document.getElementById('challengeText').textContent = data.challenge || '不看稿，把所学内容连起来说一遍。';

    let allSentencesHTML = '';
    data.steps.forEach((step, stepIndex) => {
      allSentencesHTML += `<div class="step-group"><h3>${step.stepName}</h3>`;
      step.sentences.forEach((s, sIndex) => {
        const uniqueId = `read_${stepIndex}_${sIndex}`;
        allSentencesHTML += `
          <div class="core-sentence" id="sentence_${uniqueId}">
            <div class="en">${s.en}</div>
            <div class="cn">${s.cn}</div>
            <button class="read-aloud-btn" onclick="startFollowRead('${uniqueId}', '${s.en.replace(/'/g, "\\'")}')">🎤 跟读</button>
            <div class="feedback-box" id="feedback_${uniqueId}"></div>
          </div>`;
      });
      allSentencesHTML += `</div>`;
    });
    document.getElementById('coreSentences').innerHTML = allSentencesHTML;

    STATE.todaySentences = data.steps.flatMap(s => s.sentences);
    STATE.chatHistory = [];
    saveState(STATE);
    initChat();
  } catch (e) {
    document.getElementById('coreSentences').innerHTML = '<p class="subtitle">AI生成失败：' + e.message + '</p>';
  }
}

// ---------- 跟读功能（含 AI 发音纠错） ----------
function startFollowRead(uniqueId, originalText) {
  if (recognitionActive) { showToast('正在录音中，请稍后...'); return; }
  
  // 重置所有按钮
  document.querySelectorAll('.read-aloud-btn').forEach(btn => {
    btn.textContent = '🎤 跟读';
    btn.style.background = 'rgba(59,130,246,0.2)';
  });

  const btn = document.querySelector(`#sentence_${uniqueId} .read-aloud-btn`);
  const feedbackBox = document.getElementById(`feedback_${uniqueId}`);
  feedbackBox.style.display = 'none';
  feedbackBox.innerHTML = '';

  btn.textContent = '⏹️ 停止';
  btn.style.background = '#ef4444';
  currentRecordingTarget = uniqueId;
  recognitionActive = true;

  // 关键：在 start 之前绑定 onresult
  recognition.onresult = async (e) => {
    const userSpeech = e.results[0][0].transcript;
    btn.textContent = '🎤 跟读';
    btn.style.background = 'rgba(59,130,246,0.2)';
    recognitionActive = false;
    currentRecordingTarget = null;

    // 1. 文本匹配打分
    const matchScore = calculateMatchScore(originalText, userSpeech);

    // 2. 调用 AI 进行深度发音纠错
    feedbackBox.style.display = 'block';
    feedbackBox.innerHTML = `<span class="loading"></span> 正在分析发音...`;

    try {
      const prompt = `你是英语发音教练。学生跟读原句："${originalText}"，识别出的文本是："${userSpeech}"。
请分析学生的发音问题（比如 th 发音、连读、重音），用中文给出建议。
返回JSON：{"score":0-100,"feedback":"发音纠错建议"}`;
      const raw = await askAI([{ role: 'system', content: '你是英语发音教练，只返回JSON。' }, { role: 'user', content: prompt }]);
      const jsonStr = raw.replace(/```json|```/g, '').trim();
      const aiData = JSON.parse(jsonStr);
      
      feedbackBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span>匹配度：${matchScore}%</span>
          <span>发音分：${aiData.score}/100</span>
        </div>
        <div>${aiData.feedback}</div>
      `;
    } catch (err) {
      feedbackBox.innerHTML = `匹配度：${matchScore}%<br>AI纠错暂时不可用。`;
    }
  };

  recognition.onerror = (e) => {
    btn.textContent = '🎤 跟读';
    btn.style.background = 'rgba(59,130,246,0.2)';
    recognitionActive = false;
    currentRecordingTarget = null;
    if (e.error === 'no-speech') {
      showToast('没听清，请再试一次');
    } else {
      showToast('识别出错：' + e.error);
    }
  };

  recognition.start();
}

function calculateMatchScore(original, userSpeech) {
  const origWords = original.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const userWords = userSpeech.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  let matched = 0;
  origWords.forEach(w => { if (userWords.includes(w)) matched++; });
  return Math.round((matched / origWords.length) * 100);
}

// ---------- 对话逻辑 ----------
function initChat() {
  document.getElementById('chatBox').innerHTML = '';
  const info = getDayInfo(getStudyDay());
  const greeting = `Hi! Let's practice. Today's topic is: ${info?.day || 'free talk'}. Are you ready?`;
  addMessage('ai', greeting);
  speak(greeting);
}

async function getAIFeedback(userText) {
  const info = getDayInfo(getStudyDay());
  const history = STATE.chatHistory || [];
  
  const systemPrompt = `你是一名英语口语教练，学生水平CEFR A1-A2，英式英语。
主题：${info.day}。
请回应用户，并用中文纠错，给出评分。
返回JSON：{"reply":"","feedback":"","score":{"流利度":1,"发音":1,"词汇":1,"语法":1,"互动":1}}`;

  const messages = [{ role: 'system', content: systemPrompt }];
  history.slice(-10).forEach(m => messages.push(m));
  messages.push({ role: 'user', content: userText });

  try {
    const raw = await askAI(messages);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    addMessage('ai', data.reply);
    speak(data.reply);
    addFeedback(`<div class="feedback-item"><span class="feedback-label">纠错：</span>${data.feedback}</div>
      <div class="feedback-item"><span class="feedback-label">评分：</span>流利度 ${data.score.流利度}/5 · 发音 ${data.score.发音}/5 · 词汇 ${data.score.词汇}/5 · 语法 ${data.score.语法}/5 · 互动 ${data.score.互动}/5</div>`);

    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: data.reply });
    STATE.chatHistory = history;
    STATE.reviewData.push({ day: getStudyDay(), userText, ...data, time: Date.now() });
    saveState(STATE);
  } catch (e) {
    addMessage('ai', 'Sorry, let me try again.');
  }
}

function addMessage(role, text) {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'msg msg-' + (role === 'ai' ? 'ai' : 'user');
  div.textContent = text;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
}

function addFeedback(html) {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'msg msg-feedback';
  div.innerHTML = html;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
}

// ---------- 悬浮录音按钮（对话专用） ----------
const fabRecord = document.getElementById('fabRecord');

fabRecord.addEventListener('click', async () => {
  if (recognitionActive) {
    // 结束录音
    recognition.stop();
    fabRecord.classList.remove('recording');
    fabRecord.textContent = '🎤';
    document.getElementById('status').innerHTML = '<span class="loading"></span> 识别中...';
  } else {
    // 开始录音
    recognitionActive = true;
    fabRecord.classList.add('recording');
    fabRecord.textContent = '⏹️';
    document.getElementById('status').textContent = '录音中...';
    currentRecordingTarget = 'chat';

    recognition.onresult = async (e) => {
      const text = e.results[0][0].transcript;
      addMessage('user', text);
      document.getElementById('status').textContent = '';
      recognitionActive = false;
      await getAIFeedback(text);
    };

    recognition.onerror = (e) => {
      document.getElementById('status').textContent = '未识别到声音，请重试。';
      recognitionActive = false;
      fabRecord.classList.remove('recording');
      fabRecord.textContent = '🎤';
    };

    recognition.start();
  }
});

document.getElementById('skipBtn').addEventListener('click', () => {
  const msg = 'Let me ask you: What do you think about this topic?';
  addMessage('ai', msg); speak(msg);
});

document.getElementById('endChatBtn').addEventListener('click', () => {
  document.querySelector('.nav-item[data-view="view-today"]').click();
  showToast('已结束对话，请查看复盘');
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
    <div class="cn">平均分：流利度 ${avg.流利度} · 发音 ${avg.发音} · 词汇 ${avg.词汇} · 语法 ${avg.语法} · 互动 ${avg.互动}</div></div>`;
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

// ---------- 历史与设置 ----------
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
  URL.revokeObjectURL(url); showToast('已导出学习进度文件');
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
    examCard.innerHTML = `<div class="step-title">🏆 月度考核</div>
      <p class="subtitle">今天进行第${Math.ceil(day / 30)}月考核，采用AI随机提问 + 自由对话模式。</p>
      <button class="btn btn-primary" id="examBtn">开始月度考核</button>`;
    document.getElementById('view-today').appendChild(examCard);
    document.getElementById('examBtn').addEventListener('click', () => {
      showToast('考核开始！请切换到对话练习标签');
      document.querySelector('.nav-item[data-view="view-chat"]').click();
      const msg = 'Welcome to your monthly exam. I will ask you 5 questions. Please answer in full sentences. Let\'s start: Can you introduce yourself briefly?';
      addMessage('ai', msg); speak(msg);
    });
  }
}

// ---------- 初始化 ----------
window.addEventListener('load', () => {
  initTimer(); // 启动累积计时
  generateTodayTask();
  setTimeout(checkMonthlyExam, 2000);
});
