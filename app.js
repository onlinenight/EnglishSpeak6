// ============================================
// app.js - 核心逻辑 (状态机 + 原生识别 + 百度TTS + 闭环复习)
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
  return { completedDays: [], xp: 0, streak: 0, lastDate: null, currentDay: 1, reviewData: [], dailyTimeSpent: {}, uncompleted: [] };
}

function saveState(state) { localStorage.setItem('speak6_state', JSON.stringify(state)); }
let STATE = loadState();
if (!STATE.dailyTimeSpent) STATE.dailyTimeSpent = {};
if (!STATE.uncompleted) STATE.uncompleted = [];

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

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ---------- 计时器 ----------
let timerInterval = null;
function initTimer() {
  const todayStr = today();
  if (!STATE.dailyTimeSpent[todayStr]) STATE.dailyTimeSpent[todayStr] = 0;
  updateTimerUI();
  
  timerInterval = setInterval(() => {
    if (document.hidden) return;
    STATE.dailyTimeSpent[todayStr] += 1;
    saveState(STATE);
    updateTimerUI();
  }, 1000);
}

function updateTimerUI() {
  const todayStr = today();
  const seconds = STATE.dailyTimeSpent[todayStr] || 0;
  const minutes = (seconds / 60).toFixed(1);
  const target = CONFIG.study.dailyMinutes;
  const pct = Math.min(100, (minutes / target) * 100);
  
  document.getElementById('timerText').textContent = `${minutes} / ${target} 分钟`;
  document.getElementById('timerBarFill').style.width = pct + '%';
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

// ---------- 语音识别（回归原生 Web Speech API，稳定可靠） ----------
let recognition = null;
let isRecording = false;
let recordingTimeout = null;
let currentStepIndex = 0;
let currentSentenceIndex = 0;
let lessonData = null;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-GB';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
}

// ---------- TTS（百度语音合成 + 降级容错） ----------
let ttsAudio = null;

