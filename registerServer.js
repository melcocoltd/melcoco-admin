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

// ---------- アカデミー会員ページ（status: active のみ） ----------
const academyContent = require("./academyContent");
app.use("/academy", academyContent(admin));

// ---------- 登録 ----------
app.post("/register", async (req, res) => {
  const { name, salonName, prefecture, apps, status, trialDays } = req.body || {};
  const email = String(req.body?.email || "").trim().toLowerCase();

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
        // 既にアカウントがある人（作り直し・体験版→本会員など）も、パスワードを melcoco に戻す
        const existing = await auth.getUserByEmail(email);
        userRecord = await auth.updateUser(existing.uid, {
          password: defaultPassword,
          disabled: false,
        });
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

// ---------- 管理用：パスワードを melcoco に戻す ----------
// Render の環境変数 ADMIN_TOKEN に好きな合言葉を入れると使えます（未設定なら使えません）
// ブラウザで https://（サーバーのURL）/admin/reset を開く
app.get("/admin/reset", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>パスワードを melcoco に戻す</title>
<style>body{font-family:-apple-system,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
input,button{width:100%;padding:12px;margin:6px 0;font-size:16px;box-sizing:border-box;border:1px solid #ccc;border-radius:8px}
button{background:#222;color:#fff;border:0}#r{margin-top:12px;white-space:pre-wrap}</style></head><body>
<h2>パスワードを melcoco に戻す</h2>
<input id="e" type="email" placeholder="会員のメールアドレス" autocapitalize="off">
<input id="t" type="password" placeholder="管理用の合言葉">
<button onclick="go()">melcoco に戻す</button>
<button onclick="all_()" style="background:#666">全員を点検して、消えているアカウントを作り直す</button><div id="r"></div>
<script>async function go(){const r=document.getElementById('r');r.textContent='処理中…';
try{const res=await fetch('/admin/reset',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({email:document.getElementById('e').value,token:document.getElementById('t').value})});
const j=await res.json();r.textContent=j.ok?(j.recreated?'完了：'+j.email+' のアカウントを作り直しました（パスワード melcoco）':'完了：'+j.email+' のパスワードを melcoco にしました'):'エラー：'+j.error;}
catch(e){r.textContent='エラー：'+e.message}}
async function all_(){const r=document.getElementById('r');r.textContent='点検中…（少し時間がかかります）';
try{const res=await fetch('/admin/repair-all',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({token:document.getElementById('t').value})});const j=await res.json();
if(!j.ok){r.textContent='エラー：'+j.error;return;}
r.textContent='点検した人数：'+j.checked+'\\n\\n作り直した人（パスワード melcoco）：'+j.fixed.length+'人\\n'+j.fixed.join('\\n')+(j.failed.length?'\\n\\n失敗：\\n'+j.failed.join('\\n'):'');}
catch(e){r.textContent='エラー：'+e.message}}</script></body></html>`);
});

app.post("/admin/reset", async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  const { token } = req.body || {};
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "ADMIN_TOKEN が設定されていません" });
  if (token !== ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "合言葉が違います" });
  if (!email) return res.status(400).json({ ok: false, error: "メールアドレスを入れてください" });
  try {
    let u;
    try {
      u = await auth.getUserByEmail(email);
      await auth.updateUser(u.uid, { password: "melcoco", disabled: false });
      return res.json({ ok: true, email: u.email });
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    // ログイン用アカウントが消えている → 会員データ（Firestore）から同じIDで作り直す
    const doc = await findUserDocByEmail(email);
    if (!doc) {
      return res.status(404).json({ ok: false, error: "このメールアドレスの会員データもアカウントもありません" });
    }
    await createAuthForDoc(doc.id, email, doc.data()?.displayName);
    res.json({ ok: true, email, recreated: true });
  } catch (e) {
    console.error("admin reset error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// 会員データ（Firestore）をメールアドレスで探す（大文字・小文字の違いも吸収）
async function findUserDocByEmail(email) {
  const target = String(email || "").trim().toLowerCase();
  let q = await db.collection("users").where("email", "==", target).limit(1).get();
  if (!q.empty) return q.docs[0];
  const all = await db.collection("users").get();
  return all.docs.find((d) => String(d.data()?.email || "").trim().toLowerCase() === target) || null;
}

// 会員データと同じIDでログイン用アカウントを作る（パスワードは melcoco）
async function createAuthForDoc(uid, email, displayName) {
  const params = { uid, email: String(email).trim().toLowerCase(), password: "melcoco" };
  if (displayName) params.displayName = String(displayName);
  return auth.createUser(params);
}

// まとめて点検：会員データはあるのにログイン用アカウントが無い人を、全員作り直す
app.post("/admin/repair-all", async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  if (!ADMIN_TOKEN || req.body?.token !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "合言葉が違います" });
  }
  const fixed = [];
  const failed = [];
  try {
    const all = await db.collection("users").get();
    for (const d of all.docs) {
      const data = d.data() || {};
      const email = String(data.email || "").trim().toLowerCase();
      if (!email) continue;
      try {
        await auth.getUser(d.id);
        continue; // アカウントあり
      } catch (e) {
        if (e?.code !== "auth/user-not-found") {
          failed.push(`${data.displayName || ""} ${email}：${e?.message}`);
          continue;
        }
      }
      try {
        await createAuthForDoc(d.id, email, data.displayName);
        fixed.push(`${data.displayName || ""} ${email}`);
      } catch (e) {
        failed.push(`${data.displayName || ""} ${email}：${e?.code || e?.message}`);
      }
    }
    res.json({ ok: true, checked: all.size, fixed, failed });
  } catch (e) {
    console.error("repair-all error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// ---------- 管理者メール ----------
async function sendAdminMail({ email, name, salonName, prefecture, apps, trialMode }) {
  const subject = trialMode ? "【MELCOCO】体験版アプリ申請" : "【MELCOCO】会員登録申請";

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

  
  // 会員ページのURL（変更時は Render の環境変数 MEMBERS_URL でも上書き可）
  const MEMBERS_URL = process.env.MEMBERS_URL || "https://melcoco.jp/education/members.html";

  const subject = trialMode
    ? `【MELCOCO】体験版のご案内（${trialDays}日間）`
    : "【MELCOCO】メルコアカデミー会員ページのご案内";

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
      "メルコアカデミーへのご登録ありがとうございます。",
      "会員ページのご案内です。",
      "",
      "【会員ページ】",
      MEMBERS_URL,
      "",
      "【ログイン情報】",
      `メールアドレス: ${email}`,
      "パスワード: melcoco",
      "",
      "会員ページから、アプリ（薬剤選定アプリ・アイロンタイマー・カラーカルテ）の",
      "ダウンロードと使い方ガイド、会員価格の講習会のご案内をご覧いただけます。",
      "アプリにも同じメールアドレス・パスワードでログインできます。",
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
