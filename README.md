# 🤖 Slack Scheduler

기간·시간·요일을 설정해서 슬랙 채널이나 DM에 메시지를 자동으로 보내주는 셀프호스팅 봇입니다.

![tech stack](https://img.shields.io/badge/Node.js-≥18-339933) ![](https://img.shields.io/badge/Storage-SQLite-003B57) ![](https://img.shields.io/badge/UI-React_CDN-61DAFB)

---

## ⚡ 빠른 시작 (총 5분)

### 1️⃣ Slack 앱 만들기 (한 번만)

1. [https://api.slack.com/apps](https://api.slack.com/apps) 접속 → **Create New App** → **From a manifest**
2. 메시지를 보낼 워크스페이스 선택
3. `slack-app-manifest.json` 파일의 내용을 그대로 복사·붙여넣기 → **Next** → **Create**
4. 좌측 메뉴에서 **Install App** → **Install to Workspace** → **허용**
5. 같은 화면에서 **Bot User OAuth Token** (`xoxb-…`로 시작) 을 복사

> 💡 manifest 방식이라 권한이 자동으로 모두 설정됩니다.

### 2️⃣ 봇을 채널에 초대

메시지를 보낼 채널에서:
```
/invite @Slack Scheduler
```

> DM 으로만 보낼 거면 이 단계는 건너뛰어도 됩니다.

### 3️⃣ 설치 및 실행

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정 — .env.example 을 .env 로 복사하고 토큰 붙여넣기
cp .env.example .env
# (Windows: copy .env.example .env)

# 3. .env 파일을 열어서 SLACK_BOT_TOKEN= 뒤에 위에서 복사한 xoxb-... 토큰을 붙여넣으세요

# 4. 서버 실행
npm start
```

브라우저에서 **http://localhost:3000** 접속 → 끝! 🎉

콘솔에 다음과 같이 표시되면 정상 동작 중입니다:
```
┌─────────────────────────────────────────────┐
│      🤖 Slack Scheduler 가 실행 중입니다     │
├─────────────────────────────────────────────┤
│  URL:      http://localhost:3000            │
│  Timezone: Asia/Seoul                       │
└─────────────────────────────────────────────┘

✅ Slack 연결됨 — workspace: 우리회사, bot: @Slack Scheduler
```

---

## 📖 사용법

### 채널에 보내기
- **전송 대상 종류**: 채널 (Channel)
- **채널 이름**: `general` (앞에 `#` 불필요)
- 봇이 해당 채널에 초대되어 있어야 합니다.

### 개인 DM 으로 보내기
- **전송 대상 종류**: 개인 (DM)
- **사용자 식별자**: 다음 중 하나
  - **회원 ID** (가장 정확) — `U01ABC234XY`
  - **이메일** — `hong@company.com`
  - **사용자 이름** — `hong.gildong`

> 회원 ID 찾는 법: 슬랙에서 상대 프로필 클릭 → `•••` 더보기 → **회원 ID 복사**

### 예약 만들기
1. 우측 상단 **+ 새 메시지 예약** 클릭
2. 대상, 메시지, 시작일~종료일, 시간, 요일 입력
3. **지금 한 번 보내보기** 버튼으로 미리 테스트 가능
4. **예약 저장하기** 클릭 → 끝

서버는 매 분마다 조건에 맞는 예약을 자동 발송합니다.

---

## 🛠 옵션 & 팁

### 백그라운드 실행 (PM2)
컴퓨터를 항상 켜둘 수 없거나 24/7 운영이 필요하다면:

```bash
npm install -g pm2
pm2 start server.js --name slack-scheduler
pm2 save
pm2 startup    # 서버 부팅 시 자동 시작
```

상태 확인: `pm2 status` · 로그 보기: `pm2 logs slack-scheduler`

### 사내 서버 / 클라우드 배포
이 앱은 외부 인바운드 트래픽이 필요 없습니다 (Slack 으로 _내보내기만_ 합니다). 따라서:
- 사내 서버나 개인 PC 어디서든 실행 가능
- 외부 포트 개방 불필요
- 단, **인터넷 연결**과 **상시 실행**만 보장되면 됩니다

### 데이터 위치
모든 예약은 `schedules.json` 파일에 저장됩니다 (사람이 읽을 수 있는 평문 JSON). 백업하려면 이 파일만 복사하세요. `send_log.json` 에는 최근 500건의 발송 기록이 남습니다.

### 환경변수
| 변수 | 기본값 | 설명 |
|---|---|---|
| `SLACK_BOT_TOKEN` | _(필수)_ | Slack Bot User OAuth Token (`xoxb-…`) |
| `PORT` | `3000` | 웹 UI 포트 |
| `TZ` | `Asia/Seoul` | 스케줄러 기준 시간대 |

---

## 🔧 문제 해결

| 증상 | 해결 |
|---|---|
| `not_in_channel` 오류 | 봇을 해당 채널에 `/invite` 로 초대하세요 |
| `channel_not_found` | 채널 이름 오타 확인 (앞에 `#` 빼고 입력) |
| `users_not_found` | 사용자 ID(`U…`) 또는 정확한 이메일을 사용하세요 |
| 시간이 다르게 동작 | `.env` 의 `TZ` 값을 확인하세요 |
| `npm install` 실패 | Node.js 18 이상이 설치되어 있어야 합니다 (`node -v`) |

---

## 📂 프로젝트 구조

```
slack-scheduler/
├── server.js                  # 백엔드 (Express + cron + Slack API)
├── package.json
├── .env.example               # 환경변수 템플릿
├── slack-app-manifest.json    # Slack 앱 manifest (1단계에서 사용)
├── public/
│   └── index.html             # 프론트엔드 (React via CDN, 빌드 불필요)
├── schedules.json             # 예약 데이터 (자동 생성)
└── send_log.json              # 발송 로그 (자동 생성)
```

---

## 🔒 보안

- `.env` 파일은 절대 Git 에 커밋하지 마세요 (`.gitignore` 에 추가됨)
- 봇 토큰이 유출되면 [Slack 앱 설정](https://api.slack.com/apps) → **OAuth & Permissions** → **Revoke Token** 후 재발급
- 이 앱은 외부 트래픽을 받지 않으므로 외부 인증은 별도로 구현하지 않았습니다. 필요시 localhost 만 바인딩하거나 사내망에서 운영하세요.