async function speak(text) {
  if (CONFIG.ttsProvider === 'baidu') {
    try {
      const res = await fetch(`${CONFIG.proxyUrl}?path=baidu-tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, per: CONFIG.baiduTtsPer, spd: 5, pit: 5 })
      });

      if (!res.ok) throw new Error('TTS请求失败');

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      
      return new Promise((resolve) => {
        if (ttsAudio) { ttsAudio.pause(); URL.revokeObjectURL(ttsAudio.src); }
        ttsAudio = new Audio(audioUrl);
        ttsAudio.onended = () => { resolve(); };
        ttsAudio.onerror = () => { resolve(); };
        
        const playPromise = ttsAudio.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => {
            console.warn('自动播放被拦截，降级到浏览器TTS');
            fallbackSpeak(text).then(resolve);
          });
        }
      });
    } catch (e) {
      console.error('百度TTS失败，降级:', e);
    }
  }
  return fallbackSpeak(text);
}

function fallbackSpeak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = CONFIG.study.accent; u.rate = 0.85;
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

// ---------- 生成今日任务（带音标） ----------
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
今天是第${dayNum}天，主题：${info.month.title}，今日任务：${info.day}。
请将今日任务拆解为3个关卡：
关卡1：热身（1句）
关卡2：核心句型（2句）
关卡3：情景对话（1段文字描述）
返回JSON：{"goal":"今日目标","warmup":[{"en":"句子1","phonetic":"/音标/","cn":"翻译"}],"core":[{"en":"句子2","phonetic":"/音标/","cn":"翻译"}],"dialogue_prompt":"对话场景描述"}。只返回JSON。`;

  try {
    const raw = await askAI([{ role: 'system', content: '你是英语口语教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    document.getElementById('dailyGoalText').textContent = data.goal || '完成今日拆解任务';
    
    lessonData = {
      warmup: data.warmup || [{en:'Hello!', phonetic:'/həˈloʊ/', cn:'你好'}],
      core: data.core || [{en:'My name is Li Ming.', phonetic:'/maɪ neɪm ɪz liː mɪŋ/', cn:'我叫李明'}],
      dialogue: data.dialogue_prompt || 'Let\'s have a chat.'
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
  initTimer();
});

// 状态机控制：播放原声 -> 准备录音 -> 录音中 -> 识别中 -> 反馈
async function loadStep(stepIndex) {
  currentStepIndex = stepIndex;
  const lessonTitle = document.getElementById('lessonTitle');
  const sentenceBox = document.getElementById('sentenceBox');
  const phoneticBox = document.getElementById('phoneticBox');
  const translationBox = document.getElementById('translationBox');
  const nextBtn = document.getElementById('nextSentenceBtn');
  const recordBtn = document.getElementById('recordBtn');
  const skipBtn = document.getElementById('skipBtn');
  
  nextBtn.style.display = 'none';
  recordBtn.style.display = 'flex';
  skipBtn.style.display = 'block';
  document.getElementById('lessonStatus').textContent = '准备就绪';
  document.getElementById('tipsText').textContent = '';

  // 检查是否从复习页跳转
  const jumpTo = STATE.jumpToSentence;
  if (jumpTo && jumpTo.step === stepIndex) {
    currentSentenceIndex = jumpTo.index;
    delete STATE.jumpToSentence;
    saveState(STATE);
  }

  let sentenceObj = null;
  if (stepIndex === 0) {
    lessonTitle.textContent = '关卡1：热身';
    skipBtn.style.display = 'none';
    sentenceObj = lessonData.warmup[currentSentenceIndex];
  } else if (stepIndex === 1) {
    lessonTitle.textContent = '关卡2：核心句型';
    sentenceObj = lessonData.core[currentSentenceIndex];
  } else if (stepIndex === 2) {
    lessonTitle.textContent = '关卡3：情景对话';
    sentenceBox.innerHTML = '💬 ' + lessonData.dialogue;
    phoneticBox.textContent = '';
    translationBox.textContent = '请点击下方麦克风，与AI自由对话';
    recordBtn.style.display = 'flex';
    skipBtn.style.display = 'none';
    document.getElementById('nextSentenceBtn').style.display = 'none';
    document.getElementById('lessonStatus').textContent = '点击麦克风开始对话';
    return;
  } else if (stepIndex === 3) {
    showSettlement(3);
    return;
  }

  // 展示句子
  sentenceBox.innerHTML = sentenceObj.en;
  phoneticBox.textContent = sentenceObj.phonetic || '';
  translationBox.textContent = sentenceObj.cn || '';
  
  // 自动播放一遍并开始录音
  await startTTSAndRecord(sentenceObj.en, stepIndex);
}

// TTS播放 + 自动开始录音
async function startTTSAndRecord(sentence, stepIndex) {
  const statusText = document.getElementById('lessonStatus');
  statusText.textContent = '请听标准发音...';
  await speak(sentence);
  
  statusText.textContent = '准备跟读...';
  setTimeout(() => {
    if (isRecording) return;
    startRecordingSession(stepIndex);
  }, 800);
}

// ---------- 原生录音逻辑 ----------
async function startRecordingSession(stepIndex) {
  if (isRecording || !recognition) return;
  isRecording = true;
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('waveform').classList.add('active');
  document.getElementById('lessonStatus').textContent = '录音中... 请朗读';
  
  recognition.onresult = (e) => {
    clearTimeout(recordingTimeout);
    const userSpeech = e.results[0][0].transcript;
    stopRecordingUI();
    evaluateSpeech(userSpeech, stepIndex);
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

  try {
    recognition.start();
    // 6秒超时兜底，防止卡死
    recordingTimeout = setTimeout(() => {
      if (isRecording) {
        recognition.stop();
        stopRecordingUI();
        showToast('未识别到声音，请重试');
      }
    }, 6000);
  } catch (e) {
    isRecording = false;
    document.getElementById('recordBtn').classList.remove('recording');
    document.getElementById('waveform').classList.remove('active');
    document.getElementById('lessonStatus').textContent = '麦克风权限被拒绝：' + e.message;
  }
}

function stopRecordingUI() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(recordingTimeout);
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('waveform').classList.remove('active');
  document.getElementById('lessonStatus').innerHTML = '<span class="loading"></span> 识别中...';
}

// 录音按钮点击
document.getElementById('recordBtn').addEventListener('click', () => {
  if (isRecording) {
    recognition.stop();
  } else {
    startRecordingSession(currentStepIndex);
  }
});

// 重听按钮
document.getElementById('listenBtn').addEventListener('click', async () => {
  const sentenceBox = document.getElementById('sentenceBox');
  const originalText = sentenceBox.textContent.replace('💬 ', '').replace('🎉 ', '');
  await speak(originalText);
});

// ---------- 三维打分 + 异步AI纠错 ----------
function evaluateSpeech(userSpeech, stepIndex) {
  const sentenceBox = document.getElementById('sentenceBox');
  const originalText = sentenceBox.textContent.replace('💬 ', '').replace('🎉 ', '');
  
  const targetWords = originalText.split(' ');
  const speechWords = userSpeech.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  
  let matchCount = 0;
  const highlightedHTML = targetWords.map(w => {
    const cleanW = w.toLowerCase().replace(/[^a-z]/g, '');
    const isGood = speechWords.includes(cleanW);
    if (isGood) matchCount++;
    return `<span class="word ${isGood ? 'good' : 'bad'}">${w}</span>`;
  }).join(' ');
  
  const accuracy = Math.round((matchCount / targetWords.length) * 100);
  const completeness = Math.round((speechWords.length / targetWords.length) * 100);
  
  sentenceBox.innerHTML = highlightedHTML;
  document.getElementById('lessonStatus').innerHTML = `准确度：${accuracy}% · 完整度：${completeness}%<br><span class="loading"></span> AI正在分析流利度...`;

  askAI([{ role: 'system', content: '你是英语发音教练，只返回JSON。' }, { role: 'user', content: `学生跟读："${originalText}"，识别文本："${userSpeech}"。请给出发音纠错建议，并给流利度打分（0-100）。返回JSON：{"feedback":"建议","fluency":0-100}` }])
    .then(raw => {
      const jsonStr = raw.replace(/```json|```/g, '').trim();
      const aiData = JSON.parse(jsonStr);
      const fluency = aiData.fluency || 70;
      
      const totalScore = (accuracy + completeness + fluency) / 3;
      let stars = 0;
      if (totalScore >= 90) stars = 3;
      else if (totalScore >= 70) stars = 2;
      else if (totalScore >= 50) stars = 1;
      
      document.getElementById('lessonStatus').innerHTML = `准确度：${accuracy}% · 完整度：${completeness}% · 流利度：${fluency}%<br>${aiData.feedback}`;
      document.getElementById('tipsText').textContent = aiData.feedback ? '' : '点击重听标准发音，再试一次';
      
      STATE.lastStars = stars;
      saveState(STATE);
      
      document.getElementById('nextSentenceBtn').style.display = 'block';
    })
    .catch(() => {
      const fluency = 70;
      const totalScore = (accuracy + completeness + fluency) / 3;
      let stars = 0;
      if (totalScore >= 90) stars = 3;
      else if (totalScore >= 70) stars = 2;
      else if (totalScore >= 50) stars = 1;
      STATE.lastStars = stars;
      saveState(STATE);
      
      document.getElementById('lessonStatus').innerHTML = `准确度：${accuracy}% · 完整度：${completeness}%<br>AI纠错暂时不可用。`;
      document.getElementById('nextSentenceBtn').style.display = 'block';
    });
}

// 跳过此句
document.getElementById('skipBtn').addEventListener('click', () => {
  const sentenceBox = document.getElementById('sentenceBox');
  const originalText = sentenceBox.textContent.replace('💬 ', '').replace('🎉 ', '');
  STATE.uncompleted.push({ day: getStudyDay(), step: currentStepIndex, index: currentSentenceIndex, text: originalText });
  saveState(STATE);
  showToast('已记录为未完成，可在“复习”中重学');
  goToNextSentence();
});

// 下一句
document.getElementById('nextSentenceBtn').addEventListener('click', goToNextSentence);

function goToNextSentence() {
  if (currentStepIndex === 0) {
    if (currentSentenceIndex < lessonData.warmup.length - 1) {
      currentSentenceIndex++;
      loadStep(0);
    } else {
      showSettlement(0);
    }
  } else if (currentStepIndex === 1) {
    if (currentSentenceIndex < lessonData.core.length - 1) {
      currentSentenceIndex++;
      loadStep(1);
    } else {
      showSettlement(1);
    }
  }
}

// ---------- 关卡结算面板（星级评价） ----------
function showSettlement(stepIndex) {
  const panel = document.getElementById('settlementPanel');
  const title = document.getElementById('settlementTitle');
  const desc = document.getElementById('settlementDesc');
  const starRow = document.getElementById('starRow');
  
  if (stepIndex === 3) {
    title.textContent = '🎉 今日挑战完成！';
    desc.textContent = '你已经完成了所有关卡，太棒了！';
    starRow.innerHTML = '<span class="star filled">★</span><span class="star filled">★</span><span class="star filled">★</span>';
    document.getElementById('continueBtn').textContent = '完成打卡';
    document.getElementById('continueBtn').onclick = () => {
      panel.classList.remove('show');
      document.getElementById('finishBtn').click();
      document.getElementById('closeLessonBtn').click();
    };
  } else {
    title.textContent = stepIndex === 0 ? '关卡1 完成！' : '关卡2 完成！';
    desc.textContent = '继续加油，保持这个节奏！';
    const stars = STATE.lastStars || 1;
    starRow.innerHTML = Array.from({ length: 3 }, (_, i) => 
      `<span class="star ${i < stars ? 'filled' : ''}">★</span>`
    ).join('');
    document.getElementById('continueBtn').textContent = '继续闯关 →';
    document.getElementById('continueBtn').onclick = () => {
      panel.classList.remove('show');
      if (stepIndex === 0) {
        currentSentenceIndex = 0;
        loadStep(1);
      } else if (stepIndex === 1) {
        currentSentenceIndex = 0;
        loadStep(2);
      }
    };
  }
  
  panel.classList.add('show');
}

// ---------- 历史记录与未完成 ----------
function renderHistory() {
  const list = document.getElementById('historyList');
  if (!STATE.completedDays || STATE.completedDays.length === 0) { list.innerHTML = '暂无记录，去完成今天的任务吧！'; return; }
  list.innerHTML = STATE.completedDays.map(d => `<div style="padding:8px 0; border-bottom:1px solid #eee;">Day ${d} 完成打卡</div>`).join('');

  const uncompletedList = document.getElementById('uncompletedList');
  if (STATE.uncompleted.length === 0) { uncompletedList.innerHTML = '太棒了，没有未完成的句子！'; return; }
  
  const uniqueMap = new Map();
  STATE.uncompleted.forEach((item, index) => {
    if (!uniqueMap.has(item.text)) uniqueMap.set(item.text, { ...item, originalIndex: index });
  });
  
  uncompletedList.innerHTML = Array.from(uniqueMap.values()).map(item => `
    <div style="padding:8px 0; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
      <span style="color:#e53e3e; font-size:13px;">${item.text}</span>
      <button class="btn btn-secondary" style="width:auto; padding:6px 12px; margin:0; font-size:12px;" onclick="relearnSentence('${item.text.replace(/'/g, "\\'")}', ${item.step}, ${item.index})">重学</button>
    </div>
  `).join('');
}

// 闭环复习：精准跳转到未完成句子
function relearnSentence(text, step, index) {
  if (!lessonData) { showToast('今日任务正在加载，请稍后再试'); return; }
  STATE.jumpToSentence = { step: step, index: index };
  saveState(STATE);
  document.querySelector('.nav-item[data-view="view-today"]').click();
  document.getElementById('view-lesson').classList.add('active');
  loadStep(step);
  showToast('已为你定位到该句，请重新跟读');
}

// ---------- 导出 / 导入 / 重置 ----------
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
  if (confirm('确定要重置所有进度吗？')) { localStorage.removeItem('speak6_state'); location.reload(); }
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

window.addEventListener('load', () => {
  // iOS 解锁音频播放：添加一次性点击事件
  document.body.addEventListener('click', function unlockAudio() {
    const audio = new Audio();
    audio.play().catch(() => {});
    document.body.removeEventListener('click', unlockAudio);
  }, { once: true });

  initTimer();
  generateTodayTask();
});
