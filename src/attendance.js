/**
 * attendance.js
 * 출석 산정 엔진
 *
 * 동작 방식:
 *  1. 파놉토 REST API를 주기적으로 폴링
 *  2. 학생별 시청 비율을 메모리(+ 추후 DB)에 누적
 *  3. 임계값(기본 80%) 초과 시 출석 인정
 *  4. 이어보기: 이전 시청 비율에 새 시청 비율을 누적 (중복 구간 파놉토가 자동 처리)
 */

const PanoptoClient = require('./panopto');

class AttendanceEngine {
  constructor(config) {
    this.panopto   = new PanoptoClient(
      config.panoptoServer,
      config.clientId,
      config.clientSecret
    );
    this.threshold        = config.threshold || 0.80;
    this.pollingIntervalMs = (config.pollingIntervalSec || 30) * 1000;

    // 메모리 저장소: sessionId → { userId → AttendanceRecord }
    // 실운영에서는 DB(Oracle/PostgreSQL)로 교체
    this.store = new Map();

    // 활성 폴링 목록: sessionId → intervalId
    this.polls = new Map();
  }

  /* ── 세션 폴링 시작 ── */
  startPolling(sessionId) {
    if (this.polls.has(sessionId)) return;

    console.log(`[Attendance] 폴링 시작: ${sessionId}`);
    this.fetchAndUpdate(sessionId); // 즉시 1회 실행

    const id = setInterval(
      () => this.fetchAndUpdate(sessionId),
      this.pollingIntervalMs
    );
    this.polls.set(sessionId, id);
  }

  stopPolling(sessionId) {
    const id = this.polls.get(sessionId);
    if (id) { clearInterval(id); this.polls.delete(sessionId); }
  }

  /* ── 파놉토 API → 시청 통계 갱신 ── */
  async fetchAndUpdate(sessionId) {
    try {
      const stats = await this.panopto.getSessionViewingStats(sessionId);
      const results = stats.Results || [];

      if (!this.store.has(sessionId)) this.store.set(sessionId, new Map());
      const sessionStore = this.store.get(sessionId);

      for (const r of results) {
        const userId = r.UserId;
        const prev   = sessionStore.get(userId) || {
          userId,
          userName:      r.UserName || '',
          firstSeenAt:   new Date(),
          resumeCount:   0,
          maxPercent:    0,
          secondsViewed: 0,
          duration:      r.Duration || 0,
          isAttended:    false,
          updatedAt:     null
        };

// 이어보기 감지: 이전 비율보다 낮아졌다가 다시 높아지는 패턴
        const newPct = r.PercentCompleted || 0;
        if (prev.updatedAt && newPct < prev.maxPercent - 2) {
          // 2% 이상 감소 → 새로운 시청 세션(이어보기) 시작
          prev.resumeCount++;
        }

        prev.maxPercent    = Math.max(prev.maxPercent, newPct);
        prev.secondsViewed = 0;
        prev.duration      = prev.duration || 0;
        prev.updatedAt     = new Date();

        // 출석 인정 판정 (한 번 인정되면 취소 안 됨)
        if (!prev.isAttended && prev.maxPercent >= this.threshold * 100) {
          prev.isAttended = true;
          console.log(`[Attendance] 출석 인정: ${prev.userName} (${prev.maxPercent.toFixed(1)}%)`);
        }

        sessionStore.set(userId, prev);
      }

      console.log(`[Attendance] ${sessionId} 갱신 완료 — ${results.length}명`);
    } catch (err) {
      console.error(`[Attendance] fetchAndUpdate 실패:`, err.message);
    }
  }

  /* ── 단일 사용자 출석 조회 ── */
  getRecord(sessionId, userId) {
    const s = this.store.get(sessionId);
    if (!s) return null;
    return s.get(userId) || null;
  }

  /* ── 세션 전체 출석 현황 ── */
  getSessionSummary(sessionId) {
    const s = this.store.get(sessionId);
    if (!s) return { total: 0, attended: 0, records: [] };

    const records  = Array.from(s.values());
    const attended = records.filter(r => r.isAttended).length;
    return {
      total:    records.length,
      attended,
      rate:     records.length ? (attended / records.length * 100).toFixed(1) : 0,
      records:  records.map(r => ({
        userId:        r.userId,
        userName:      r.userName,
        percent:       r.maxPercent.toFixed(1),
        secondsViewed: r.secondsViewed,
        duration:      r.duration,
        resumeCount:   r.resumeCount,
        isAttended:    r.isAttended,
        updatedAt:     r.updatedAt
      }))
    };
  }
}

module.exports = AttendanceEngine;
