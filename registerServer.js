// registerServer.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- プロセス例外ログ ----------
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
  process.exit(1);
});

// ---------- Firebase秘密鍵（base64） ----------
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

// ---------- SMTP ----------
const SMTP_USER = process.env.SMTP_USER;
if (!SMTP_USER) {
  console.error("❌ SMTP_USER is undefined");
  process.exit(1);
}

const FROM = process.env.SMTP_FROM || `"MELCOCOサポート" <${SMTP_USER}>`;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") !== "false",
  auth: {
    user: SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) console.error("❌ SMTP verify failed:", err);
  else console.log("✅ SMTP server is ready:", success);
});

async function sendMailPlain({ to, subject, text }) {
  return transporter.sendMail({ from: FROM, to, subject, text });
}

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

// ---------- apps ----------
// i- = iPhone / a- = Android
const APP_KEYS = ["i-agent", "i-timer", "i-color", "a-agent", "a-timer", "a-color"];

// 体験版のトライアル日数（フォームから trialDays が来なかったとき）
const DEFAULT_TRIAL_DAYS = 7;

// ---------- apps 正規化 ----------
// ・本会員（active）は trialStartDate を入れない（トライアル判定をしないため）
// ・体験版（trial）は trialStartDate が無ければ今日を入れる
function normalizeApps(apps, trialMode) {
  const base =
    apps && typeof apps === "object" && !Array.isArray(apps) ? apps : {};

  const result = {};
  const keys = Array.from(new Set([...APP_KEYS, ...Object.keys(base)]));

  for (const key of keys) {
    const a = base[key] && typeof base[key] === "object" ? base[key] : {};
    const out = {
      deviceId: typeof a.deviceId === "string" ? a.deviceId : "",
      loginCount: typeof a.loginCount === "number" ? a.loginCount : 0,
      switchCount: typeof a.switchCount === "number" ? a.switchCount : 0,
    };
    if (trialMode) out.trialStartDate = a.trialStartDate || todayYMD();
    result[key] = out;
  }
  return result;
}

// ---------- ヘルス ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- 登録 ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status, trialDays } = req.body || {};

  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  const appsToSave = normalizeApps(apps, trialMode);
  const days = Number(trialDays) > 0 ? Math.floor(Number(trialDays)) : DEFAULT_TRIAL_DAYS;

  try {
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password: defaultPassword,
        displayName: name,
      });
    } catch (e) {
      if (e?.code === "auth/email-already-exists") {
        userRecord = await auth.getUserByEmail(email);
      } else {
        throw e;
      }
    }

    const userDoc = db.collection("users").doc(userRecord.uid);
    const snap = await userDoc.get();

    if (!snap.exists) {
      // ---- 新規 ----
      await userDoc.set({
        status,
        email,
        displayName: name,
        salonName,
        prefecture,
        apps: appsToSave,
        ...(trialMode && { trialStartDate: new Date().toISOString(), trialDays: days }),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // ---- 既に登録あり（体験版→本会員など）----
      // 端末ID・ログイン回数などは消さずに、足りないアプリだけ追加する
      const current = snap.data() || {};
      const currentApps = current.apps || {};
      const mergedApps = { ...currentApps };
      for (const [key, value] of Object.entries(appsToSave)) {
        if (!mergedApps[key]) mergedApps[key] = value;
      }
      await userDoc.set(
        {
          status,
          email,
          displayName: name,
          salonName,
          prefecture,
          apps: mergedApps,
          ...(trialMode ? { trialDays: days } : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    res.status(201).json({ ok: true, uid: userRecord.uid });

    sendAdminMail({ email, name, salonName, prefecture, apps: appsToSave, trialMode }).catch(console.error);
    sendUserMail({ email, name, trialMode, trialDays: days }).catch(console.error);
  } catch (e) {
    console.error("register error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// ---------- 管理者メール ----------
async function sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }) {
  const subject = `【MELCOCO】${trialMode ? "体験版" : "本会員"}アプリ申請`;

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

// ---------- ユーザー通知 ----------
async function sendUserMail({ email, name, trialMode, trialDays }) {
  const IOS_AGENT_URL =
  process.env.IOS_AGENT_URL || "https://apps.apple.com/app/agentselectnative/id6757728872";

  const IOS_TIMER_URL =
  process.env.IOS_TIMER_URL || "https://apps.apple.com/app/irontimernative/id6757497537";
  
  // カラーカルテ：App Store公開後に Render の環境変数 IOS_COLOR_URL にURLを入れると、メールにリンクが載ります
  const IOS_COLOR_URL = process.env.IOS_COLOR_URL || "";
  const COLOR_LINE = IOS_COLOR_URL || "（App Store公開準備中です。公開しましたら改めてご案内いたします）";

  
  const subject = trialMode
    ? `【MELCOCO】体験版のご案内（${trialDays}日間）`
    : "【MELCOCO】本会員のご案内";

  const lines = trialMode
  ? [
      `${name} 様`,
      "",
      `MELCOCO体験版のご案内です。（体験期間：${trialDays}日間）`,
      "",
      "【iPhone用薬剤選定アプリ】",
      IOS_AGENT_URL,
      "",
      "【iPhone用アイロンタイマー】",
      IOS_TIMER_URL,
      "",
      "【iPhone用カラーカルテ】",
      COLOR_LINE,
      "",
      "ログインパスワード: melcoco",
      "",
      "MELCOCOサポート",
    ]
  : [
      `${name} 様`,
      "",
      "MELCOCO本会員アプリのご案内です。",
      "",
      "【iPhone用薬剤選定アプリ】",
      IOS_AGENT_URL,
      "",
      "【iPhone用アイロンタイマー】",
      IOS_TIMER_URL,
      "",
      "【iPhone用カラーカルテ】",
      COLOR_LINE,
      "",
      "ログインパスワード: melcoco",
      "",
      "MELCOCOサポート",
    ];
  await sendMailPlain({
    to: email,
    subject,
    text: lines.join("\n"),
  });
}

// ---------- ポート ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
