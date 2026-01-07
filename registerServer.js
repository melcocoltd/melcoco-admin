// registerServer.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase秘密鍵（base64）読み込み ----------
let serviceAccount;
try {
  const b64 = process.env.FIREBASE_KEY_BASE64;
  if (!b64) throw new Error("FIREBASE_KEY_BASE64 is undefined");
  const jsonString = Buffer.from(b64, "base64").toString("utf8");
  serviceAccount = JSON.parse(jsonString);
  console.log("✅ Firebase key loaded (length:", jsonString.length, ")");
} catch (err) {
  console.error("❌ Failed to load Firebase key:", err.message);
  process.exit(1);
}

// ---------- Firebase 初期化 ----------
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

// ---------- メール送信（SMTP / Gmailアプリパスワード） ----------
const SMTP_USER = process.env.SMTP_USER; // 送信元Gmail（必須）
const FROM = process.env.SMTP_FROM || `"MELCOCOサポート" <${SMTP_USER}>`;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") !== "false",
  auth: {
    user: SMTP_USER,
    pass: process.env.SMTP_PASS, // Gmailのアプリパスワード（16桁）
  },
});

// ✅ SMTP疎通チェック（起動時）
transporter.verify((err) => {
  if (err) {
    console.error("❌ SMTP verify failed:", err);
  } else {
    console.log("✅ SMTP server is ready");
  }
});

/** プレーンテキスト送信（UTF-8） */
async function sendMailPlain({ to, subject, text }) {
  return transporter.sendMail({
    from: FROM,
    to,
    subject,
    text,
  });
}

