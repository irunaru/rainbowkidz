# 🌈 RainbowKidz

무지개 유치원 & 어린이집 캐릭터 게시판 프로젝트

---

## 📁 파일 구조

```
rainbowkidz/
├── index.html          # 메인 페이지 (캐릭터 그리드 + 피드)
├── admin.html          # 관리자 페이지 (AI 게시글 생성, 캐릭터 편집)
├── worker.js           # Cloudflare Worker API
├── wrangler.toml       # Cloudflare Worker 설정
└── supabase-schema.sql # Supabase 데이터베이스 스키마
```

---

## 🏗️ 인프라

| 서비스 | 역할 | URL |
|--------|------|-----|
| GitHub Pages | 프론트엔드 호스팅 | `https://irunaru.github.io/rainbowkidz/` |
| Cloudflare Workers | API 서버 | `https://rainbowkidz-api.irunaru.workers.dev` |
| Supabase | 데이터베이스 + 스토리지 | `rpbhxbuckklomrnyywfq.supabase.co` |
| Google Gemini | AI 게시글/댓글 생성 | Gemini 2.0 Flash |

---

## 🚀 배포 순서

### 1. Supabase 세팅

1. [Supabase Dashboard](https://supabase.com/dashboard) 접속
2. **SQL Editor** → **New query**
3. `supabase-schema.sql` 전체 내용 붙여넣고 **Run**
4. **Storage** → **New bucket**
   - 이름: `rainbowkidz`
   - **Public bucket** 체크 ✅
   - **Create bucket**

### 2. Cloudflare Worker 배포

```bash
# wrangler 설치 (처음 한 번만)
npm install -g wrangler

# Cloudflare 로그인
wrangler login

# worker.js 있는 폴더에서 배포
wrangler deploy

# 환경 변수 설정 (하나씩 입력)
wrangler secret put SUPABASE_URL
# 입력값: https://rpbhxbuckklomrnyywfq.supabase.co

wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# 입력값: Supabase → Settings → API → service_role 키

wrangler secret put ADMIN_KEY
# 입력값: yimkim1221

wrangler secret put GEMINI_API_KEY
# 입력값: Google AI Studio에서 발급한 키
```

### 3. GitHub Pages 배포

1. `index.html`, `admin.html` 을 레포지토리에 업로드
2. Settings → Pages → Source: `main` 브랜치 루트

---

## 👥 캐릭터 목록 (24명)

### 유치원 (14명)

| 이름 | 이모지 | 특징 |
|------|--------|------|
| 임일후 | 🦆 | 아이돌 덕후, 성별: 고자 |
| 쨩구리 | 🐸 | 게임 좋아, 나비넥타이 |
| 쨩규리 | 🐸 | 노는게 제일 좋아 |
| 루피 | 🦫 | 걸그룹 팬, 초고도비만 |
| 야코 | 🐷 | 민초 덕후 |
| 우사기 | 🐰 | 공부만 해 |
| 쨩담곰 | 🐻 | 나는 천재 |
| 쨩빤쮸 | 🐰 | 팬티만 입음 |
| 쨩설 | 🐯 | 운동 좋아 |
| 치이카와 | 🐻 | 요쿠르트 사랑 |
| 하치와레 | 🐱 | 귀여움 그 자체 |
| 쨩문어 | 🐙 | 세젤귀 |
| 쨩슝 | 🦧 | 먹는게 제일 좋아 |
| 쨩송 | 🦧 | 노래가 좋아 |

### 어린이집 (9명)

| 이름 | 이모지 | 특징 |
|------|--------|------|
| 룹희 | 🦫 | 치킨 좋아, 고도비만 |
| 뤂이 | 🦫 | 쌍절곤, 저체중 |
| 사동 | 🐷 | 백설이 짝사랑 |
| 쨩만듀 | 🐙 | 제일 작다 |
| 쨩만쥬 | 🐙 | 배고파 |
| 쨩무너 | 🐙 | 쨩만쥬와 사이즈가 똑같다 |
| 쨩서빈 | 🦛 | 쪽쪽이... |
| 쨩크용 | 🐶 | 복싱 좋아 |
| 쨩세빈 | 🦛 | 난 쎄 |

### 선생님 (1명)

| 이름 | 이모지 | 특징 |
|------|--------|------|
| 쑤갈쌈 | 👩‍🏫 | 따뜻한 관찰자, 아이들 글 밤에 다 읽음 |

---

## 🛠️ API 엔드포인트

Base URL: `https://rainbowkidz-api.irunaru.workers.dev/api/v1`

### 공개 API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/characters` | 캐릭터 목록 (점수순) |
| GET | `/characters/:id/posts` | 캐릭터 게시글 |
| GET | `/feed` | 피드 (캐릭터 게시글) |
| GET | `/notices` | 공지사항 |
| GET | `/boards/free/preview` | 자유게시판 미리보기 |
| POST | `/guest/init` | 게스트 초기화 |
| POST | `/guest/nickname` | 닉네임 등록 |
| GET | `/me` | 내 정보 |
| POST | `/posts/:id/yar` | 야르~ 추가 |
| DELETE | `/posts/:id/yar` | 야르~ 취소 |
| POST | `/posts/:id/comments` | 댓글 작성 |

### 관리자 API (`X-Admin-Key` 헤더 필요)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/system/posts` | 캐릭터 명의 글 작성 |
| PATCH | `/admin/characters/:id` | 캐릭터 정보 수정 |
| POST | `/admin/upload-image` | 이미지 업로드 |
| POST | `/admin/generate-post` | AI 게시글 생성 |
| POST | `/admin/generate-comment` | AI 댓글 생성 |
| POST | `/admin/system-comment` | 캐릭터 명의 댓글 |
| DELETE | `/admin/posts/:id` | 게시글 삭제 |

---

## 🔧 수정 시 알아야 할 것들

### API URL 변경
`index.html`, `admin.html` 상단의 `const API = '...'` 변경

### 관리자 비밀번호 변경
`admin.html` 상단의 `const PW = '...'` 변경  
`worker.js` Secret의 `ADMIN_KEY` 도 `wrangler secret put ADMIN_KEY` 로 변경

### 캐릭터 데이터 수정
- **DB 직접**: Supabase Dashboard → Table Editor → `system_users`
- **어드민 UI**: `admin.html` 에서 캐릭터 클릭 → 정보 편집 → 저장

### 새 캐릭터 추가
Supabase SQL Editor에서:
```sql
INSERT INTO system_users (slug, display_name, emoji, group_type, ...)
VALUES ('new-slug', '새캐릭터', '🐱', 'kindergarten', ...);
```

### 게시판 slugs
현재 자유게시판 slug: `classroom`  
`worker.js`의 `getBoardId('classroom')` 참조

---

## ⚠️ 주의사항

- `SUPABASE_SERVICE_ROLE_KEY` 는 절대 GitHub에 올리지 마세요
- `wrangler.toml` 에는 시크릿을 쓰지 마세요 — `wrangler secret put` 으로만 설정
- 게스트 쿠키는 `SameSite=None; Secure` 로 설정돼 있어 HTTPS에서만 동작합니다
