/**
 * Slack Scheduler Bot - Backend (v4: per-user accounts + session auth)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

console.log('[ENV] SLACK_BOT_TOKEN:', TOKEN ? TOKEN.substring(0, 10) + '...' : '❌ 없음');
console.log('[ENV] SLACK_CLIENT_ID:', CLIENT_ID ? CLIENT_ID.substring(0, 6) + '...' : '❌ 없음');
console.log('[ENV] SLACK_REDIRECT_URI:', REDIRECT_URI || '❌ 없음');

if (!TOKEN || !TOKEN.startsWith('xoxb-')) {
  console.error('\n❌ SLACK_BOT_TOKEN 이(가) 설정되지 않았습니다.');
  console.error('   .env 파일을 만들고 SLACK_BOT_TOKEN=xoxb-... 형식으로 입력해주세요.\n');
  process.exit(1);
}

const slack = new WebClient(TOKEN);
const SESSION_COOKIE = 'ss_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// ───── Storage ────────────────────────────────────────────────
// 영구 저장 디렉터리 (Railway Volume 등). 미지정 시 프로젝트 루트 사용.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 쓰기 권한 검증
  const probe = path.join(DATA_DIR, '.write_test');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  console.log(`[DATA] 영구 저장 디렉터리: ${DATA_DIR}`);
} catch (e) {
  console.error(`[DATA] ❌ ${DATA_DIR} 디렉터리에 쓸 수 없습니다:`, e.message);
  process.exit(1);
}

const DATA_FILE = path.join(DATA_DIR, 'schedules.json');
const LOG_FILE = path.join(DATA_DIR, 'send_log.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OLD_USER_CONFIG_FILE = path.join(DATA_DIR, 'user_config.json');

// 일회성 마이그레이션: DATA_DIR이 새로 지정되어 있고 그 안에 데이터가 없지만
// 프로젝트 루트(__dirname)에 기존 데이터가 있다면 한 번만 옮긴다.
if (DATA_DIR !== __dirname) {
  for (const fn of ['schedules.json', 'send_log.json', 'users.json', 'user_config.json']) {
    const src = path.join(__dirname, fn);
    const dst = path.join(DATA_DIR, fn);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
        console.log(`[DATA] 마이그레이션: ${fn} → ${DATA_DIR}`);
      } catch (e) {
        console.error(`[DATA] 마이그레이션 실패 (${fn}):`, e.message);
      }
    }
  }
}

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
let users = loadJSON(USERS_FILE, {}); // { [userId]: { userId, userName, userAvatar, userToken, sessionToken, ... } }

const persistSchedules = () => saveJSON(DATA_FILE, schedules);
const persistLog = () => saveJSON(LOG_FILE, sendLog.slice(-500));
const persistUsers = () => saveJSON(USERS_FILE, users);

// ───── Migration (v3 → v4) ────────────────────────────────────
(function migrate() {
  // user_config.json (single user) → users.json (keyed by userId)
  const oldConfig = loadJSON(OLD_USER_CONFIG_FILE, null);
  if (oldConfig?.userId && oldConfig?.userToken && !users[oldConfig.userId]) {
    users[oldConfig.userId] = {
      userId: oldConfig.userId,
      userName: oldConfig.userName,
      userAvatar: oldConfig.userAvatar,
      userToken: oldConfig.userToken,
      sessionToken: null,
      createdAt: new Date().toISOString(),
    };
    persistUsers();
    console.log(`✅ 이전 사용자 설정 마이그레이션 완료 — @${oldConfig.userName}`);

    // Assign existing schedules without ownerId to this user
    let migrated = 0;
    for (const s of schedules) {
      if (!s.ownerId) { s.ownerId = oldConfig.userId; migrated++; }
    }
    if (migrated > 0) {
      persistSchedules();
      console.log(`✅ 기존 예약 ${migrated}건을 @${oldConfig.userName} 소유로 이전`);
    }
    try { fs.unlinkSync(OLD_USER_CONFIG_FILE); } catch {}
  }

  // Legacy single-target schedule migration
  let targetMigrated = 0;
  schedules = schedules.map((s) => {
    if (!s.targets && s.targetName) {
      targetMigrated++;
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
  if (targetMigrated > 0) persistSchedules();
})();

// ───── Session / Auth ─────────────────────────────────────────
function getUserBySession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  if (!token) return null;
  for (const u of Object.values(users)) {
    if (u.sessionToken === token) return u;
  }
  return null;
}

function requireAuth(req, res, next) {
  const user = getUserBySession(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function findMySchedule(req) {
  return schedules.find((s) => s.id === req.params.id && s.ownerId === req.user.userId);
}

// ───── Slack list caches (workspace-wide, shared OK) ──────────
const CACHE_TTL = 5 * 60 * 1000;
let channelCache = { data: null, at: 0 };
let userCache = { data: null, at: 0 };

async function fetchChannels() {
  const out = [];
  let cursor;
  do {
    const r = await slack.conversations.list({
      cursor, limit: 1000,
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
function getClientForSchedule(s) {
  if (s.senderType === 'user') {
    const owner = users[s.ownerId];
    if (owner?.userToken) return new WebClient(owner.userToken);
  }
  return slack;
}

function getClientForUser(user, senderType) {
  if (senderType === 'user' && user?.userToken) {
    return new WebClient(user.userToken);
  }
  return slack;
}

// ───── 개인화 변수 치환 ──────────────────────────────────────
// {이름} / {name} → 받는 사람 이름으로 치환 (DM 대상에 한함)
function personalize(text, target) {
  if (!text) return text;
  if (target?.type === 'user') {
    const name = target.name || '';
    return text.replace(/\{이름\}/g, name).replace(/\{name\}/gi, name);
  }
  // 채널: 변수가 있으면 빈 문자열로 대체 (실수 노출 방지)
  return text.replace(/\{이름\}/g, '').replace(/\{name\}/gi, '');
}

// ───── Express ───────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Bot/workspace info (public, used by header)
app.get('/api/auth', async (_req, res) => {
  try {
    const r = await slack.auth.test();
    res.json({ ok: true, team: r.team, botName: r.user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.data?.error || err.message });
  }
});

// ───── OAuth ──────────────────────────────────────────────────
const pendingStates = new Set();

app.get('/api/auth/slack', (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.redirect('/?auth_error=' + encodeURIComponent('SLACK_CLIENT_ID 또는 SLACK_REDIRECT_URI 환경변수가 설정되지 않았습니다.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
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

  if (error) return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  if (!state || !pendingStates.has(state)) return res.redirect('/?auth_error=invalid_state');
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

    const sessionToken = crypto.randomBytes(32).toString('hex');

    users[userId] = {
      ...(users[userId] || {}),
      userId, userName, userAvatar, userToken, sessionToken,
      createdAt: users[userId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    persistUsers();

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
    });

    console.log(`✅ OAuth 로그인 — @${userName} (${userId})`);
    res.redirect('/');
  } catch (err) {
    console.error('OAuth 실패:', err?.data?.error || err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err?.data?.error || err.message)}`);
  }
});

app.get('/api/auth/session', (req, res) => {
  const user = getUserBySession(req);
  if (!user) return res.json({ connected: false });
  res.json({
    connected: true,
    userId: user.userId,
    userName: user.userName,
    userAvatar: user.userAvatar,
  });
});

app.post('/api/auth/logout', (req, res) => {
  const user = getUserBySession(req);
  if (user) {
    user.sessionToken = null;
    persistUsers();
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// ───── Slack lists (auth required) ───────────────────────────
app.get('/api/slack/channels', requireAuth, async (req, res) => {
  try {
    if (req.query.refresh || !channelCache.data || Date.now() - channelCache.at > CACHE_TTL) {
      channelCache = { data: await fetchChannels(), at: Date.now() };
    }
    res.json(channelCache.data);
  } catch (err) {
    res.status(500).json({ error: err?.data?.error || err.message });
  }
});

app.get('/api/slack/users', requireAuth, async (req, res) => {
  try {
    if (req.query.refresh || !userCache.data || Date.now() - userCache.at > CACHE_TTL) {
      userCache = { data: await fetchUsers(), at: Date.now() };
    }
    res.json(userCache.data);
  } catch (err) {
    res.status(500).json({ error: err?.data?.error || err.message });
  }
});

// ───── Schedules CRUD (auth + owner filter) ──────────────────
app.get('/api/schedules', requireAuth, (req, res) => {
  const mine = schedules.filter((s) => s.ownerId === req.user.userId);
  res.json([...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/schedules', requireAuth, (req, res) => {
  const {
    scheduleType, targets, messageText,
    date, startDate, endDate, time, daysOfWeek, senderType,
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

  const resolvedSenderType = senderType === 'user' && req.user.userToken ? 'user' : 'bot';
  const cleanTargets = targets.map((t) => ({
    type: t.type === 'user' ? 'user' : 'channel',
    id: String(t.id),
    name: String(t.name),
  }));

  const newSchedule = {
    id: Date.now().toString(),
    ownerId: req.user.userId,
    scheduleType,
    targets: cleanTargets,
    messageText,
    time,
    senderType: resolvedSenderType,
    senderName: resolvedSenderType === 'user' ? req.user.userName : null,
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

app.patch('/api/schedules/:id', requireAuth, (req, res) => {
  const s = findMySchedule(req);
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
    s.senderType = senderType === 'user' && req.user.userToken ? 'user' : 'bot';
    s.senderName = s.senderType === 'user' ? req.user.userName : null;
  }
  if (date !== undefined) s.date = date;
  if (startDate !== undefined) s.startDate = startDate;
  if (endDate !== undefined) s.endDate = endDate;
  if (daysOfWeek !== undefined) s.daysOfWeek = daysOfWeek;

  if (s.status === 'completed') {
    s.status = 'active';
    s.lastSentAt = null;
  }

  persistSchedules();
  res.json(s);
});

app.patch('/api/schedules/:id/skip-dates', requireAuth, (req, res) => {
  const s = findMySchedule(req);
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

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const s = findMySchedule(req);
  if (!s) return res.status(404).json({ error: 'Not found' });
  schedules = schedules.filter((x) => x.id !== s.id);
  persistSchedules();
  res.json({ ok: true });
});

app.patch('/api/schedules/:id/toggle', requireAuth, (req, res) => {
  const s = findMySchedule(req);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.status === 'completed')
    return res.status(400).json({ error: '이미 발송 완료된 일회성 예약입니다.' });
  s.status = s.status === 'active' ? 'paused' : 'active';
  persistSchedules();
  res.json({ status: s.status });
});

app.post('/api/test-send', requireAuth, async (req, res) => {
  const { targets, messageText, senderType } = req.body || {};
  if (!Array.isArray(targets) || targets.length === 0)
    return res.status(400).json({ error: '받는 대상을 선택해주세요.' });

  const client = getClientForUser(req.user, senderType);
  const results = [];
  for (const t of targets) {
    try {
      const personalText = personalize(messageText || '(내용 없음)', t);
      await client.chat.postMessage({
        channel: t.id,
        text: `🧪 *테스트 메시지*\n${personalText}`,
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
  const client = getClientForSchedule(s);
  const owner = users[s.ownerId];
  let okCount = 0;

  for (const t of s.targets) {
    try {
      const personalText = personalize(s.messageText, t);
      await client.chat.postMessage({ channel: t.id, text: personalText });
      okCount++;
    } catch (err) {
      const msg = err?.data?.error || err.message;
      sendLog.push({
        scheduleId: s.id,
        ownerId: s.ownerId,
        target: t.name,
        sentAt: new Date().toISOString(),
        success: false,
        error: msg,
      });
      console.error(
        `[${new Date().toLocaleString('ko-KR')}] ❌ (@${owner?.userName || 'unknown'}) ${t.type === 'channel' ? '#' : '@'}${t.name}: ${msg}`
      );
    }
  }

  const now = new Date().toISOString();
  if (okCount > 0) {
    s.sentCount = (s.sentCount || 0) + 1;
    s.lastSentAt = now;
    sendLog.push({
      scheduleId: s.id,
      ownerId: s.ownerId,
      sentAt: now,
      success: true,
      okCount,
      total: s.targets.length,
      senderType: s.senderType,
    });
    console.log(
      `[${new Date().toLocaleString('ko-KR')}] ✅ 발송 ${okCount}/${s.targets.length} (owner: @${owner?.userName || 'unknown'}, ${s.senderType}) — "${s.messageText.substring(0, 30)}..."`
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
  console.log(`│  Storage:  schedules.json (${schedules.length}건)`);
  console.log(`│  Users:    ${Object.keys(users).length}명 등록`);
  console.log('└─────────────────────────────────────────────┘\n');

  slack.auth
    .test()
    .then((r) => console.log(`✅ Slack 연결됨 — workspace: ${r.team}, bot: @${r.user}\n`))
    .catch((e) =>
      console.error('❌ Slack 인증 실패:', e?.data?.error || e.message, '\n   토큰을 다시 확인해주세요.\n')
    );
});