// ---------- ヘルスチェック ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- util ----------
function yyyyMmDdNowUTC() {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

function normalizeApps(apps) {
  // フォームから apps が
  // 1) { agent:{...}, irontimer:{...}, androidtimer:{...} } の「オブジェクト」
  // 2) ["agent","timer"] の「配列」
  // どっちでも来る可能性があるので両対応で正規化する
  if (apps && typeof apps === "object" && !Array.isArray(apps)) {
    return apps; // objectのまま採用
  }
  if (Array.isArray(apps)) {
    // 旧形式なら最低限の形にする
    const o = {};
    for (const k of apps) o[k] = {};
    return o;
  }
  // 未指定ならデフォ
  return {
    agent: { loginCount: 0 },
    irontimer: { deviceId: "", switchCount: 0, trialStartDate: yyyyMmDdNowUTC() },
    androidtimer: { deviceId: "", switchCount: 0, trialStartDate: yyyyMmDdNowUTC() },
  };
}

function pickTrialStartDate(appsObj) {
  // apps.irontimer.trialStartDate or apps.androidtimer.trialStartDate があればそれ優先
  // なければ today
  const cand =
    appsObj?.irontimer?.trialStartDate ||
    appsObj?.androidtimer?.trialStartDate ||
    appsObj?.timer?.trialStartDate ||
    appsObj?.android?.trialStartDate ||
    "";
  return cand || yyyyMmDdNowUTC();
}

// ---------- 申請受付（体験版 / 本会員） ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};

  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = String(status).toLowerCase() === "trial";

  // apps 正規化
  const appsObj = normalizeApps(apps);
  const trialStartDate = pickTrialStartDate(appsObj);

  try {
    // 1) Firebase Auth 作成
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    // 2) Firestore 保存（users/{uid}）
    // ✅ ここが重要：apps は「object」として保存（Swiftもこの形を読む）
    const docData = {
      status,                 // "trial" or "active"
      email,
      displayName: name,
      salonName,
      prefecture,
      apps: appsObj,          // object形式
    };

    // trial のときは trialStartDate をトップにも置く（保険）
    if (trialMode) {
      docData.trialStartDate = trialStartDate; // yyyy-mm-dd
      // apps側に trialStartDate が無いキーがあれば入れておく（保険）
      if (docData.apps.irontimer && !docData.apps.irontimer.trialStartDate) {
        docData.apps.irontimer.trialStartDate = trialStartDate;
      }
      if (docData.apps.androidtimer && !docData.apps.androidtimer.trialStartDate) {
        docData.apps.androidtimer.trialStartDate = trialStartDate;
      }
    }

    await db.collection("users").doc(userRecord.uid).set(docData, { merge: true });

    // 3) 先に応答（フォーム側はここで成功表示になる）
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) メール送信（非同期）
    sendAdminMail({
      email,
      name,
      salonName,
      prefecture,
      appsObj,
      trialMode,
      uid: userRecord.uid,
    }).catch((e) => console.error("admin mail error:", e));

    sendUserMail({
      email,
      name,
      trialMode,
    }).catch((e) => console.error("user mail error:", e));

    if (process.env.SEND_VERIFY_LINK === "true") {
      sendVerificationEmail(email).catch((e) =>
        console.error("verify mail error:", e)
      );
    }
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// ---------- 管理者通知 ----------
async function sendAdminMail({ email, name, salonName, prefecture, appsObj, trialMode, uid }) {
  const subject = `【MELCOCO】${trialMode ? "体験版" : "本会員"}アプリ申請が届きました`;
  const text = [
    "【申請内容】",
    `UID: ${uid}`,
    `サロン名: ${salonName}`,
    `都道府県: ${prefecture}`,
    `氏名: ${name}`,
    `メール: ${email}`,
    `apps: ${JSON.stringify(appsObj)}`,
  ].join("\n");

  await sendMailPlain({
    to: process.env.ADMIN_MAIL_TO || SMTP_USER,
    subject,
    text,
  });
}

// ---------- 申請者向けメール ----------
async function sendUserMail({ email, name, trialMode }) {
  const loginUrl =
    process.env.LOGIN_URL || "https://melco-hairdesign.com/pwa/login.html";

  const subject = trialMode
    ? "【MELCOCO】体験版のご案内（7日間）"
    : "【MELCOCO】本会員のご案内";

  const lines = trialMode
    ? [
        `${name} 様`,
        "",
        "MELCOCOアプリ体験版へのお申し込みありがとうございます。",
        "7日間の無料体験期間中、以下のURLからログインしてご利用いただけます。",
        "",
        "ログインURL:",
        loginUrl,
        "",
        "ログインパスワード: melcoco",
        "",
        "※体験版のご利用期間は7日間です。",
        "継続してご利用されたい場合は、有料オンラインサロン「ココナッツ研究室」へご入会ください。",
        "ご案内: https://melcoco.jp/coconut-lab/",
        "",
        "ご不明な点がございましたら、お気軽にお問い合わせください。",
        "",
        "MELCOCOサポート",
      ]
    : [
        `${name} 様`,
        "",
        "MELCOCOアプリへのお申し込みありがとうございます。",
        "",
        "ログインURL:",
        loginUrl,
        "",
        "ログインパスワード: melcoco",
        "",
        "ご不明な点がございましたら、お気軽にお問い合わせください。",
        "",
        "MELCOCOサポート",
      ];

  await sendMailPlain({
    to: email,
    subject,
    text: lines.join("\n"),
  });
}

// ---------- Firebase メール確認リンク（任意） ----------
async function sendVerificationEmail(email) {
  const actionCodeSettings = {
    url: process.env.ACTION_URL || "https://melco-hairdesign.com/pwa/login.html",
    handleCodeInApp: true,
  };
  const link = await admin
    .auth()
    .generateEmailVerificationLink(email, actionCodeSettings);

  await sendMailPlain({
    to: email,
    subject: "【MELCOCO】メールアドレスの確認",
    text: `以下のリンクをクリックしてメール確認を完了してください。\n${link}`,
  });
}

// ---------- デバッグ用：SMTPテスト送信 ----------
app.get("/debug/email/test", async (req, res) => {
  try {
    const to = req.query.to || SMTP_USER;
    const r = await sendMailPlain({
      to,
      subject: "【テスト】MELCOCO SMTP送信",
      text: "このメールが届けば Gmail SMTP（アプリパスワード）経由で送れています。",
    });
    res.json({ ok: true, messageId: r.messageId, accepted: r.accepted });
  } catch (e) {
    console.error("SMTP test send error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- Render必須: PORTでlisten ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
