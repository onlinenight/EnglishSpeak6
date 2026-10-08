// ============================================
// app.js - 核心逻辑 (百度TTS语音合成 + 百度短语音识别)
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
  return { completedDays: [], xp: 0, streak: 0, lastDate: null, currentDay: 1, reviewData: [], chatHistory: [], dailyTimeSpent: {}, uncompleted: [] };
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

// ---------- 语音识别（百度ASR） ----------
let isRecording = false;
let recordingTimeout = null;
let currentStepIndex = 0;
let currentSentenceIndex = 0;
let lessonData = null;

// 百度ASR相关
let baiduToken = null;
let baiduTokenExpire = 0;

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
    body: JSON.stringify({
      format: 'wav',
      rate: 16000,
      channel: 1,
      cuid: 'speak6_user',
      token: token,
      dev_pid: CONFIG.baiduAsrDevPid, // 英语模型
      speech: base64,
      len: buffer.byteLength
    })
  });
  const data = await res.json();
  if (data.err_no === 0 && data.result && data.result[0]) return data.result[0];
  throw new Error('识别失败：' + (data.err_msg || JSON.stringify(data)));
}

// ---------- 录音逻辑（AudioContext采集PCM） ----------
let audioContext = null;
let scriptProcessor = null;
let mediaStream = null;
let audioChunks = [];

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

// ---------- TTS（百度语音合成） ----------
let ttsAudio = null;

async function speak(text) {
  // 如果用的是浏览器TTS
  if (CONFIG.ttsProvider === 'browser') {
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

  // 百度TTS
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
      ttsAudio.play().catch(() => resolve());
    });
  } catch (e) {
    console.error('百度TTS失败，降级到浏览器TTS:', e);
    // 降级
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = CONFIG.study.accent; u.rate = 0.85;
      u.onend = resolve; u.onerror = resolve;
      speechSynthesis.speak(u);
    });
  }
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

// ---------- 生成今日任务 ----------
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
返回JSON：{"goal":"今日目标","warmup":["句子1"],"core":["句子2","句子3"],"dialogue_prompt":"对话场景描述"}。只返回JSON。`;

  try {
    const raw = await askAI([{ role: 'system', content: '你是英语口语教练，只返回JSON。' }, { role: 'user', content: prompt }]);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    document.getElementById('dailyGoalText').textContent = data.goal || '完成今日拆解任务';
    
    lessonData = {
      warmup: data.warmup || ['Hello!'],
      core: data.core || ['My name is Li Ming.'],
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

async function loadStep(stepIndex) {
  currentStepIndex = stepIndex;
  const lessonTitle = document.getElementById('lessonTitle');
  const sentenceBox = document.getElementById('sentenceBox');
  const translationBox = document.getElementById('translationBox');
  const nextBtn = document.getElementById('nextSentenceBtn');
  const recordBtn = document.getElementById('recordBtn');
  const skipBtn = document.getElementById('skipBtn');
  
  nextBtn.style.display = 'none';
  recordBtn.style.display = 'flex';
  skipBtn.style.display = 'block';
  translationBox.textContent = '';
  document.getElementById('lessonStatus').textContent = '准备就绪';

  const jumpTo = STATE.jumpToSentence;
  if (jumpTo && jumpTo.step === stepIndex) {
    currentSentenceIndex = jumpTo.index;
    delete STATE.jumpToSentence;
    saveState(STATE);
  }

  if (stepIndex === 0) {
    lessonTitle.textContent = '关卡1：热身';
    skipBtn.style.display = 'none';
    const sentence = lessonData.warmup[currentSentenceIndex];
    sentenceBox.innerHTML = sentence;
    await startTTSAndRecord(sentence, 0);
  } else if (stepIndex === 1) {
    lessonTitle.textContent = '关卡2：核心句型';
    const sentence = lessonData.core[currentSentenceIndex];
    sentenceBox.innerHTML = sentence;
    await startTTSAndRecord(sentence, 1);
  } else if (stepIndex === 2) {
    lessonTitle.textContent = '关卡3：情景对话';
    sentenceBox.innerHTML = '💬 ' + lessonData.dialogue;
    translationBox.textContent = '请点击下方麦克风，与AI自由对话';
    recordBtn.style.display = 'flex';
    skipBtn.style.display = 'none';
    document.getElementById('nextSentenceBtn').style.display = 'none';
    document.getElementById('lessonStatus').textContent = '点击麦克风开始对话';
  } else if (stepIndex === 3) {
    showSettlement(3);
  }
}

// TTS自动播放 + 自动录音
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

// ---------- 录音逻辑 ----------
async function startRecordingSession(stepIndex) {
  if (isRecording) return;
  isRecording = true;
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('waveform').classList.add('active');
  document.getElementById('lessonStatus').textContent = '录音中... 请朗读';
  
  try {
    await startRecording();
    
    // 6秒超时自动停止
    recordingTimeout = setTimeout(async () => {
      if (isRecording) {
        await endRecordingSession();
      }
    }, 6000);
  } catch (e) {
    isRecording = false;
    document.getElementById('recordBtn').classList.remove('recording');
    document.getElementById('waveform').classList.remove('active');
    document.getElementById('lessonStatus').textContent = '麦克风权限被拒绝：' + e.message;
  }
}

async function endRecordingSession() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(recordingTimeout);
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('waveform').classList.remove('active');
  document.getElementById('lessonStatus').innerHTML = '<span class="loading"></span> 识别中...';

  try {
    const blob = await stopRecording();
    const text = await baiduASR(blob);
    evaluateSpeech(text, currentStepIndex);
  } catch (e) {
    document.getElementById('lessonStatus').textContent = '识别失败：' + e.message;
  }
}

// 录音按钮点击
document.getElementById('recordBtn').addEventListener('click', async () => {
  if (isRecording) {
    await endRecordingSession();
  } else {
    startRecordingSession(currentStepIndex);
  }
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

// ---------- 关卡结算面板 ----------
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
  initTimer();
  generateTodayTask();
});
