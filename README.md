## 📘 RainbowKidz API & Admin

Cloudflare Workers + Supabase 기반의 캐릭터 게시판/커뮤니티 API와 관리자 페이지입니다.

* 프론트엔드: `index.html`, `mypage.html`, `admin.html`
* 백엔드: Cloudflare Workers (`worker.js`)
* DB: Supabase (PostgREST)

---

## 🧱 주요 기능

* 👤 게스트 로그인 / 닉네임 / 프로필 이미지
* 🧑‍🎓 캐릭터(시스템 유저) 게시글 피드
* 💬 댓글 / 반응(야르~)
* 🛠 관리자 페이지

  * 캐릭터 관리
  * AI 글/댓글 제안 (Gemini)
  * 공지 / 게시글 작성·삭제

---

## 🔐 환경 변수 (중요)

⚠️ **실제 값은 절대 GitHub에 올리지 마세요.**
아래는 **예시 이름만** 기재합니다.

### Cloudflare Workers Secrets

```bash
wrangler secret put ADMIN_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

* `ADMIN_KEY`
  관리자 페이지 접근용 키 (admin.html 로그인에 사용)

* `GEMINI_API_KEY`
  AI 글/댓글 생성을 위한 Gemini API 키

* `SUPABASE_URL`
  Supabase 프로젝트 URL

* `SUPABASE_SERVICE_ROLE_KEY`
  **절대 노출 금지** (서버 전용)

---

## 🌐 CORS 설정

기본적으로 **허용된 Origin만 접근 가능**하도록 설계되어 있습니다.

### 방법 1) 특정 도메인만 허용 (권장)

```bash
wrangler secret put ALLOWED_ORIGINS
# 값 예시:
# https://yourdomain.com,https://your-admin-domain.com
```

### 방법 2) 모든 Origin 허용 (개발/테스트용)

```bash
wrangler secret put ALLOWED_ORIGINS
# 값:
# *
```

> 운영 환경에서는 반드시 **도메인 제한**을 권장합니다.

---

## 🚀 배포

```bash
wrangler deploy
```

배포 후 Workers URL 예:

```
https://your-worker-name.your-account.workers.dev/api/v1
```

---

## 🧑‍💼 관리자 페이지 사용법

1. `admin.html`을 브라우저에서 열기
2. 관리자 키(ADMIN_KEY) 입력 후 로그인
3. 캐릭터 선택
4. 🤖 AI 글 제안 → ✏️ 수정 → 🚀 게시

---

## 🧩 API 요약

### AI 글 제안

```
POST /api/v1/admin/generate-post
body: { character_id }
```

### 시스템(캐릭터) 글 게시

```
POST /api/v1/system/posts
body: {
  system_user_id,
  title,
  body,
  is_notice?: boolean
}
```

### 캐릭터 목록

```
GET /api/v1/characters
```

---

## ❗ 보안 주의 사항 (필독)

* ❌ README / 코드 / 커밋에 **실제 키 값**을 절대 포함하지 마세요.
* ❌ `SUPABASE_SERVICE_ROLE_KEY`는 서버 외 사용 금지
* ✅ 키가 한 번이라도 노출되었다면 **즉시 로테이션** 권장
* ✅ 가능하면 공개 저장소에서는 admin.html 접근 URL도 비공개로 관리

---

## 📄 라이선스

Internal / Private use.
