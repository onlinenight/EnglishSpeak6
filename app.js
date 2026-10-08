// ============================================
// app.js - 核心逻辑 (沉浸式四关卡 + 逐词高亮 + 修复iOS卡死)
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
  if (!document.hidden) updateTimerUI();
});

// ---------- 视图切换 ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(item.dataset.view).classList.add('active');
    if (item.dataset.view === 'view-history') renderHistory();
  });
});

// ---------- 全局状态与录音逻辑（核心：修复 iOS 卡死） ----------
let recognition = null;
let isRecording = false;
let recordingTimeout = null;
let currentStepIndex = 0; // 0:热身 1:核心 2:对话 3:挑战
let currentSentenceIndex = 0;
let lessonData = null;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-GB';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
}

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('waveform').classList.add('active');
  document.getElementById('lessonStatus').textContent = '录音中... 请朗读';
  
  recognition.onresult = (e) => {
    clearTimeout(recordingTimeout);
    const userSpeech = e.results[0][0].transcript;
    stopRecordingUI();
    evaluateSpeech(userSpeech);
  };

  recognition.onerror = (e) => {
    clearTimeout(recordingTimeout);
    stopRecordingUI();
    if (e.error === 'no-speech') showToast('没听清，请再试一次');
    else showToast('识别出错：' + e.error);
  };

  recognition.onend = () => {
    clearTimeout(recordingTimeout);
    stopRecordingUI();
  };

  recognition.start();
  // iOS 卡死修复：5秒超时强制重置
  recordingTimeout = setTimeout(() => {
    if (isRecording) {
      recognition.stop();
      stopRecordingUI();
      showToast('未识别到声音，请重试');
    }
  }, 5000);
}

