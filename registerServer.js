// registerServer.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { google } = require("googleapis");

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

// ---------- Gmail API（OAuth2） ----------
const GMAIL_USER = process.env.GMAIL_USER;
const FROM = process.env.SMTP_FROM || `"MELCOCOサポート" <${GMAIL_USER}>`;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
  // redirect_uri は送信時は不要
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

function toBase64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Gmail API でプレーンテキストメール送信 */
async function sendViaGmailAPI({ to, subject, text }) {
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  const raw =
    `From: ${FROM}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `${text}`;

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: toBase64Url(raw) },
  });
  return res.data;
}

// ---------- ヘルスチェック ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- 申請受付（体験版 / 本会員） ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};
  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  try {
    // 1) Firebase Auth 作成
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
      apps: Array.isArray(apps) ? apps : ["agent", "timer"],
      ...(trialMode && { trialStartDate: new Date().toISOString() }),
    });

    // 3) まず応答を返す
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) メール送信（裏側で）
    sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }).catch(e =>
      console.error("admin mail error:", e)
    );
    sendUserMail({ email, name, trialMode }).catch(e =>
      console.error("user mail error:", e)
    );

    if (process.env.SEND_VERIFY_LINK === "true") {
      sendVerificationEmail(email).catch(e =>
        console.error("verify mail error:", e)
      );
    }
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
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
    `対象アプリ: ${JSON.stringify(apps || ["agent", "timer"])}`,
  ].join("\n");

  await sendViaGmailAPI({
    to: process.env.ADMIN_MAIL_TO || GMAIL_USER,
    subject,
    text,
  });
}

// ---------- 申請者向けメール ----------
async function sendUserMail({ email, name, trialMode }) {
  const loginUrl = process.env.LOGIN_URL || "https://melco-hairdesign.com/pwa/login.html";
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
        "今後ともどうぞよろしくお願いいたします。",
        "",
        "MELCOCOサポート",
      ]
    : [
        `${name} 様`,
        "",
        "MELCOCOアプリへのお申し込みありがとうございます。",
        `ログインURL: ${loginUrl}`,
        "",
        "ご不明な点がございましたら、お気軽にお問い合わせください。",
        "",
        "MELCOCOサポート",
      ];

  await sendViaGmailAPI({
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
  const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

  await sendViaGmailAPI({
    to: email,
    subject: "【MELCOCO】メールアドレスの確認",
    text: `以下のリンクをクリックしてメール確認を完了してください。\n${link}`,
  });
}

// ---------- デバッグ用エンドポイント ----------
app.get("/debug/email/verify", async (_req, res) => {
  try {
    const token = (await oAuth2Client.getAccessToken()).token;
    res.json({ ok: true, tokenExists: !!token });
  } catch (e) {
    console.error("OAuth verify error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/debug/email/test", async (req, res) => {
  try {
    const to = req.query.to || GMAIL_USER;
    const r = await sendViaGmailAPI({
      to,
      subject: "【テスト】MELCOCO Gmail API送信",
      text: "このメールが届けば Gmail API 経由で送れています。",
    });
    res.json({ ok: true, id: r.id, labelIds: r.labelIds });
  } catch (e) {
    console.error("Gmail API test send error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- Render必須: PORTでlisten ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));