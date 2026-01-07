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
const SMTP_USER = process.env.SMTP_USER; // 送信元Gmail
if (!SMTP_USER) {
  console.error("❌ SMTP_USER is undefined");
  process.exit(1);
}

const FROM = process.env.SMTP_FROM || `"MELCOCOサポート" <${SMTP_USER}>`;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") !== "false", // "true"ならtrue
  auth: {
    user: SMTP_USER,
    pass: process.env.SMTP_PASS, // Googleのアプリパスワード（16桁）
  },
});

// ✅ SMTP疎通チェック（起動時）※ createTransport の「外」に置く
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP verify failed:", err);
  } else {
    console.log("✅ SMTP server is ready:", success);
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

// ---------- 申請受付（体験版 / 本会員） ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};
  if (!email || !salonName || !prefecture || !name || !status) {
    return res
      .status(400)
      .json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  // ✅ apps の受け取りを「配列でもオブジェクトでもOK」にする
  // 推奨：オブジェクト（agent/irontimer/androidtimer）
  const defaultAppsObj = {
    agent: { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
    irontimer: { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
    androidtimer: { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
  };

  const appsToSave =
    apps && typeof apps === "object" && !Array.isArray(apps)
      ? apps
      : Array.isArray(apps)
      ? apps.reduce((acc, k) => {
          acc[k] = { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" };
          return acc;
        }, {})
      : defaultAppsObj;

  try {
    // 1) Firebase Auth 作成（すでに存在したらエラーになるので注意）
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    // 2) Firestore 保存
    await db.collection("users").doc(userRecord.uid).set({
      status,
      email,
      displayName: name,
      salonName,
      prefecture,
      apps: appsToSave,
      ...(trialMode && { trialStartDate: new Date().toISOString() }),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 3) 先に応答
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) メール送信（非同期）
    sendAdminMail({ email, name, salonName, prefecture, apps: appsToSave, trialMode }).catch((e) =>
      console.error("admin mail error:", e)
    );
    sendUserMail({ email, name, trialMode }).catch((e) =>
      console.error("user mail error:", e)
    );

    if (process.env.SEND_VERIFY_LINK === "true") {
      sendVerificationEmail(email).catch((e) =>
        console.error("verify mail error:", e)
      );
    }
  } catch (e) {
    console.error("register error:", e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "server error" });
  }
});

// ---------- 管理者通知 ----------
async function sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }) {
  const subject = `【MELCOCO】${trialMode ? "体験版" : "本会員"}アプリ申請が届きました`;

  const text = [
    "【申請内容】",
    `サロン名: ${salonName}`,
    `都道府県: ${prefecture}`,
    `氏名: ${name}`,
    `メール: ${email}`,
    `対象アプリ: ${prettyJSON(apps)}`,
  ].join("\n");

  await sendMailPlain({
    to: process.env.ADMIN_MAIL_TO || SMTP_USER,
    subject,
    text,
  });
}

// ---------- 申請者向けメール（iOS / Android 両方のURLを載せる） ----------
async function sendUserMail({ email, name, trialMode }) {
  const ANDROID_LOGIN_URL =
    process.env.ANDROID_LOGIN_URL || "https://melco-hairdesign.com/pwa/login.html";

  // iPhone向け：ネイティブアプリ案内ページ（TestFlight/AppStore/導線ページどれでもOK）
  const IOS_APP_URL =
    process.env.IOS_APP_URL || "https://melcoco.jp/irontimer-ios/";

  const subject = trialMode
    ? "【MELCOCO】体験版のご案内（7日間）"
    : "【MELCOCO】本会員のご案内";

  const lines = trialMode
    ? [
        `${name} 様`,
        "",
        "MELCOCOアプリ体験版へのお申し込みありがとうございます。",
        "7日間の無料体験期間中、以下の案内に沿ってご利用ください。",
        "",
        "【iPhone の方】（アイロンタイマー）",
        IOS_APP_URL,
        "",
　　　　　"【Android の方】（PWAでログイン）",
        ANDROID_LOGIN_URL,
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
        "【iPhone の方】（ネイティブアプリ）",
        IOS_APP_URL,
        "",
        "【Android の方】（PWAでログイン）",
        ANDROID_LOGIN_URL,
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

// ---------- デバッグ用エンドポイント ----------
app.get("/debug/email/test", async (req, res) => {
  try {
    const to = req.query.to || SMTP_USER;
    const r = await sendMailPlain({
      to,
      subject: "【テスト】MELCOCO SMTP送信",
      text: "このメールが届けば SMTP 送信はOKです。",
    });
    res.json({ ok: true, messageId: r.messageId, accepted: r.accepted });
  } catch (e) {
    console.error("SMTP test send error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- Utils ----------
function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}
function prettyJSON(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

// ---------- Render必須: PORTでlisten ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