function stopRecordingUI() {
  isRecording = false;
  clearTimeout(recordingTimeout);
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('waveform').classList.remove('active');
  document.getElementById('lessonStatus').innerHTML = '<span class="loading"></span> 分析中...';
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

// ---------- 生成今日任务（四关卡拆解） ----------
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

  document.getElementById('dailyGoalText').innerHTML = '<span class="loading"></span> AI正在拆解今日任务...';
  
  const prompt = `你是英语口语教练，学生水平CEFR A1-A2，英式英语。
今天是第${dayNum}天，主题：${info.month.title}，本周：${info.week.theme}，今日任务：${info.day}。
请将今日任务拆解为4个关卡：
关卡1：热身（1-2句核心句）
关卡2：核心句型（2-3句核心句）
关卡3：情景对话（AI扮演外国人，与学生自由对话）
关卡4：今日挑战（1段综合文本，让学生连起来说）
返回JSON格式：{"goal":"今日学习目标","warmup":["句子1"],"core":["句子2","句子3"],"dialogue_prompt":"对话场景描述","challenge":"综合挑战文本"}。只返回JSON。`;

  try {
    const raw = await askAI([{ role: 'system', content: '你是英语口语教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    document.getElementById('dailyGoalText').textContent = data.goal || '完成今日拆解任务';
    
    lessonData = {
      warmup: data.warmup || ['Hello!'],
      core: data.core || ['My name is Li Ming.'],
      dialogue: data.dialogue_prompt || 'Let\'s have a chat.',
      challenge: data.challenge || 'Introduce yourself in 30 seconds.'
    };
    STATE.lessonData = lessonData;
    saveState(STATE);

    document.getElementById('startLessonBtn').disabled = false;
    document.getElementById('startLessonBtn').textContent = '🚀 开始今日闯关';
  } catch (e) {
    document.getElementById('dailyGoalText').textContent = 'AI生成失败：' + e.message;
  }
}

// ---------- 闯关逻辑 ----------
document.getElementById('startLessonBtn').addEventListener('click', () => {
  if (!lessonData) { showToast('任务还在加载中...'); return; }
  currentStepIndex = 0;
  currentSentenceIndex = 0;
  document.getElementById('view-lesson').classList.add('active');
  loadStep(0);
});

document.getElementById('closeLessonBtn').addEventListener('click', () => {
  document.getElementById('view-lesson').classList.remove('active');
});

function loadStep(stepIndex) {
  currentStepIndex = stepIndex;
  const lessonTitle = document.getElementById('lessonTitle');
  const sentenceBox = document.getElementById('sentenceBox');
  const translationBox = document.getElementById('translationBox');
  const nextBtn = document.getElementById('nextSentenceBtn');
  const recordBtn = document.getElementById('recordBtn');
  
  nextBtn.style.display = 'none';
  recordBtn.style.display = 'flex';
  translationBox.textContent = '';
  document.getElementById('lessonStatus').textContent = '点击麦克风开始录音';
  updateProgressRing(stepIndex);

  if (stepIndex === 0) {
    lessonTitle.textContent = '关卡1：热身';
    const sentence = lessonData.warmup[currentSentenceIndex];
    renderSentence(sentence, '');
  } else if (stepIndex === 1) {
    lessonTitle.textContent = '关卡2：核心句型';
    const sentence = lessonData.core[currentSentenceIndex];
    renderSentence(sentence, '');
  } else if (stepIndex === 2) {
    lessonTitle.textContent = '关卡3：情景对话';
    sentenceBox.innerHTML = '💬 ' + lessonData.dialogue;
    translationBox.textContent = '请点击下方麦克风，与AI自由对话';
    recordBtn.style.display = 'flex';
    // 对话模式特殊处理
    document.getElementById('nextSentenceBtn').style.display = 'none';
    currentStepIndex = 2;
  } else if (stepIndex === 3) {
    lessonTitle.textContent = '关卡4：今日挑战';
    sentenceBox.innerHTML = '🏆 ' + lessonData.challenge;
    translationBox.textContent = '不看稿，连起来说一遍';
    recordBtn.style.display = 'flex';
    document.getElementById('nextSentenceBtn').style.display = 'none';
    currentStepIndex = 3;
  }
}

function renderSentence(en, userSpeech) {
  const box = document.getElementById('sentenceBox');
  const targetWords = en.split(' ');
  const speechWords = userSpeech ? userSpeech.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/) : [];
  
  if (!userSpeech) {
    box.innerHTML = targetWords.map(w => `<span class="word">${w}</span>`).join(' ');
    return;
  }
  
  box.innerHTML = targetWords.map(w => {
    const cleanW = w.toLowerCase().replace(/[^a-z]/g, '');
    const isGood = speechWords.includes(cleanW);
    return `<span class="word ${isGood ? 'good' : 'bad'}">${w}</span>`;
  }).join(' ');
}

// 录音按钮点击
document.getElementById('recordBtn').addEventListener('click', () => {
  if (isRecording) {
    recognition.stop();
    stopRecordingUI();
    document.getElementById('lessonStatus').textContent = '已手动停止，等待识别...';
  } else {
    startRecording();
  }
});

// 评估发音（逐词高亮 + AI纠错）
async function evaluateSpeech(userSpeech) {
  const sentenceBox = document.getElementById('sentenceBox');
  const originalText = sentenceBox.textContent.replace('💬 ', '').replace('🏆 ', '');
  
  // 1. 逐词高亮
  renderSentence(originalText, userSpeech);

  // 2. AI 发音纠错
  try {
    const prompt = `你是英语发音教练。学生跟读原句："${originalText}"，识别出的文本是："${userSpeech}"。
请用中文给出发音纠错建议（比如 th 咬舌、连读、重音）。
返回JSON：{"feedback":"发音纠错建议","score":0-100}`;
    const raw = await askAI([{ role: 'system', content: '你是英语发音教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const aiData = JSON.parse(jsonStr);
    
    document.getElementById('lessonStatus').innerHTML = `评分：${aiData.score}/100<br>${aiData.feedback}`;
    document.getElementById('nextSentenceBtn').style.display = 'block';
  } catch (err) {
    document.getElementById('lessonStatus').textContent = 'AI纠错暂时不可用，但已识别到你的声音。';
    document.getElementById('nextSentenceBtn').style.display = 'block';
  }
}

// 下一句 / 下一关
document.getElementById('nextSentenceBtn').addEventListener('click', () => {
  if (currentStepIndex === 0) {
    if (currentSentenceIndex < lessonData.warmup.length - 1) {
      currentSentenceIndex++;
      loadStep(0);
    } else {
      loadStep(1);
    }
  } else if (currentStepIndex === 1) {
    if (currentSentenceIndex < lessonData.core.length - 1) {
      currentSentenceIndex++;
      loadStep(1);
    } else {
      loadStep(2); // 进入情景对话
    }
  }
});

// 关卡3、4 对话处理（复用录音逻辑，但走对话接口）
function handleDialogue(speechText) {
  addMessage('user', speechText);
  askAI([{ role: 'system', content: '你是英语口语教练，用英式英语自然回应用户，保持对话继续。' }, { role: 'user', content: speechText }]).then(reply => {
    addMessage('ai', reply);
    speak(reply);
    document.getElementById('lessonStatus').textContent = '继续对话，或点击下方“下一句”按钮进入下一关。';
  });
}

// ---------- 底部“复习”与“我的”逻辑 ----------
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

document.getElementById('reviewBtn').addEventListener('click', () => {
  showToast('请查看底部“复习”标签');
  document.querySelector('.nav-item[data-view="view-history"]').click();
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

// 进度环更新
function updateProgressRing(step) {
  const ring = document.getElementById('progressRing');
  const total = 4;
  const offset = 157 - (157 * (step / total));
  ring.style.strokeDashoffset = offset;
}

// ---------- 初始化 ----------
window.addEventListener('load', () => {
  initTimer();
  generateTodayTask();
});
