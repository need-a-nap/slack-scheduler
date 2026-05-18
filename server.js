/**
 * Slack Scheduler Bot - Backend (v3: OAuth user token support)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SLACK_BOT_TOKEN;
const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const TZ = process.env.TZ || 'Asia/Seoul';
process.env.TZ = TZ;

if (!TOKEN || !TOKEN.startsWith('xoxb-')) {
  console.error('\n❌ SLACK_BOT_TOKEN 이(가) 설정되지 않았습니다.');
  console.error('   .env 파일을 만들고 SLACK_BOT_TOKEN=xoxb-... 형식으로 입력해주세요.\n');
  process.exit(1);
}

const slack = new WebClient(TOKEN);

// ───── Storage ────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'schedules.json');
const LOG_FILE = path.join(__dirname, 'send_log.json');
const USER_CONFIG_FILE = path.join(__dirname, 'user_config.json');

const loadJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const saveJSON = (file, data) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

let schedules = loadJSON(DATA_FILE, []);
let sendLog = loadJSON(LOG_FILE, []);
// { userToken, userId, userName, userAvatar } — 내 계정 연동 정보
let userConfig = loadJSON(USER_CONFIG_FILE, null);

// One-time migration of old single-target schedules
let migrated = 0;
schedules = schedules.map((s) => {
  if (!s.targets && s.targetName) {
    migrated++;
    return {
      ...s,
      scheduleType: 'recurring',
      targets: [{
        type: s.targetType === 'dm' ? 'user' : 'channel',
        id: s.targetName,
        name: s.targetName,
      }],
    };
  }
  return s;
});
const persistSchedules = () => saveJSON(DATA_FILE, schedules);
const persistLog = () => saveJSON(LOG_FILE, sendLog.slice(-500));
if (migrated > 0) persistSchedules();

// ───── Slack list caches ──────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000;
let channelCache = { data: null, at: 0 };
let userCache = { data: null, at: 0 };

async function fetchChannels() {
  const out = [];
  let cursor;
  do {
    const r = await slack.conversations.list({
      cursor,
      limit: 1000,
      types: 'public_channel,private_channel',
      exclude_archived: true,
    });
    for (const c of r.channels) {
      out.push({ id: c.id, name: c.name, isPrivate: c.is_private, isMember: c.is_member });
    }
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function fetchUsers() {
  const out = [];
  let cursor;
  do {
    const r = await slack.users.list({ cursor, limit: 1000 });
    for (const u of r.members) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      out.push({
        id: u.id,
        name: u.name,
        displayName: u.profile?.display_name_normalized || u.real_name_normalized || u.real_name || u.name,
        realName: u.real_name_normalized || u.real_name || '',
        avatar: u.profile?.image_32 || null,
      });
    }
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
  return out;
}

// ───── Sender 선택 ────────────────────────────────────────────
function getClientForSender(senderType) {
  if (senderType === 'user' && userConfig?.userToken) {
    return new WebClient(userConfig.userToken);
  }
  return slack;
}

// ───── Express ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/auth', async (_req, res) => {
  try {
    const r = await slack.auth.test();
    res.json({ ok: true, team: r.team, botName: r.user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.data?.error || err.message });
  }
});

// ───── OAuth (내 계정으로 발송) ───────────────────────────────
const pendingStates = new Set();

app.get('/api/auth/slack', (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.redirect('/?auth_error=' + encodeURIComponent('SLACK_CLIENT_ID 또는 SLACK_REDIRECT_URI 환경변수가 설정되지 않았습니다. .env 파일을 확인해주세요.'));
  }
  const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    user_scope: 'chat:write,im:write',
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

app.get('/slack/oauth_redirect', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Slack OAuth 거부됨:', error);
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }
  if (!state || !pendingStates.has(state)) {
    return res.redirect('/?auth_error=invalid_state');
  }
  pendingStates.delete(state);

  try {
    const result = await slack.oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });

    if (!result.ok) throw new Error(result.error || 'OAuth 실패');

    const userId = result.authed_user?.id;
    const userToken = result.authed_user?.access_token;
    if (!userToken) throw new Error('사용자 토큰을 받지 못했습니다.');

    let userName = userId;
    let userAvatar = null;
    try {
      const info = await slack.users.info({ user: userId });
      const profile = info.user?.profile;
      userName = profile?.display_name_normalized || info.user?.real_name_normalized || info.user?.real_name || userId;
      userAvatar = profile?.image_48 || null;
    } catch {}

    userConfig = { userToken, userId, userName, userAvatar };
    saveJSON(USER_CONFIG_FILE, userConfig);
    console.log(`✅ OAuth 연동 완료 — @${userName}`);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth 실패:', err?.data?.error || err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err?.data?.error || err.message)}`);
  }
});

app.get('/api/auth/session', (req, res) => {
  if (!userConfig?.userToken) return res.json({ connected: false });
  res.json({
    connected: true,
    userId: userConfig.userId,
    userName: userConfig.userName,
    userAvatar: userConfig.userAvatar,
  });
});

app.post('/api/auth/logout', (req, res) => {
  userConfig = null;
  try { fs.unlinkSync(USER_CONFIG_FILE); } catch {}
  res.json({ ok: true });
});

// ───── Slack lists ────────────────────────────────────────────
app.get('/api/slack/channels', async (req, res) => {
  try {
    if (req.query.refresh || !channelCache.data || Date.now() - channelCache.at > CACHE_TTL) {
      channelCache = { data: await fetchChannels(), at: Date.now() };
    }
    res.json(channelCache.data);
  } catch (err) {
    res.status(500).json({ error: err?.data?.error || err.message });
  }
});

app.get('/api/slack/users', async (req, res) => {
  try {
    if (req.query.refresh || !userCache.data || Date.now() - userCache.at > CACHE_TTL) {
      userCache = { data: await fetchUsers(), at: Date.now() };
    }
    res.json(userCache.data);
  } catch (err) {
    res.status(500).json({ error: err?.data?.error || err.message });
  }
});

// ───── Schedules CRUD ─────────────────────────────────────────
app.get('/api/schedules', (_req, res) => {
  res.json([...schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/schedules', (req, res) => {
  const {
    scheduleType,
    targets,
    messageText,
    date,
    startDate,
    endDate,
    time,
    daysOfWeek,
    senderType,
  } = req.body || {};

  if (!['once', 'recurring'].includes(scheduleType))
    return res.status(400).json({ error: '예약 종류가 잘못되었습니다.' });
  if (!Array.isArray(targets) || targets.length === 0)
    return res.status(400).json({ error: '받는 대상을 최소 1명/1채널 선택해주세요.' });
  if (!messageText) return res.status(400).json({ error: '메시지 내용을 입력해주세요.' });
  if (!time) return res.status(400).json({ error: '전송 시간을 입력해주세요.' });

  if (scheduleType === 'once') {
    if (!date) return res.status(400).json({ error: '날짜를 선택해주세요.' });
  } else {
    if (!startDate || !endDate)
      return res.status(400).json({ error: '시작일/종료일을 선택해주세요.' });
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0)
      return res.status(400).json({ error: '반복 요일을 선택해주세요.' });
    if (endDate < startDate)
      return res.status(400).json({ error: '종료일이 시작일보다 빠를 수 없습니다.' });
  }

  const resolvedSenderType = senderType === 'user' && userConfig?.userToken ? 'user' : 'bot';

  const cleanTargets = targets.map((t) => ({
    type: t.type === 'user' ? 'user' : 'channel',
    id: String(t.id),
    name: String(t.name),
  }));

  const newSchedule = {
    id: Date.now().toString(),
    scheduleType,
    targets: cleanTargets,
    messageText,
    time,
    senderType: resolvedSenderType,
    senderName: resolvedSenderType === 'user' ? (userConfig?.userName || null) : null,
    ...(scheduleType === 'once' ? { date } : { startDate, endDate, daysOfWeek }),
    status: 'active',
    createdAt: new Date().toISOString(),
    sentCount: 0,
    lastSentAt: null,
  };
  schedules.push(newSchedule);
  persistSchedules();
  res.json(newSchedule);
});

app.patch('/api/schedules/:id', (req, res) => {
  const s = schedules.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const { messageText, targets, time, date, startDate, endDate, daysOfWeek, scheduleType, senderType } = req.body;

  if (messageText !== undefined) s.messageText = messageText;
  if (time !== undefined) s.time = time;
  if (scheduleType !== undefined) s.scheduleType = scheduleType;
  if (targets !== undefined) {
    s.targets = targets.map((t) => ({
      type: t.type === 'user' ? 'user' : 'channel',
      id: String(t.id),
      name: String(t.name),
    }));
  }
  if (senderType !== undefined) {
    s.senderType = senderType === 'user' && userConfig?.userToken ? 'user' : 'bot';
    s.senderName = s.senderType === 'user' ? (userConfig?.userName || null) : null;
  }
  if (date !== undefined) s.date = date;
  if (startDate !== undefined) s.startDate = startDate;
  if (endDate !== undefined) s.endDate = endDate;
  if (daysOfWeek !== undefined) s.daysOfWeek = daysOfWeek;

  // 완료된 일회성 예약을 수정하면 다시 활성화
  if (s.status === 'completed') {
    s.status = 'active';
    s.lastSentAt = null;
  }

  persistSchedules();
  res.json(s);
});

app.patch('/api/schedules/:id/skip-dates', (req, res) => {
  const s = schedules.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const { action, date } = req.body;
  if (!date) return res.status(400).json({ error: '날짜를 입력해주세요.' });

  if (!s.skipDates) s.skipDates = [];

  if (action === 'add') {
    if (!s.skipDates.includes(date)) s.skipDates.push(date);
    s.skipDates.sort();
  } else if (action === 'remove') {
    s.skipDates = s.skipDates.filter((d) => d !== date);
  } else {
    return res.status(400).json({ error: 'action은 add 또는 remove여야 합니다.' });
  }

  persistSchedules();
  res.json({ skipDates: s.skipDates });
});

app.delete('/api/schedules/:id', (req, res) => {
  const before = schedules.length;
  schedules = schedules.filter((s) => s.id !== req.params.id);
  if (schedules.length === before) return res.status(404).json({ error: 'Not found' });
  persistSchedules();
  res.json({ ok: true });
});

app.patch('/api/schedules/:id/toggle', (req, res) => {
  const s = schedules.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status === 'completed')
    return res.status(400).json({ error: '이미 발송 완료된 일회성 예약입니다.' });
  s.status = s.status === 'active' ? 'paused' : 'active';
  persistSchedules();
  res.json({ status: s.status });
});

app.post('/api/test-send', async (req, res) => {
  const { targets, messageText, senderType } = req.body || {};
  if (!Array.isArray(targets) || targets.length === 0)
    return res.status(400).json({ error: '받는 대상을 선택해주세요.' });

  const client = getClientForSender(senderType);
  const results = [];
  for (const t of targets) {
    try {
      await client.chat.postMessage({
        channel: t.id,
        text: `🧪 *테스트 메시지*\n${messageText || '(내용 없음)'}`,
      });
      results.push({ target: t.name, success: true });
    } catch (err) {
      results.push({ target: t.name, success: false, error: err?.data?.error || err.message });
    }
  }
  const failed = results.filter((r) => !r.success);
  if (failed.length === results.length)
    return res.status(500).json({ ok: false, error: '모든 대상에 전송 실패', results });
  res.json({ ok: failed.length === 0, results });
});

// ───── Sender ────────────────────────────────────────────────
async function sendScheduledMessage(s) {
  const client = getClientForSender(s.senderType);
  let okCount = 0;

  for (const t of s.targets) {
    try {
      await client.chat.postMessage({ channel: t.id, text: s.messageText });
      okCount++;
    } catch (err) {
      const msg = err?.data?.error || err.message;
      sendLog.push({
        scheduleId: s.id,
        target: t.name,
        sentAt: new Date().toISOString(),
        success: false,
        error: msg,
      });
      console.error(
        `[${new Date().toLocaleString('ko-KR')}] ❌ ${t.type === 'channel' ? '#' : '@'}${t.name}: ${msg}`
      );
    }
  }

  const now = new Date().toISOString();
  if (okCount > 0) {
    s.sentCount = (s.sentCount || 0) + 1;
    s.lastSentAt = now;
    sendLog.push({
      scheduleId: s.id,
      sentAt: now,
      success: true,
      okCount,
      total: s.targets.length,
      senderType: s.senderType,
    });
    console.log(
      `[${new Date().toLocaleString('ko-KR')}] ✅ 발송 ${okCount}/${s.targets.length} (${s.senderType === 'user' ? `@${s.senderName || 'user'}` : 'bot'}) — "${s.messageText.substring(0, 30)}..."`
    );
  }
  if (s.scheduleType === 'once') s.status = 'completed';
  persistSchedules();
  persistLog();
}

// ───── Tick ──────────────────────────────────────────────────
function tick() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayDate = `${yyyy}-${mm}-${dd}`;
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const currentTime = `${hh}:${mi}`;
  const currentDay = String(now.getDay());

  for (const s of schedules) {
    if (s.status !== 'active') continue;
    if (s.time !== currentTime) continue;

    if (s.scheduleType === 'once') {
      if (s.date !== todayDate) continue;
      if (s.lastSentAt) continue;
    } else {
      if (todayDate < s.startDate || todayDate > s.endDate) continue;
      if (!s.daysOfWeek.includes(currentDay)) continue;
      if (s.skipDates?.includes(todayDate)) continue;
      if (s.lastSentAt) {
        const last = new Date(s.lastSentAt);
        const lastDate = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
        const lastTime = `${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}`;
        if (lastDate === todayDate && lastTime === currentTime) continue;
      }
    }
    sendScheduledMessage(s);
  }
}
cron.schedule('* * * * *', tick);

app.listen(PORT, () => {
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│      🤖 Slack Scheduler 가 실행 중입니다     │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  URL:      http://localhost:${PORT}            │`);
  console.log(`│  Timezone: ${TZ.padEnd(33)}│`);
  console.log(`│  Storage:  schedules.json (${schedules.length}건 로드됨)`);
  console.log('└─────────────────────────────────────────────┘\n');

  if (userConfig?.userName) {
    console.log(`👤 연동된 계정: @${userConfig.userName}\n`);
  }

  slack.auth
    .test()
    .then((r) => console.log(`✅ Slack 연결됨 — workspace: ${r.team}, bot: @${r.user}\n`))
    .catch((e) =>
      console.error('❌ Slack 인증 실패:', e?.data?.error || e.message, '\n   토큰을 다시 확인해주세요.\n')
    );
});
