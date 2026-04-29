/**
 * server.js
 * LXP 동영상 플레이어 Node.js 백엔드
 *
 * API 엔드포인트:
 *   GET  /api/session/:id/info          → 세션 정보 (채널 수, duration 등)
 *   GET  /api/session/:id/attendance    → 내 출석 현황 (userId 쿼리 파라미터)
 *   GET  /api/session/:id/summary       → 전체 수강생 출석 현황 (교수자용)
 *   POST /api/session/:id/poll/start    → 해당 세션 폴링 시작
 *   POST /api/session/:id/poll/stop     → 폴링 중단
 */

require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const path           = require('path');
const PanoptoClient  = require('./src/panopto');
const AttendanceEngine = require('./src/attendance');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── 미들웨어 ── */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8시간
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ── 파놉토 클라이언트 + 출석 엔진 초기화 ── */
const panopto = new PanoptoClient(
  process.env.PANOPTO_SERVER,
  process.env.PANOPTO_CLIENT_ID,
  process.env.PANOPTO_CLIENT_SECRET
);

const attendance = new AttendanceEngine({
  panoptoServer:     process.env.PANOPTO_SERVER,
  clientId:          process.env.PANOPTO_CLIENT_ID,
  clientSecret:      process.env.PANOPTO_CLIENT_SECRET,
  threshold:         parseFloat(process.env.ATTENDANCE_THRESHOLD || '0.80'),
  pollingIntervalSec: parseInt(process.env.POLLING_INTERVAL_SEC  || '30')
});

/* ════════════════════════════════════════
   API 라우터
════════════════════════════════════════ */

/* ── 세션 정보 + 채널 수 자동 감지 ── */
app.get('/api/session/:id/info', async (req, res) => {
  const { id } = req.params;
  try {
    const session    = await panopto.getSession(id);
    const streamCount = await panopto.getStreamCount(id);

    res.json({
      ok: true,
      sessionId:    id,
      title:        session.Name || session.Title || '',
      duration:     session.Duration || 0,
      streamCount,                          // 1 또는 2 (채널 수)
      isMultiStream: streamCount >= 2,
      createdAt:    session.CreatedDate,
      embedUrl: `https://${process.env.PANOPTO_SERVER}/Panopto/Pages/Embed.aspx` +
                `?id=${id}&autoplay=false&offerviewer=true&showtitle=true` +
                `&showbrand=true&captions=true&interactivity=all`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── 내 출석 현황 조회 ──
 * Query: ?userId=xxx
 * LTI 환경에서는 session에 userId가 있으므로 req.session.userId 사용
 */
app.get('/api/session/:id/attendance', async (req, res) => {
  const { id }    = req.params;
  const userId    = req.query.userId || req.session?.userId;
  const threshold = parseFloat(process.env.ATTENDANCE_THRESHOLD || '0.80');

  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId 필요' });
  }

  // 폴링이 없으면 즉시 한 번 조회
  let record = attendance.getRecord(id, userId);
  if (!record) {
    // 직접 파놉토 API 호출
    try {
      const stat = await panopto.getUserViewingPercent(id, userId);
      record = {
        userId,
        percent:       stat.percent,
        secondsViewed: stat.secondsViewed,
        duration:      stat.duration,
        resumeCount:   0,
        isAttended:    stat.percent >= threshold * 100,
        updatedAt:     new Date()
      };
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  res.json({
    ok: true,
    sessionId:     id,
    userId,
    percent:       parseFloat(record.maxPercent || 0).toFixed(1),
    secondsViewed: record.secondsViewed || 0,
    duration:      record.duration      || 0,
    resumeCount:   record.resumeCount   || 0,
    isAttended:    record.isAttended    || false,
    threshold:     threshold * 100,
    updatedAt:     record.updatedAt
  });
});

/* ── 전체 출석 현황 (교수자/관리자용) ── */
app.get('/api/session/:id/summary', async (req, res) => {
  const { id } = req.params;
  try {
    const summary = attendance.getSessionSummary(id);

    // 메모리에 없으면 파놉토에서 직접 조회
    if (summary.total === 0) {
      const stats    = await panopto.getSessionViewingStats(id);
      const threshold = parseFloat(process.env.ATTENDANCE_THRESHOLD || '0.80') * 100;
      const records  = (stats.Results || []).map(r => ({
        userId:        r.UserId,
        userName:      r.UserName || '',
        percent:       (r.ViewPercentage || 0).toFixed(1),
        secondsViewed: r.SecondsViewed || 0,
        duration:      r.Duration      || 0,
        resumeCount:   0,
        isAttended:    (r.ViewPercentage || 0) >= threshold,
        updatedAt:     new Date()
      }));

      return res.json({
        ok: true,
        sessionId: id,
        total:     records.length,
        attended:  records.filter(r => r.isAttended).length,
        rate:      records.length
          ? (records.filter(r=>r.isAttended).length / records.length * 100).toFixed(1)
          : 0,
        threshold: threshold,
        records
      });
    }

    res.json({
      ok: true,
      sessionId: id,
      threshold: parseFloat(process.env.ATTENDANCE_THRESHOLD || '0.80') * 100,
      ...summary
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── 폴링 시작 ── */
app.post('/api/session/:id/poll/start', (req, res) => {
  const { id } = req.params;
  attendance.startPolling(id);
  res.json({ ok: true, message: `${id} 폴링 시작` });
});

/* ── 폴링 중단 ── */
app.post('/api/session/:id/poll/stop', (req, res) => {
  const { id } = req.params;
  attendance.stopPolling(id);
  res.json({ ok: true, message: `${id} 폴링 중단` });
});

/* ── 헬스체크 ── */
app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    server:    process.env.PANOPTO_SERVER,
    threshold: process.env.ATTENDANCE_THRESHOLD,
    polling:   process.env.POLLING_INTERVAL_SEC + 's',
    uptime:    Math.floor(process.uptime()) + 's'
  });
});

/* ── 메인 페이지 ── */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── 서버 시작 ── */
app.listen(PORT, () => {
  console.log(`\n🎬 건양 LXP 파놉토 서버 구동 중`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Panopto: https://${process.env.PANOPTO_SERVER}`);
  console.log(`   출석 기준: ${parseFloat(process.env.ATTENDANCE_THRESHOLD||'0.8')*100}%`);
  console.log(`   폴링 주기: ${process.env.POLLING_INTERVAL_SEC}초\n`);
});

module.exports = app;
