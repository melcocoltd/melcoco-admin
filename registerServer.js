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

// ---------- apps 初期値 ----------
const defaultAppsObj = {
  "i-agent": { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
  "i-timer": { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },

  "a-agent": { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
  "a-timer": { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },

  agent: { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
  androidtimer: { loginCount: 0, switchCount: 0, trialStartDate: todayYMD(), deviceId: "" },
};

// ---------- apps 正規化 ----------
function normalizeApps(apps) {
  const base =
    apps && typeof apps === "object" && !Array.isArray(apps) ? apps : {};

  const merged = { ...defaultAppsObj, ...base };

  for (const key of Object.keys(merged)) {
    merged[key] = {
      ...defaultAppsObj[key],
      ...(merged[key] || {}),
    };

    if (!merged[key].trialStartDate) merged[key].trialStartDate = todayYMD();
    if (typeof merged[key].loginCount !== "number") merged[key].loginCount = 0;
    if (typeof merged[key].switchCount !== "number") merged[key].switchCount = 0;
    if (typeof merged[key].deviceId !== "string") merged[key].deviceId = "";
  }

  return merged;
}

// ---------- ヘルス ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- 登録 ----------
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body || {};

  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ ok: false, error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  const appsToSave = normalizeApps(apps);

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

    res.status(201).json({ ok: true, uid: userRecord.uid });

    sendAdminMail({ email, name, salonName, prefecture, apps: appsToSave, trialMode }).catch(console.error);
    sendUserMail({ email, name, trialMode }).catch(console.error);
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
async function sendUserMail({ email, name, trialMode }) {
  const ANDROID_LOGIN_URL =
    process.env.ANDROID_LOGIN_URL || "https://melco-hairdesign.com/pwa/login.html";

  const IOS_TIMER_URL =
  process.env.IOS_TIMER_URL || "https://apps.apple.com/app/irontimernative/id6757497537";

const IOS_AGENT_URL =
  process.env.IOS_AGENT_URL || "https://melco-hairdesign.com/pwa/login.html";

  const subject = trialMode
    ? "【MELCOCO】体験版のご案内（7日間）"
    : "【MELCOCO】本会員のご案内";

  const lines = trialMode
  ? [
      `${name} 様`,
      "",
      "MELCOCO体験版のご案内です。",
      "",
      "【iPhone用アイロンタイマー】",
      IOS_TIMER_URL,
      "",
      "【iPhone用薬剤選定アプリ】",
      IOS_AGENT_URL,
      "",
      "【Android】",
      ANDROID_LOGIN_URL,
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
      "【iPhone用アイロンタイマー】",
      IOS_TIMER_URL,
      "",
      "【iPhone用薬剤選定アプリ】",
      IOS_AGENT_URL,
      "",
      "【Android】",
      ANDROID_LOGIN_URL,
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
