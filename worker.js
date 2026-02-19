// =====================================================
// RainbowKidz API - Cloudflare Worker
// =====================================================
// Worker 이름 : rainbowkidz-api
// 배포 URL    : https://rainbowkidz-api.irunaru.workers.dev
// 배포 명령   : wrangler deploy
//
// 필요한 Secret (wrangler secret put 으로 설정):
//   SUPABASE_URL             - Supabase 프로젝트 URL
//   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role 키
//   ADMIN_KEY                - 관리자 키 (yimkim1221)
//   GEMINI_API_KEY           - Google Gemini API 키
// =====================================================

// ── 모듈 스코프 (Worker 재사용 시 캐시가 살아있음) ──
const RATE_LIMITS = new Map();      // IP/게스트별 요청 제한 Map
let BOARD_CACHE = null;             // 게시판 ID 캐시 (slug → id)
let BOARD_CACHE_TIME = 0;           // 캐시 생성 시각
const BOARD_CACHE_TTL = 3600_000;  // 캐시 유효 시간: 1시간(ms)

// 허용된 CORS 출처 목록
const ALLOWED_ORIGINS = [
  'https://irunaru.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
];

export default {
  async fetch(request, env) {

    // ── CORS 헤더 설정 ──────────────────────────────
    const reqOrigin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
    const CORS = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
      'Access-Control-Allow-Credentials': 'true', // 쿠키 전송 허용
      'Vary': 'Origin',
    };

    // OPTIONS preflight 즉시 응답
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 공통 헬퍼 ───────────────────────────────────

    /** JSON 응답 생성 */
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
      });

    /** 에러 응답 */
    const bad = (error, status = 400) => json({ ok: false, error }, status);

    /** Supabase REST API 호출 (service_role 키 사용) */
    const supabase = async (p, opts = {}) => {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
        throw new Error('supabase_env_missing');
      const headers = new Headers(opts.headers || {});
      headers.set('apikey', env.SUPABASE_SERVICE_ROLE_KEY);
      headers.set('Authorization', `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      return fetch(env.SUPABASE_URL + p, { ...opts, headers });
    };

    /** 요청 body를 JSON으로 파싱 (실패 시 null) */
    const bodyJson = async () => {
      try { return await request.json(); } catch { return null; }
    };

    /** HTML 특수문자 이스케이프 */
    const sanitize = (text) =>
      String(text || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();

    /** 닉네임 유효성 검사. 문제 있으면 에러문자열, 없으면 null */
    const validateNick = (nick) => {
      if (typeof nick !== 'string') return 'nickname_must_be_string';
      const t = nick.trim();
      if (t.length < 1 || t.length > 10) return 'nickname_length_1_10';
      if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]+$/.test(t)) return 'nickname_invalid_chars';
      const blocked = ['관리자','admin','운영자','선생님','teacher','system'];
      if (blocked.some(w => t.toLowerCase().includes(w.toLowerCase()))) return 'nickname_forbidden';
      return null;
    };

    /** 요청 제한 체크. 초과 시 false */
    const rateCheck = (key, max, windowMs) => {
      const now = Date.now();
      // Map이 너무 커지면 만료된 항목 정리
      if (RATE_LIMITS.size > 10000) {
        for (const [k, v] of RATE_LIMITS) { if (now > v.resetAt) RATE_LIMITS.delete(k); }
      }
      const rec = RATE_LIMITS.get(key);
      if (!rec || now > rec.resetAt) { RATE_LIMITS.set(key, { count: 1, resetAt: now + windowMs }); return true; }
      if (rec.count >= max) return false;
      rec.count++;
      return true;
    };

    const clientIP = () => request.headers.get('cf-connecting-ip') || 'unknown';

    /** Cookie 파싱 */
    const parseCookies = () => {
      const out = {};
      const raw = request.headers.get('Cookie') || '';
      raw.split(';').forEach(p => {
        const i = p.indexOf('=');
        if (i !== -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
      return out;
    };

    const getGuestId = () => parseCookies()['bbs_gid'] || null;

    /** SameSite=None + Secure 쿠키 (cross-origin 전송 필수) */
    const guestCookie = (gid) =>
      `bbs_gid=${gid}; Max-Age=${86400 * 365}; Path=/; Secure; HttpOnly; SameSite=None`;

    /** boards 테이블에서 slug → id 조회 (캐시 적용) */
    const getBoardId = async (slug) => {
      const now = Date.now();
      if (BOARD_CACHE && now - BOARD_CACHE_TIME < BOARD_CACHE_TTL) return BOARD_CACHE[slug];
      const res = await supabase('/rest/v1/boards?select=id,slug');
      if (!res.ok) throw new Error('board_fetch_failed');
      const boards = await res.json();
      BOARD_CACHE = Object.fromEntries(boards.map(b => [b.slug, b.id]));
      BOARD_CACHE_TIME = now;
      return BOARD_CACHE[slug];
    };

    /** X-Admin-Key 헤더로 관리자 인증 */
    const isAdmin = () => env.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY;

    // =====================================================
    // 라우팅
    // =====================================================

    // ── 헬스체크 ─────────────────────────────────────
    if ((path === '/' || path === '/health') && request.method === 'GET') {
      return json({ ok: true, service: 'rainbowkidz-api', version: '3.1.0' });
    }

    // =====================================================
    // 게스트 인증
    // =====================================================

    // POST /api/v1/guest/init - 게스트 ID 쿠키 발급
    if (path === '/api/v1/guest/init' && request.method === 'POST') {
      let gid = getGuestId();

      // 쿠키가 없으면 새 UUID 발급 (DB 저장 없이 쿠키만)
      if (!gid) {
        gid = crypto.randomUUID();
        return json({ ok: true, guest_id: gid, has_nickname: false }, 200, {
          'Set-Cookie': guestCookie(gid),
        });
      }

      // 이미 쿠키 있으면 닉네임 보유 여부 확인
      const res = await supabase(`/rest/v1/guests?select=id,nickname&id=eq.${gid}`);
      if (!res.ok) return bad('supabase_error', 502);
      const rows = await res.json();
      return json({ ok: true, guest_id: gid, has_nickname: rows.length > 0 && !!rows[0].nickname });
    }

    // GET /api/v1/me - 내 게스트 정보 조회
    if (path === '/api/v1/me' && request.method === 'GET') {
      const gid = getGuestId();
      if (!gid) return json({ ok: true, guest: null });
      const res = await supabase(`/rest/v1/guests?select=id,nickname,is_blocked&id=eq.${gid}&limit=1`);
      if (!res.ok) return bad('supabase_error', 502);
      const rows = await res.json();
      return json({ ok: true, guest: rows[0] || null });
    }

    // POST /api/v1/guest/nickname - 닉네임 등록/변경 (7일 쿨다운)
    if (path === '/api/v1/guest/nickname' && request.method === 'POST') {
      const body = await bodyJson();
      let gid = getGuestId() || body?.guest_id;
      if (!gid) return bad('guest_not_initialized', 401);

      // 닉네임 변경 요청 제한
      if (!rateCheck(`nick:${gid}`, 1, 60_000)) return bad('rate_limit', 429);
      if (!rateCheck(`nick:ip:${clientIP()}`, 5, 60_000)) return bad('rate_limit_ip', 429);

      const err = validateNick(body?.nickname);
      if (err) return bad(err);
      const nickname = body.nickname.trim();

      // 쿨다운 체크 (RPC)
      const coolRes = await supabase('/rest/v1/rpc/can_change_nickname', {
        method: 'POST',
        body: JSON.stringify({ p_guest_id: gid, p_cooldown_days: 7 }),
      });
      if (coolRes.ok && !(await coolRes.json())) return bad('nickname_cooldown_7days', 429);

      // 중복 체크 (RPC)
      const avRes = await supabase('/rest/v1/rpc/check_nickname_available', {
        method: 'POST',
        body: JSON.stringify({ p_nickname: nickname, p_guest_id: gid }),
      });
      if (avRes.ok && !(await avRes.json())) return bad('nickname_taken', 409);

      // guests upsert
      const upsertRes = await supabase('/rest/v1/guests?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          id: gid, nickname,
          last_seen_at: new Date().toISOString(),
          nickname_changed_at: new Date().toISOString(),
        }),
      });
      if (!upsertRes.ok) return bad('supabase_error', 502);
      const rows = await upsertRes.json();
      return json({ ok: true, guest_id: gid, nickname: rows?.[0]?.nickname ?? nickname });
    }

    // =====================================================
    // 캐릭터
    // =====================================================

    // GET /api/v1/characters - 전체 캐릭터 목록 (점수순 정렬)
    if (path === '/api/v1/characters' && request.method === 'GET') {
      // 모든 필드 조회 (admin.html 프로필 편집에 필요)
      const res = await supabase(
        '/rest/v1/system_users?select=id,slug,display_name,emoji,group_type,animal_type,gender,birthday,age,mbti,personality,likes,dislikes,hobby,secret,speech_style,image_url,color&order=id.asc'
      );
      if (!res.ok) return bad('supabase_error', 502);
      const chars = await res.json();

      // 각 캐릭터의 활동 통계 계산 (게시글 수, 조회수, 댓글 수)
      const scored = await Promise.all(chars.map(async (c) => {
        const statsRes = await supabase(
          `/rest/v1/posts?select=view_count,comment_count&system_user_id=eq.${c.id}&deleted_at=is.null`
        );
        const posts = statsRes.ok ? await statsRes.json() : [];
        const postCount    = posts.length;
        const viewCount    = posts.reduce((s, p) => s + (p.view_count    || 0), 0);
        const commentCount = posts.reduce((s, p) => s + (p.comment_count || 0), 0);
        // 활동 점수 (게시글 40% + 댓글 30% + 조회 30%)
        const score = postCount * 0.4 + commentCount * 0.3 + viewCount * 0.3;
        return { ...c, post_count: postCount, view_count: viewCount, comment_count: commentCount, score };
      }));

      scored.sort((a, b) => b.score - a.score);
      return json({ ok: true, characters: scored });
    }

    // GET /api/v1/characters/:id/posts - 특정 캐릭터의 게시글 목록
    const charPostsMatch = path.match(/^\/api\/v1\/characters\/(\d+)\/posts$/);
    if (charPostsMatch && request.method === 'GET') {
      const id     = charPostsMatch[1];
      const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20'), 50);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),  0);
      const res = await supabase(
        `/rest/v1/posts?select=id,title,body,created_at,view_count,comment_count&system_user_id=eq.${id}&deleted_at=is.null&order=created_at.desc&limit=${limit}&offset=${offset}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      return json({ ok: true, posts: await res.json(), limit, offset });
    }

    // =====================================================
    // 피드 / 공지 / 게시판 미리보기
    // =====================================================

    // GET /api/v1/feed - 캐릭터(시스템 유저) 게시글 피드
    if (path === '/api/v1/feed' && request.method === 'GET') {
      const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20'), 50);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),  0);

      const res = await supabase(
        `/rest/v1/posts?select=id,title,body,created_at,view_count,comment_count,system_user_id,system_users(display_name,emoji)&author_type=eq.system&is_notice=eq.false&deleted_at=is.null&order=created_at.desc&limit=${limit}&offset=${offset}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      const posts = await res.json();

      // 야르~ 수 일괄 조회
      const ids = posts.map(p => p.id);
      let yarMap = {};
      if (ids.length) {
        const yrRes = await supabase(`/rest/v1/post_likes?select=post_id&post_id=in.(${ids.join(',')})`);
        if (yrRes.ok) {
          const yars = await yrRes.json();
          yars.forEach(y => { yarMap[y.post_id] = (yarMap[y.post_id] || 0) + 1; });
        }
      }

      return json({
        ok: true,
        posts: posts.map(p => ({
          id:             p.id,
          title:          p.title,
          body:           p.body,
          created_at:     p.created_at,
          view_count:     p.view_count    || 0,
          comment_count:  p.comment_count || 0,
          yar_count:      yarMap[p.id]    || 0,
          system_user_id: p.system_user_id,
          character_name:  p.system_users?.display_name,
          character_emoji: p.system_users?.emoji,
        })),
        limit, offset,
      });
    }

    // GET /api/v1/notices - 공지사항 목록
    if (path === '/api/v1/notices' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '5'), 10);
      const res = await supabase(
        `/rest/v1/posts?select=id,title,body,created_at,system_users(display_name,emoji)&is_notice=eq.true&deleted_at=is.null&order=created_at.desc&limit=${limit}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      const notices = await res.json();
      return json({
        ok: true,
        notices: notices.map(n => ({
          id: n.id, title: n.title, body: n.body, created_at: n.created_at,
          author: n.system_users?.display_name, author_emoji: n.system_users?.emoji,
        })),
      });
    }

    // GET /api/v1/boards/free/preview - 자유게시판 최근 글 미리보기
    if (path === '/api/v1/boards/free/preview' && request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '3'), 10);
      // 'classroom' slug가 자유게시판 역할
      const boardId = await getBoardId('classroom');
      if (!boardId) return bad('board_not_found', 404);
      const res = await supabase(
        `/rest/v1/posts?select=id,title,body,created_at,comment_count,guests(nickname)&board_id=eq.${boardId}&author_type=eq.guest&deleted_at=is.null&order=created_at.desc&limit=${limit}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      const posts = await res.json();
      return json({
        ok: true,
        posts: posts.map(p => ({
          id: p.id, title: p.title, body: p.body,
          created_at: p.created_at, comment_count: p.comment_count,
          nickname: p.guests?.nickname,
        })),
      });
    }

    // =====================================================
    // 자유게시판 (게스트 CRUD)
    // =====================================================

    // GET /api/v1/boards/classroom/posts - 자유게시판 글 목록
    if (path === '/api/v1/boards/classroom/posts' && request.method === 'GET') {
      const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '20'), 50);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'),  0);
      const boardId = await getBoardId('classroom');
      if (!boardId) return bad('board_not_found', 404);
      const res = await supabase(
        `/rest/v1/posts?select=id,title,body,created_at,comment_count,view_count,author_type,is_notice,is_pinned,system_user_id,system_users(display_name,emoji),guests(nickname)&board_id=eq.${boardId}&deleted_at=is.null&order=is_pinned.desc,created_at.desc&limit=${limit}&offset=${offset}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      const posts = await res.json();
      return json({
        ok: true,
        posts: posts.map(p => ({
          id: p.id, title: p.title, body: p.body,
          created_at: p.created_at, comment_count: p.comment_count,
          view_count: p.view_count, is_notice: p.is_notice, is_pinned: p.is_pinned,
          author_type: p.author_type,
          character_name:  p.system_users?.display_name,
          character_emoji: p.system_users?.emoji,
          nickname: p.guests?.nickname,
        })),
        limit, offset,
      });
    }

    // GET /api/v1/posts/:id - 게시글 상세 + 댓글
    const postDetailMatch = path.match(/^\/api\/v1\/posts\/(\d+)$/);
    if (postDetailMatch && request.method === 'GET') {
      const postId = postDetailMatch[1];
      const [pRes, cRes] = await Promise.all([
        supabase(`/rest/v1/posts?select=id,title,body,created_at,view_count,comment_count,author_type,is_notice,system_user_id,system_users(display_name,emoji),guests(nickname)&id=eq.${postId}&deleted_at=is.null&limit=1`),
        supabase(`/rest/v1/comments?select=id,body,created_at,author_type,nickname,system_users(display_name,emoji)&post_id=eq.${postId}&deleted_at=is.null&order=created_at.asc&limit=200`),
      ]);
      if (!pRes.ok) return bad('supabase_error', 502);
      const pRows = await pRes.json();
      if (!pRows.length) return bad('post_not_found', 404);
      const p = pRows[0];

      // 야르~ 수
      const yrRes = await supabase(`/rest/v1/post_likes?select=id&post_id=eq.${postId}`);
      const yarCount = yrRes.ok ? (await yrRes.json()).length : 0;

      return json({
        ok: true,
        post: {
          id: p.id, title: p.title, body: p.body,
          created_at: p.created_at, view_count: p.view_count,
          comment_count: p.comment_count, yar_count: yarCount,
          is_notice: p.is_notice, author_type: p.author_type,
          character_name:  p.system_users?.display_name,
          character_emoji: p.system_users?.emoji,
          nickname: p.guests?.nickname,
        },
        comments: cRes.ok ? await cRes.json() : [],
      });
    }

    // POST /api/v1/posts/:id/view - 조회수 +1 (단순 PATCH, fallback 없이)
    const postViewMatch = path.match(/^\/api\/v1\/posts\/(\d+)\/view$/);
    if (postViewMatch && request.method === 'POST') {
      const postId = postViewMatch[1];
      // 현재 값 읽기 → +1 → 업데이트 (원자적이진 않지만 트래픽 적으므로 충분)
      const getRes = await supabase(
        `/rest/v1/posts?select=view_count&id=eq.${postId}&deleted_at=is.null&limit=1`
      );
      if (!getRes.ok) return bad('supabase_error', 502);
      const rows = await getRes.json();
      if (!rows.length) return bad('post_not_found', 404);
      const newCount = (rows[0].view_count || 0) + 1;
      await supabase(`/rest/v1/posts?id=eq.${postId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ view_count: newCount }),
      });
      return json({ ok: true, view_count: newCount });
    }

    // POST /api/v1/posts - 게스트 글 작성
    if (path === '/api/v1/posts' && request.method === 'POST') {
      const body = await bodyJson();
      const gid = getGuestId() || body?.guest_id;
      if (!gid) return bad('guest_not_initialized', 401);

      // 요청 제한: 게스트 1회/20초, IP 3회/10분
      if (!rateCheck(`post:${gid}`,        1, 20_000))  return bad('rate_limit_post', 429);
      if (!rateCheck(`post:ip:${clientIP()}`, 3, 600_000)) return bad('rate_limit_ip', 429);

      const gRes = await supabase(`/rest/v1/guests?select=id,nickname,is_blocked&id=eq.${gid}&limit=1`);
      if (!gRes.ok) return bad('supabase_error', 502);
      const gRows = await gRes.json();
      if (!gRows.length)       return bad('nickname_required', 403);
      if (gRows[0].is_blocked) return bad('user_blocked', 403);

      const title   = sanitize(body?.title  || '').slice(0, 80);
      const content = sanitize(body?.body   || '').slice(0, 5000);
      if (title.length   < 2) return bad('title_too_short');
      if (content.length < 5) return bad('body_too_short');

      const boardId = await getBoardId('classroom');
      if (!boardId) return bad('board_not_found', 404);

      const pRes = await supabase('/rest/v1/posts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ board_id: boardId, author_type: 'guest', guest_id: gid, title, body: content }),
      });
      if (!pRes.ok) return bad('supabase_error', 502);
      return json({ ok: true, post: (await pRes.json())[0] }, 201);
    }

    // DELETE /api/v1/posts/:id - 본인 글 삭제 (소프트 삭제)
    if (postDetailMatch && request.method === 'DELETE') {
      const postId = postDetailMatch[1];
      const gid = getGuestId();
      if (!gid) return bad('guest_not_initialized', 401);
      const pRes = await supabase(`/rest/v1/posts?select=id,guest_id&id=eq.${postId}&deleted_at=is.null&limit=1`);
      if (!pRes.ok) return bad('supabase_error', 502);
      const rows = await pRes.json();
      if (!rows.length)              return bad('post_not_found', 404);
      if (rows[0].guest_id !== gid)  return bad('not_your_post', 403);
      await supabase(`/rest/v1/posts?id=eq.${postId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    // =====================================================
    // 야르~ (좋아요)
    // =====================================================

    // POST /api/v1/posts/:id/yar - 야르~ 추가
    // DELETE /api/v1/posts/:id/yar - 야르~ 취소
    const yarMatch = path.match(/^\/api\/v1\/posts\/(\d+)\/yar$/);
    if (yarMatch && (request.method === 'POST' || request.method === 'DELETE')) {
      const postId  = yarMatch[1];
      const body    = await bodyJson();
      const nickname = body?.nickname?.trim();
      if (!nickname) return bad('nickname_required', 401);
      if (!/^[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9]{1,10}$/.test(nickname)) return bad('invalid_nickname');

      if (request.method === 'POST') {
        // 중복 무시로 삽입
        await supabase('/rest/v1/post_likes', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({ post_id: Number(postId), nickname }),
        });
      } else {
        // 야르~ 취소 - encodeURIComponent 사용 안 함 (DB 저장값과 일치시켜야 함)
        await supabase(`/rest/v1/post_likes?post_id=eq.${postId}&nickname=eq.${nickname}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        });
      }

      // 최신 야르~ 수 반환
      const countRes = await supabase(`/rest/v1/post_likes?select=id&post_id=eq.${postId}`);
      const yarCount = countRes.ok ? (await countRes.json()).length : 0;
      return json({ ok: true, yar_count: yarCount, action: request.method === 'POST' ? 'added' : 'removed' });
    }

    // =====================================================
    // 댓글
    // =====================================================

    // GET /api/v1/posts/:id/comments - 댓글 목록
    const listCommentMatch = path.match(/^\/api\/v1\/posts\/(\d+)\/comments$/);
    if (listCommentMatch && request.method === 'GET') {
      const postId = listCommentMatch[1];
      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '100'), 200);
      const res = await supabase(
        `/rest/v1/comments?select=id,body,created_at,author_type,nickname,system_users(display_name,emoji)&post_id=eq.${postId}&deleted_at=is.null&order=created_at.asc&limit=${limit}`
      );
      if (!res.ok) return bad('supabase_error', 502);
      return json({ ok: true, comments: await res.json() });
    }

    // POST /api/v1/posts/:id/comments - 게스트 댓글 작성
    const createCommentMatch = path.match(/^\/api\/v1\/posts\/(\d+)\/comments$/);
    if (createCommentMatch && request.method === 'POST') {
      const postId = createCommentMatch[1];
      const body   = await bodyJson();
      const gid    = getGuestId() || body?.guest_id;
      if (!gid) return bad('guest_not_initialized', 401);

      // 요청 제한: 게스트 1회/5초, IP 10회/분
      if (!rateCheck(`comment:${gid}`,          1,  5_000)) return bad('rate_limit_comment', 429);
      if (!rateCheck(`comment:ip:${clientIP()}`, 10, 60_000)) return bad('rate_limit_ip', 429);

      const gRes = await supabase(`/rest/v1/guests?select=id,nickname,is_blocked&id=eq.${gid}&limit=1`);
      if (!gRes.ok) return bad('supabase_error', 502);
      const gRows = await gRes.json();
      if (!gRows.length)       return bad('nickname_required', 403);
      if (gRows[0].is_blocked) return bad('user_blocked', 403);

      // 게시글 존재 확인
      const pRes = await supabase(`/rest/v1/posts?select=id&id=eq.${postId}&deleted_at=is.null&limit=1`);
      if (!pRes.ok || !(await pRes.json()).length) return bad('post_not_found', 404);

      const content = sanitize(body?.body || '').slice(0, 1000);
      if (content.length < 1) return bad('comment_too_short');

      const cRes = await supabase('/rest/v1/comments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          post_id: Number(postId), author_type: 'guest',
          guest_id: gid, nickname: gRows[0].nickname, body: content,
        }),
      });
      if (!cRes.ok) return bad('supabase_error', 502);
      return json({ ok: true, comment: (await cRes.json())[0] }, 201);
    }

    // DELETE /api/v1/comments/:id - 본인 댓글 삭제
    const deleteCommentMatch = path.match(/^\/api\/v1\/comments\/(\d+)$/);
    if (deleteCommentMatch && request.method === 'DELETE') {
      const commentId = deleteCommentMatch[1];
      const gid = getGuestId();
      if (!gid) return bad('guest_not_initialized', 401);
      const cRes = await supabase(`/rest/v1/comments?select=id,guest_id&id=eq.${commentId}&deleted_at=is.null&limit=1`);
      if (!cRes.ok) return bad('supabase_error', 502);
      const rows = await cRes.json();
      if (!rows.length)              return bad('comment_not_found', 404);
      if (rows[0].guest_id !== gid)  return bad('not_your_comment', 403);
      await supabase(`/rest/v1/comments?id=eq.${commentId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    // =====================================================
    // 시스템 (관리자 전용)
    // =====================================================

    // POST /api/v1/system/posts - 캐릭터 명의 글 작성 (공지 포함)
    if (path === '/api/v1/system/posts' && request.method === 'POST') {
      if (!isAdmin()) return bad('unauthorized', 401);
      const body = await bodyJson();
      const systemUserId = body?.system_user_id;
      if (!systemUserId) return bad('system_user_required');

      const title   = sanitize(body?.title || '').slice(0, 80);
      const content = sanitize(body?.body  || '').slice(0, 5000);
      if (title.length   < 2) return bad('title_too_short');
      if (content.length < 5) return bad('body_too_short');

      const boardId = await getBoardId('classroom');
      if (!boardId) return bad('board_not_found', 404);

      const pRes = await supabase('/rest/v1/posts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          board_id: boardId,
          author_type: 'system',
          system_user_id: Number(systemUserId),
          title, body: content,
          content_type: 'system',
          is_notice: body?.is_notice === true, // 공지 여부
        }),
      });
      if (!pRes.ok) return bad('supabase_error', 502);
      return json({ ok: true, post: (await pRes.json())[0] }, 201);
    }

    // =====================================================
    // Admin API - AI 생성 / 캐릭터 수정 / 이미지 업로드
    // =====================================================

    // POST /api/v1/admin/generate-post - Gemini로 캐릭터 게시글 생성
    if (path === '/api/v1/admin/generate-post' && request.method === 'POST') {
      if (!isAdmin()) return bad('unauthorized', 401);
      if (!env.GEMINI_API_KEY) return bad('gemini_key_missing', 500);

      const body = await bodyJson();
      const charId = body?.character_id;
      if (!charId) return bad('character_id_required');

      // 캐릭터 정보 조회
      const cRes = await supabase(`/rest/v1/system_users?select=*&id=eq.${charId}&limit=1`);
      if (!cRes.ok) return bad('supabase_error', 502);
      const chars = await cRes.json();
      if (!chars.length) return bad('character_not_found', 404);
      const c = chars[0];

      // 최근 글 3개 (맥락 유지용)
      const rRes = await supabase(
        `/rest/v1/posts?select=title,body&system_user_id=eq.${charId}&deleted_at=is.null&order=created_at.desc&limit=3`
      );
      const recent = rRes.ok ? await rRes.json() : [];
      const recentCtx = recent.length
        ? `\n\n[최근 쓴 글]\n${recent.map(r => `- ${r.title||''}: ${(r.body||'').slice(0,60)}`).join('\n')}`
        : '';

      // Gemini 프롬프트
      const prompt = `너는 "${c.display_name}"이라는 캐릭터야.

[캐릭터 정보]
이름: ${c.display_name}
동물종류: ${c.animal_type || ''}
성별: ${c.gender || ''}
MBTI: ${c.mbti || ''}
특징: ${c.personality || ''}
좋아하는것: ${c.likes || ''}
싫어하는것: ${c.dislikes || ''}
취미: ${c.hobby || ''}
말투특징: ${c.speech_style || ''}
비밀: ${c.secret || ''}
${recentCtx}

위 캐릭터로서 유치원/어린이집 친구들이 보는 게시판에 올릴 짧고 재미있는 글을 써줘.
일상, 오늘 있었던 일, 좋아하는 것 등 자연스럽게. 반드시 이 캐릭터 말투를 써야 해. 3~6문장.

반드시 JSON만 출력해 (백틱/마크다운 없이):
{"title":"제목(15자이내)","body":"본문"}`;

      try {
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.9, maxOutputTokens: 512 },
            }),
          }
        );
        if (!gRes.ok) { console.error('[Gemini]', await gRes.text()); return bad('gemini_error', 502); }
        const gData = await gRes.json();
        const raw   = gData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const clean = raw.replace(/```json|```/g, '').trim();
        let parsed;
        try { parsed = JSON.parse(clean); } catch { console.error('[Gemini parse]', clean); return bad('gemini_parse_error', 500); }
        return json({ ok: true, title: parsed.title || '', body: parsed.body || '' });
      } catch (e) { return bad(`gemini_fetch_error: ${e.message}`, 500); }
    }

    // POST /api/v1/admin/generate-comment - Gemini로 댓글 생성
    if (path === '/api/v1/admin/generate-comment' && request.method === 'POST') {
      if (!isAdmin()) return bad('unauthorized', 401);
      if (!env.GEMINI_API_KEY) return bad('gemini_key_missing', 500);

      const body = await bodyJson();
      const { post_id, character_id } = body || {};
      if (!post_id || !character_id) return bad('post_id_and_character_id_required');

      const [postRes, charRes] = await Promise.all([
        supabase(`/rest/v1/posts?select=title,body,system_users(display_name)&id=eq.${post_id}&limit=1`),
        supabase(`/rest/v1/system_users?select=*&id=eq.${character_id}&limit=1`),
      ]);
      if (!postRes.ok || !charRes.ok) return bad('supabase_error', 502);
      const posts = await postRes.json();
      const chars = await charRes.json();
      if (!posts.length) return bad('post_not_found', 404);
      if (!chars.length) return bad('character_not_found', 404);
      const post = posts[0];
      const c    = chars[0];

      // 기존 댓글 5개 (맥락용)
      const cmtRes = await supabase(
        `/rest/v1/comments?select=body,nickname&post_id=eq.${post_id}&deleted_at=is.null&order=created_at.asc&limit=5`
      );
      const existing = cmtRes.ok ? await cmtRes.json() : [];
      const cmtCtx = existing.length
        ? `\n[기존 댓글]\n${existing.map(cm => `- ${cm.nickname||'누군가'}: ${cm.body}`).join('\n')}`
        : '';

      const prompt = `너는 "${c.display_name}"이라는 캐릭터야.

[캐릭터 정보]
이름: ${c.display_name} | MBTI: ${c.mbti || ''} | 특징: ${c.personality || ''}
말투특징: ${c.speech_style || ''} | 좋아하는것: ${c.likes || ''}

[댓글 달 게시글]
작성자: ${post.system_users?.display_name || '누군가'}
제목: ${post.title || ''}
내용: ${(post.body || '').slice(0, 200)}
${cmtCtx}

이 게시글에 댓글을 이 캐릭터 말투로 써줘. 1~2문장.

반드시 JSON만 출력해:
{"comment":"댓글내용"}`;

      try {
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.9, maxOutputTokens: 256 },
            }),
          }
        );
        if (!gRes.ok) return bad('gemini_error', 502);
        const gData = await gRes.json();
        const raw   = gData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const clean = raw.replace(/```json|```/g, '').trim();
        let parsed;
        try { parsed = JSON.parse(clean); } catch { return bad('gemini_parse_error', 500); }
        return json({ ok: true, comment: parsed.comment || '' });
      } catch (e) { return bad(`gemini_fetch_error: ${e.message}`, 500); }
    }

    // POST /api/v1/admin/system-comment - 캐릭터 명의 댓글 게시
    if (path === '/api/v1/admin/system-comment' && request.method === 'POST') {
      if (!isAdmin()) return bad('unauthorized', 401);
      const body = await bodyJson();
      const { post_id, system_user_id, body: commentBody } = body || {};
      if (!post_id || !system_user_id || !commentBody) return bad('missing_fields');

      const content = sanitize(commentBody).slice(0, 1000);
      if (!content) return bad('comment_too_short');

      // 캐릭터 이름 조회 (댓글 nickname 필드에 저장)
      const cRes = await supabase(`/rest/v1/system_users?select=display_name&id=eq.${system_user_id}&limit=1`);
      const cRows = cRes.ok ? await cRes.json() : [];
      const nickname = cRows[0]?.display_name || '캐릭터';

      const res = await supabase('/rest/v1/comments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          post_id: Number(post_id), author_type: 'system',
          system_user_id: Number(system_user_id), nickname, body: content,
        }),
      });
      if (!res.ok) return bad('supabase_error', 502);
      return json({ ok: true, comment: (await res.json())[0] }, 201);
    }

    // DELETE /api/v1/admin/posts/:id - 관리자 게시글 강제 삭제
    const adminDelPostMatch = path.match(/^\/api\/v1\/admin\/posts\/(\d+)$/);
    if (adminDelPostMatch && request.method === 'DELETE') {
      if (!isAdmin()) return bad('unauthorized', 401);
      const postId = adminDelPostMatch[1];
      const res = await supabase(`/rest/v1/posts?id=eq.${postId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString() }),
      });
      if (!res.ok) return bad('supabase_error', 502);
      return json({ ok: true });
    }

    // PATCH /api/v1/admin/characters/:id - 캐릭터 정보 수정
    const adminCharMatch = path.match(/^\/api\/v1\/admin\/characters\/(\d+)$/);
    if (adminCharMatch && request.method === 'PATCH') {
      if (!isAdmin()) return bad('unauthorized', 401);
      const charId = adminCharMatch[1];
      const body   = await bodyJson();

      // 수정 허용 필드 화이트리스트
      const ALLOWED = [
        'display_name','emoji','group_type','animal_type','gender',
        'birthday','age','mbti','personality','likes','dislikes',
        'hobby','secret','speech_style','image_url','color',
      ];
      const update = {};
      ALLOWED.forEach(k => { if (body[k] !== undefined) update[k] = body[k] || null; });
      if (!Object.keys(update).length) return bad('no_fields_to_update');

      const res = await supabase(`/rest/v1/system_users?id=eq.${charId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(update),
      });
      if (!res.ok) return bad('supabase_error', 502);
      return json({ ok: true });
    }

    // POST /api/v1/admin/upload-image - 캐릭터 이미지 Supabase Storage 업로드
    if (path === '/api/v1/admin/upload-image' && request.method === 'POST') {
      if (!isAdmin()) return bad('unauthorized', 401);

      const formData  = await request.formData();
      const file      = formData.get('image');
      const charId    = formData.get('character_id');
      if (!file || !charId) return bad('missing_image_or_character_id');

      const ext      = (file.name || 'img').split('.').pop().toLowerCase() || 'jpg';
      const filename = `characters/${charId}.${ext}`;
      const buffer   = await file.arrayBuffer();

      // Storage에 업로드 (x-upsert로 덮어쓰기 허용)
      const upRes = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/rainbowkidz/${filename}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': file.type || 'image/jpeg',
            'x-upsert': 'true',
          },
          body: buffer,
        }
      );
      if (!upRes.ok) { const t = await upRes.text(); return bad(`storage_upload_failed: ${t}`, 502); }

      const imageUrl = `${env.SUPABASE_URL}/storage/v1/object/public/rainbowkidz/${filename}`;

      // DB의 image_url 필드도 업데이트
      await supabase(`/rest/v1/system_users?id=eq.${charId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ image_url: imageUrl }),
      });

      return json({ ok: true, image_url: imageUrl });
    }

    // 매칭된 라우트 없음
    return json({ ok: false, error: 'not_found' }, 404);
  },
};
