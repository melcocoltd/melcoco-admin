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
const SMTP_USER = process.env.SMTP_USER; // 送信元Gmail（例: xxx@gmail.com）
const SMTP_PASS = process.env.SMTP_PASS; // Googleのアプリパスワード（16桁）

const FROM = process.env.SMTP_FROM || `"MELCOCOサポート" <${SMTP_USER}>`;

if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP_USER / SMTP_PASS が未設定です（メール送信は失敗します）");
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  // ✅ Gmailは587推奨（STARTTLS）
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true", // 587ならfalse推奨
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  // 一部環境で必要になることがある（厳格すぎるTLSで詰む時の逃げ）
  tls: {
    minVersion: "TLSv1.2",
  },
  connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT || 15000),
  greetingTimeout: Number(process.env.SMTP_GREET_TIMEOUT || 15000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20000),
});

// ✅ SMTP疎通チェック（起動時）
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP verify failed:", err?.message || err);
  } else {
    console.log("✅ SMTP server is ready:", success);
  }
});

/** プレーンテキスト送信（UTF-8） */
async function sendMailPlain({ to, subject, text }) {
  return transporter.sendMail({ from: FROM, to, subject, text });
}

// ---------- ヘルスチェック ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * apps を Firestore に保存する形を正規化する
 * - 配列 ["agent","timer"] が来てもOK（旧互換）
 * - オブジェクト {agent:{...}, irontimer:{...}} が来てもOK（新方式）
 */
function normalizeApps(apps, { trialMode }) {
  const today = new Date().toISOString().slice(0, 10);

  // 新方式：object
  if (apps && typeof apps === "object" && !Array.isArray(apps)) {
    // trialStartDate が無ければ入れておく（安全）
    const out = { ...apps };

    for (const k of Object.keys(out)) {
      if (out[k] && typeof out[k] === "object") {
        if (trialMode) {
          out[k].trialStartDate = out[k].trialStartDate || today;
        }
        // switchCount/loginCountが無ければ0
        if (out[k].switchCount === undefined) out[k].switchCount = 0;
        if (out[k].loginCount === undefined) out[k].loginCount = 0;
        if (out[k].deviceId === undefined) out[k].deviceId = "";
      }
    }
    return out;
  }

  // 旧方式：array
  const arr = Array.isArray(apps) ? apps : ["agent", "timer"];
  const out = {};
  for (const key of arr) {
    out[key] = { loginCount: 0 };
  }

  // 旧timerを新keyに寄せたいならここで変換も可
  // out["androidtimer"] = out["timer"]; delete out["timer"];

  if (trialMode) {
    // trial向けに iOS/Android timer 用の箱も用意（必要なら）
    out["irontimer"] = out["irontimer"] || {
      deviceId: "",
      switchCount: 0,
      trialStartDate: today,
    };
    out["androidtimer"] = out["androidtimer"] || {
      deviceId: "",
      switchCount: 0,
      trialStartDate: today,
    };
  }
  return out;
}

// ---------- 申請受付（体験版 / 本会員） ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};
  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  try {
    // 1) Firebase Auth 作成（既に存在する場合の対応も入れる）
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password: defaultPassword,
        displayName: name,
      });
    } catch (e) {
      // 既に同じメールがある場合はそのユーザーを取得して上書き更新
      if (e?.code === "auth/email-already-exists") {
        userRecord = await auth.getUserByEmail(email);
        await auth.updateUser(userRecord.uid, { displayName: name });
      } else {
        throw e;
      }
    }

    // 2) Firestore 保存（appsはオブジェクトで保存）
    const appsObj = normalizeApps(apps, { trialMode });

    await db.collection("users").doc(userRecord.uid).set(
      {
        status,
        email,
        displayName: name,
        salonName,
        prefecture,
        apps: appsObj,
      },
      { merge: true }
    );

    // 3) 先に応答（フォーム側は成功扱い）
    res.status(201).json({ ok: true, uid: userRecord.uid });

    // 4) メール送信（非同期）
    sendAdminMail({ email, name, salonName, prefecture, apps: appsObj, trialMode }).catch((e) =>
      console.error("admin mail error:", e?.message || e)
    );
    sendUserMail({ email, name, trialMode }).catch((e) =>
      console.error("user mail error:", e?.message || e)
    );

    if (process.env.SEND_VERIFY_LINK === "true") {
      sendVerificationEmail(email).catch((e) =>
        console.error("verify mail error:", e?.message || e)
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
    `対象アプリ: ${JSON.stringify(apps || {}, null, 2)}`,
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

  await sendMailPlain({ to: email, subject, text: lines.join("\n") });
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
      text: "このメールが届けば SMTP は通っています。",
    });
    res.json({ ok: true, messageId: r.messageId, accepted: r.accepted });
  } catch (e) {
    console.error("SMTP test send error:", e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Render必須: PORTでlisten ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
