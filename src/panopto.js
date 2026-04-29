/**
 * panopto.js
 * 파놉토 OAuth2 인증 + REST API 래퍼
 *
 * 주요 엔드포인트:
 *   GET /api/v1/sessions/{id}                → 세션 기본 정보 (duration, streamCount 등)
 *   GET /api/v1/sessions/{id}/viewingStats   → 세션 시청자별 시청 통계
 *   GET /api/v1/users/current                → 현재 사용자 정보
 */

const axios = require('axios');

class PanoptoClient {
  constructor(serverName, clientId, clientSecret) {
    this.serverName   = serverName;
    this.clientId     = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl      = `https://${serverName}`;
    this.accessToken  = null;
    this.tokenExpiry  = null;
  }

  /* ── OAuth2 Client Credentials Grant ── */
  async getAccessToken() {
    // 만료 60초 전에 재발급
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     this.clientId,
      client_secret: this.clientSecret,
      scope:         'api'
    });

    try {
      const res = await axios.post(
        `${this.baseUrl}/Panopto/oauth2/connect/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      this.accessToken = res.data.access_token;
      this.tokenExpiry = Date.now() + (res.data.expires_in * 1000);
      console.log('[Panopto] 액세스 토큰 발급 성공');
      return this.accessToken;
    } catch (err) {
      console.error('[Panopto] 토큰 발급 실패:', err.response?.data || err.message);
      throw err;
    }
  }

  /* ── 공통 API 요청 ── */
  async request(method, path, params = {}) {
    const token = await this.getAccessToken();
    try {
      const res = await axios({
        method,
        url:     `${this.baseUrl}/Panopto/api/v1${path}`,
        headers: { Authorization: `Bearer ${token}` },
        params:  method === 'GET' ? params : undefined,
        data:    method !== 'GET' ? params : undefined,
      });
      return res.data;
    } catch (err) {
      console.error(`[Panopto] API 오류 ${method} ${path}:`, err.response?.data || err.message);
      throw err;
    }
  }

  /* ── 세션 기본 정보 ── */
  async getSession(sessionId) {
    return this.request('GET', `/sessions/${sessionId}`);
  }

  /* ── 세션 시청 통계 (학생별 시청 비율)
   *
   * 응답 구조:
   * {
   *   Results: [
   *     {
   *       UserId:           "...",
   *       UserKey:          "student@kyunyang.ac.kr",
   *       PercentCompleted: 80.0,
   *       LastViewedDateTime: "2025-03-24T04:33:58.541Z"
   *     }, ...
   *   ],
   *   TotalNumberResults: 42
   * }
   */
  async getSessionViewingStats(sessionId, page = 0, perPage = 100) {
    return this.request('GET', `/sessions/${sessionId}/viewers`, {
      pageNumber: page,
      pageSize:   perPage
    });
  }

  /* ── 특정 사용자의 세션 시청 비율만 조회 ── */
  async getUserViewingPercent(sessionId, userId) {
    try {
      const stats = await this.getSessionViewingStats(sessionId);
      const userStat = (stats.Results || []).find(r => r.UserId === userId);
      if (!userStat) return { percent: 0, secondsViewed: 0, duration: 0 };
      return {
        percent:       userStat.ViewPercentage || 0,
        secondsViewed: userStat.SecondsViewed  || 0,
        duration:      userStat.Duration       || 0
      };
    } catch {
      return { percent: 0, secondsViewed: 0, duration: 0 };
    }
  }

  /* ── 세션의 스트림(채널) 수 조회 → 1채널/2채널 자동 감지 ── */
  async getStreamCount(sessionId) {
    try {
      const session = await this.getSession(sessionId);
      // Streams 배열이 있으면 그 길이, 없으면 1
      return (session.Streams && session.Streams.length) || 1;
    } catch {
      return 1;
    }
  }
}

module.exports = PanoptoClient;
