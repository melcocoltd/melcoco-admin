// registerServer.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// --- Firebase 秘密鍵（base64） ---
let serviceAccount;
try {
  if (!process.env.FIREBASE_KEY_BASE64) {
    throw new Error("FIREBASE_KEY_BASE64 is undefined");
  }
  const jsonString = Buffer.from(process.env.FIREBASE_KEY_BASE64, "base64").toString("utf8");
  serviceAccount = JSON.parse(jsonString);
  console.log("✅ Firebase key loaded (length:", jsonString.length, ")");
} catch (err) {
  console.error("❌ Failed to load Firebase key:", err.message);
  process.exit(1);
}

// --- Firebase 初期化 ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const auth = admin.auth();

// --- Nodemailer (Gmail アプリパス推奨) ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER || "melco.coltd.japan@gmail.com",
    pass: process.env.SMTP_PASS, // ← Render の環境変数に置く（アプリパスワード）
  },
  connectionTimeout: 10000,
  socketTimeout: 10000,
});

// ヘルスチェック
app.get("/health", (_req, res) => res.json({ ok: true }));

// 申請受付（体験版 / 本会員）
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};
  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  try {
    // 1) Firebase Auth ユーザー作成
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    // 2) Firestore 登録
    await db.collection("users").doc(userRecord.uid).set({
      status,
      email,
      displayName: name,
      salonName,
      prefecture,
      apps: Array.isArray(apps) ? apps : ["agent", "timer"],
      ...(trialMode && { trialStartDate: new Date().toISOString() }),
    });

    // 3) 先に200を返す（メール送信でブロックしない）
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) 背景でメール送信（失敗はログ出しのみ）
    sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }).catch(console.error);
    sendUserMail({ email, name, trialMode }).catch(console.error);

    // （必要なら）メール確認リンクも送る
    if (process.env.SEND_VERIFY_LINK === "true") {
      sendVerificationEmail(email).catch(console.error);
    }
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// 管理者通知
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

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER || "melco.coltd.japan@gmail.com"}>`,
    to: process.env.ADMIN_MAIL_TO || (process.env.SMTP_USER || "melco.coltd.japan@gmail.com"),
    subject,
    text,
  });
}

// 申請者向けメール（体験版の案内）
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
        `ログインURL:`,
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

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER || "melco.coltd.japan@gmail.com"}>`,
    to: email,
    subject,
    text: lines.join("\n"),
  });
}

// Firebase の確認メールリンクを生成して送信（任意）
async function sendVerificationEmail(email) {
  const actionCodeSettings = {
    url: process.env.ACTION_URL || "https://melco-hairdesign.com/pwa/login.html",
    handleCodeInApp: true,
  };
  const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER || "melco.coltd.japan@gmail.com"}>`,
    to: email,
    subject: "【MELCOCO】メールアドレスの確認",
    html: `<p>以下のリンクをクリックしてメール確認を完了してください。</p><p><a href="${link}">${link}</a></p>`,
  });
}

// --- Render 必須: PORT で listen ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));