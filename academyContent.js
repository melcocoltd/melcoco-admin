// ===========================================
// メルコアカデミー 会員ページ API（Render / Express）
// ===========================================
// GET /academy/content?id=5478
//   Header: Authorization: Bearer <FirebaseのIDトークン>
//
//  1. IDトークンを検証（無効・失効 → 401）
//  2. Firestore users/{uid}.status が "active" か確認（それ以外 → 403）
//  3. WPの非公開LPを アプリケーションパスワード で取得して本文を返す
//
// ■ 組み込み方（server.js 等）
//     const academyContent = require("./academyContent");
//     app.use("/academy", academyContent(admin));   // admin は初期化済みの firebase-admin
//
// ■ Render の Environment に追加
//     WP_USER            … WPのユーザー名（編集者以上）
//     WP_APP_PASSWORD    … そのユーザーで発行したアプリケーションパスワード
//     ACADEMY_WP_IDS     … 表示を許可するLPのID（カンマ区切り） 例: 5478
//     WP_LP_PASSWORD     … LPに設定した「パスワード保護」のパスワード（会員には教えない）
//     MEMBER_INSTAGRAM_URL … 会員用InstagramのURL（active会員にだけ返す）
//   任意:
//     WP_API_BASE        … 既定 https://melcoco.jp/wp-json/wp/v2
//     WP_POST_TYPE       … 既定 lp
//     ACADEMY_ALLOWED_ORIGINS … 既定 https://melcoco.jp,https://www.melcoco.jp
//     USERS_COLLECTION   … 既定 users
//
// ※ Node 18以上（fetch 標準搭載）が前提
// ===========================================

const express = require("express");

module.exports = function academyContent(admin) {
  const router = express.Router();

  const WP_API_BASE = process.env.WP_API_BASE || "https://melcoco.jp/wp-json/wp/v2";
  const WP_POST_TYPE = process.env.WP_POST_TYPE || "lp";
  const WP_USER = process.env.WP_USER || "";
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
  const WP_LP_PASSWORD = process.env.WP_LP_PASSWORD || "";
  // 会員用リンク（HTMLには書かず、active会員にだけ返す）
  const MEMBER_LINKS = {
    instagram: process.env.MEMBER_INSTAGRAM_URL || "",
  };
  const USERS_COLLECTION = process.env.USERS_COLLECTION || "users";
  const ALLOWED_IDS = (process.env.ACADEMY_WP_IDS || "5478")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const ALLOWED_ORIGINS = (process.env.ACADEMY_ALLOWED_ORIGINS || "https://melcoco.jp,https://www.melcoco.jp")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // WP本文のキャッシュ（事務局の更新は最大1分で反映）
  const CACHE_MS = 60 * 1000;
  const cache = new Map(); // id -> { html, title, at }

  // ---------- CORS ----------
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ---------- 会員チェック ----------
  async function requireActiveMember(req, res, next) {
    const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: "no_token" });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(match[1], true); // 失効チェックあり
    } catch (e) {
      return res.status(401).json({ error: "invalid_token" });
    }

    try {
      const snap = await admin.firestore().collection(USERS_COLLECTION).doc(decoded.uid).get();
      const status = snap.exists ? snap.get("status") : null;
      if (status !== "active") return res.status(403).json({ error: "not_active" });
      req.userRef = snap.ref;
      req.hasFirstView = !!snap.get("academy.firstViewedAt");
    } catch (e) {
      console.error("[academy] firestore error", e);
      return res.status(500).json({ error: "server_error" });
    }

    req.uid = decoded.uid;
    next();
  }

  // ---------- WP取得 ----------
  async function fetchWpContent(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;

    // ① LPがパスワード保護 → ?password= で取得（WPサーバー設定に左右されない）
    // ② LPが非公開 → アプリケーションパスワード（Basic認証）で取得
    const params = new URLSearchParams({ _fields: "title,content" });
    if (WP_LP_PASSWORD) params.set("password", WP_LP_PASSWORD);
    const url = `${WP_API_BASE}/${WP_POST_TYPE}/${encodeURIComponent(id)}?${params}`;
    const headers = {};
    if (WP_USER && WP_APP_PASSWORD) {
      headers.Authorization = `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
    }
    const wpRes = await fetch(url, { headers });

    if (wpRes.status === 404) return null;
    if (!wpRes.ok) {
      // 原因が分かるようにWPのエラーコードもログに出す（パスワード等は出さない）
      let detail = "";
      try { const j = await wpRes.json(); detail = `${j.code || ""} ${j.message || ""}`; } catch (e) {}
      throw new Error(`WP ${wpRes.status} ${detail} (lpPassword: ${WP_LP_PASSWORD ? "set" : "EMPTY"}, appPassword: ${WP_APP_PASSWORD ? "set" : "EMPTY"})`);
    }

    const data = await wpRes.json();
    const item = {
      html: (data.content && data.content.rendered) || "",
      title: (data.title && data.title.rendered) || "",
      at: Date.now(),
    };
    cache.set(id, item);
    return item;
  }

  // ---------- 閲覧記録（users/{uid}.academy） ----------
  //  viewCount     … 会員ページを開いた回数（再読み込みも1回）
  //  lastViewedAt  … 最後に開いた日時
  //  firstViewedAt … 初めて開いた日時
  async function recordView(req) {
    if (!req.userRef) return;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const update = {
      "academy.viewCount": admin.firestore.FieldValue.increment(1),
      "academy.lastViewedAt": now,
    };
    if (!req.hasFirstView) update["academy.firstViewedAt"] = now;
    await req.userRef.update(update);
  }

  // ---------- ルート ----------
  router.get("/content", requireActiveMember, async (req, res) => {
    const id = String(req.query.id || ALLOWED_IDS[0] || "");
    if (!ALLOWED_IDS.includes(id)) return res.status(404).json({ error: "not_found" });

    try {
      const item = await fetchWpContent(id);
      if (!item) return res.status(404).json({ error: "not_found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ title: item.title, html: item.html, links: MEMBER_LINKS });
      recordView(req).catch((e) => console.error("[academy] view log error", e));
    } catch (e) {
      console.error("[academy] wp error", e);
      res.status(502).json({ error: "wp_error" });
    }
  });

  return router;
};
