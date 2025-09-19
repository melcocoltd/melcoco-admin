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

// ---------- Nodemailer (Gmail アプリパスワード) ----------
if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn("⚠️ SMTP_USER / SMTP_PASS is missing. Emails will fail.");
}
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,        // STARTTLS を使うので false
  requireTLS: true,     // 接続後に TLS 必須
  auth: {
    user: process.env.SMTP_USER,     // 送信元Gmail
    pass: process.env.SMTP_PASS,     // 16桁のアプリパスワード
  },
  connectionTimeout: 20000,
  socketTimeout: 20000,
  tls: { minVersion: "TLSv1.2", servername: "smtp.gmail.com" },
});

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

    // 3) まずは応答を返す（メール送信でブロックしない）
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) 裏でメール送信（失敗はログに残す）
    sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }).catch((e) =>
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

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER}>`,
    to: process.env.ADMIN_MAIL_TO || process.env.SMTP_USER,
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

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER}>`,
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

  await transporter.sendMail({
    from: `"MELCOCOサポート" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "【MELCOCO】メールアドレスの確認",
    html: `<p>以下のリンクをクリックしてメール確認を完了してください。</p><p><a href="${link}">${link}</a></p>`,
  });
}

// ---------- デバッグ用エンドポイント ----------
app.get("/debug/email/verify", async (_req, res) => {
  try {
    const info = await transporter.verify();
    res.json({ ok: true, info });
  } catch (e) {
    console.error("SMTP verify error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/debug/email/test", async (req, res) => {
  try {
    const to = req.query.to || process.env.SMTP_USER;
    const r = await transporter.sendMail({
      from: `"MELCOCOサポート" <${process.env.SMTP_USER}>`,
      to,
      subject: "【テスト】MELCOCO メール送信テスト",
      text: "このメールが届けばSMTPは正常です。",
    });
    res.json({ ok: true, accepted: r.accepted, response: r.response });
  } catch (e) {
    console.error("SMTP test send error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- Render必須: PORTでlisten ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
