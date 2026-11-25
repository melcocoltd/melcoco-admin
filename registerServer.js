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

// ---------- 会員管理ページ（/admin） ----------
// Render の環境変数 ADMIN_TOKEN（合言葉）で守られています
function requireAdmin(req, res, next) {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  const token = req.get("x-admin-token") || req.body?.token || "";
  if (!ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "ADMIN_TOKEN が設定されていません" });
  if (token !== ADMIN_TOKEN) return res.status(403).json({ ok: false, error: "合言葉が違います" });
  next();
}

function tsToIso(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  return "";
}

app.get("/admin", (_req, res) => {
  res.type("html").send(ADMIN_PAGE_HTML);
});

// 会員一覧（ログイン用アカウントの有無も一緒に調べる）
app.get("/admin/api/users", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection("users").get();
    const docs = snap.docs;

    // ログイン用アカウントを100件ずつまとめて確認
    const authByUid = new Map();
    for (let i = 0; i < docs.length; i += 100) {
      const chunk = docs.slice(i, i + 100).map((d) => ({ uid: d.id }));
      const r = await auth.getUsers(chunk);
      r.users.forEach((u) => authByUid.set(u.uid, u));
    }

    const users = [];
    for (const d of docs) {
      const data = d.data() || {};
      const email = String(data.email || "").trim().toLowerCase();
      const a = authByUid.get(d.id);
      let authState = "ok";
      let otherUid = "";
      if (!a) {
        authState = "missing";
        if (email) {
          try {
            const other = await auth.getUserByEmail(email);
            authState = "mismatch"; // 同じメールで別IDのアカウントがある（登録し直しで起きる）
            otherUid = other.uid;
          } catch (_) {}
        }
      }
      const apps = {};
      for (const [k, v] of Object.entries(data.apps || {})) {
        apps[k] = {
          deviceId: v?.deviceId || "",
          loginCount: v?.loginCount || 0,
          switchCount: v?.switchCount || 0,
          trialStartDate: v?.trialStartDate || "",
        };
      }
      users.push({
        uid: d.id,
        displayName: data.displayName || "",
        salonName: data.salonName || "",
        prefecture: data.prefecture || "",
        email,
        status: data.status || "",
        trialDays: data.trialDays || null,
        trialStartDate: data.trialStartDate || "",
        createdAt: tsToIso(data.createdAt),
        apps,
        authState,
        otherUid,
        lastSignIn: a?.metadata?.lastSignInTime || "",
        disabled: !!a?.disabled,
      });
    }
    users.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
    res.json({ ok: true, users });
  } catch (e) {
    console.error("admin users error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// ステータス・体験日数の変更
app.post("/admin/api/users/:uid", requireAdmin, async (req, res) => {
  const { status, trialDays, restartTrial } = req.body || {};
  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (status !== undefined) {
    if (!["active", "trial", "inactive"].includes(status)) {
      return res.status(400).json({ ok: false, error: "ステータスが正しくありません" });
    }
    update.status = status;
  }
  if (trialDays !== undefined) {
    const n = Math.floor(Number(trialDays));
    if (!(n > 0 && n <= 3650)) return res.status(400).json({ ok: false, error: "体験日数が正しくありません" });
    update.trialDays = n;
  }
  try {
    const ref = db.collection("users").doc(req.params.uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "会員データがありません" });
    if (restartTrial) {
      // 体験を今日から数え直す（全アプリの開始日を今日にする）
      const today = todayYMD();
      update.trialStartDate = today;
      for (const k of Object.keys(snap.data()?.apps || {})) {
        update[`apps.${k}.trialStartDate`] = today;
      }
    }
    await ref.update(update);
    res.json({ ok: true });
  } catch (e) {
    console.error("admin update error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// 端末の登録を外す（次にログインした端末が登録される）
app.post("/admin/api/users/:uid/reset-device", requireAdmin, async (req, res) => {
  const appKey = String(req.body?.app || "");
  try {
    const ref = db.collection("users").doc(req.params.uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "会員データがありません" });
    const keys = appKey ? [appKey] : Object.keys(snap.data()?.apps || {});
    const update = {};
    for (const k of keys) {
      update[`apps.${k}.deviceId`] = "";
      update[`apps.${k}.switchCount`] = 0;
    }
    if (Object.keys(update).length) await ref.update(update);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// パスワードを melcoco に戻す／アカウントが無ければ作り直す／IDずれを直す
app.post("/admin/api/users/:uid/fix-login", requireAdmin, async (req, res) => {
  const uid = req.params.uid;
  try {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "会員データがありません" });
    const data = snap.data() || {};
    const email = String(data.email || "").trim().toLowerCase();

    try {
      await auth.getUser(uid);
      await auth.updateUser(uid, { password: "melcoco", disabled: false });
      return res.json({ ok: true, message: "パスワードを melcoco にしました" });
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    if (!email) return res.status(400).json({ ok: false, error: "会員データにメールアドレスがありません" });

    // 同じメールで別IDのアカウントがあれば消してから、この会員データと同じIDで作り直す
    let removed = "";
    try {
      const other = await auth.getUserByEmail(email);
      await auth.deleteUser(other.uid);
      removed = other.uid;
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    await createAuthForDoc(uid, email, data.displayName);
    res.json({
      ok: true,
      message: removed
        ? "IDのずれを直しました（パスワード melcoco）"
        : "アカウントを作り直しました（パスワード melcoco）",
    });
  } catch (e) {
    console.error("admin fix-login error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

// 退会者の削除（会員データとログイン用アカウントを両方消す・元に戻せない）
app.post("/admin/api/users/:uid/delete", requireAdmin, async (req, res) => {
  const uid = req.params.uid;
  try {
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    const email = String(snap.data()?.email || "").trim().toLowerCase();
    try {
      await auth.deleteUser(uid);
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
    }
    // 同じメールで別IDのアカウントが残っていて、そのIDの会員データが無ければ一緒に消す
    if (email) {
      try {
        const other = await auth.getUserByEmail(email);
        const otherDoc = await db.collection("users").doc(other.uid).get();
        if (!otherDoc.exists) await auth.deleteUser(other.uid);
      } catch (e) {
        if (e?.code !== "auth/user-not-found") throw e;
      }
    }
    if (snap.exists) await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("admin delete error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server error" });
  }
});

const ADMIN_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MELCOCO 会員管理</title>
<style>
:root{--bg:#f7f6f4;--card:#fff;--ink:#222;--sub:#8a8580;--line:#e8e4df;--act:#2e9d6a;--tri:#d08a1f;--ina:#a0a0a0;--bad:#d9465f;--accent:#222}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;font-size:15px}
header{position:sticky;top:0;z-index:5;background:rgba(247,246,244,.95);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.top{display:flex;align-items:center;gap:12px;padding:14px 0 10px}
h1{font-size:19px;margin:0;flex:1;letter-spacing:.02em}
.count{color:var(--sub);font-size:13px}
.tools{display:flex;gap:8px;padding-bottom:12px;flex-wrap:wrap}
input,select{font-size:15px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fff;color:var(--ink)}
#q{flex:1;min-width:200px}
.chips{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:12px}
.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer}
.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.chip b{font-weight:600;margin-left:4px}
button{font-family:inherit;cursor:pointer}
.btn{border:1px solid var(--line);background:#fff;border-radius:10px;padding:9px 14px;font-size:14px}
.btn.dark{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.warn{background:var(--bad);color:#fff;border-color:var(--bad)}
.btn:disabled{opacity:.5}
.list{padding:14px 0 60px;display:grid;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.card.alert{border-color:#f2b8c2;box-shadow:0 0 0 3px #fdecef}
.row1{display:flex;align-items:flex-start;gap:10px}
.who{flex:1;min-width:0}
.name{font-weight:700;font-size:16px}
.meta{color:var(--sub);font-size:13px;margin-top:2px;word-break:break-all}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;flex-shrink:0}
.seg button{border:0;background:#fff;padding:8px 12px;font-size:13px;color:var(--sub)}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on.trial{background:var(--tri);color:#fff}
.seg button.on.active{background:var(--act);color:#fff}
.seg button.on.inactive{background:var(--ina);color:#fff}
.info{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.tag{font-size:12px;border-radius:6px;padding:3px 8px;background:#f2f0ed;color:#555}
.tag.bad{background:#fdecef;color:var(--bad);font-weight:600}
.tag.warnt{background:#fff4e0;color:#9a6410}
.more{margin-top:10px;border-top:1px dashed var(--line);padding-top:10px;display:none}
.card.open .more{display:block}
.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.app{background:#faf9f7;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:13px}
.app .t{font-weight:600;margin-bottom:2px}
.app .s{color:var(--sub)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}
.toggle{background:none;border:0;color:var(--sub);font-size:13px;padding:6px 0;margin-top:6px}
#login{max-width:380px;margin:80px auto;padding:0 16px}
#login input{width:100%;margin:8px 0}
#login .btn{width:100%;padding:12px}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90%}
#toast.show{opacity:1}
.empty{text-align:center;color:var(--sub);padding:40px 0}
@media(max-width:560px){.row1{flex-direction:column}.seg{width:100%}.seg button{flex:1}}
</style></head><body>

<div id="login">
  <h1 style="margin-bottom:12px">MELCOCO 会員管理</h1>
  <input id="tok" type="password" placeholder="管理用の合言葉" onkeydown="if(event.key==='Enter')enter()">
  <button class="btn dark" onclick="enter()">ひらく</button>
  <p id="lerr" style="color:var(--bad);font-size:14px"></p>
</div>

<div id="app" style="display:none">
<header><div class="wrap">
  <div class="top"><h1>MELCOCO 会員管理</h1><span class="count" id="count"></span>
    <button class="btn" onclick="load()">更新</button></div>
  <div class="tools">
    <input id="q" placeholder="名前・サロン名・メール・都道府県で検索" oninput="render()">
  </div>
  <div class="chips" id="chips"></div>
</div></header>
<div class="wrap"><div class="list" id="list"></div></div>
</div>
<div id="toast"></div>

<script>
var TOKEN = "";
var USERS = [];
var FILTER = "all";
var OPEN = {};
var APP_NAMES = {"i-agent":"薬剤選定（iPhone）","i-timer":"アイロンタイマー（iPhone）","i-color":"カラーカルテ（iPhone）","a-agent":"薬剤選定（Android）","a-timer":"アイロンタイマー（Android）","a-color":"カラーカルテ（Android）"};
var ST = {active:"本会員",trial:"体験",inactive:"停止"};

try { TOKEN = sessionStorage.getItem("mk_admin") || ""; } catch (e) {}
if (TOKEN) { start(); }

function enter(){ TOKEN = document.getElementById("tok").value.trim(); start(); }
function start(){
  load().then(function(ok){
    if (ok) {
      try { sessionStorage.setItem("mk_admin", TOKEN); } catch (e) {}
      document.getElementById("login").style.display = "none";
      document.getElementById("app").style.display = "block";
    }
  });
}
function toast(t){ var el=document.getElementById("toast"); el.textContent=t; el.classList.add("show"); clearTimeout(el._t); el._t=setTimeout(function(){el.classList.remove("show")},2600); }
function api(path, body){
  var opt = {method: body ? "POST" : "GET", headers: {"x-admin-token": TOKEN}};
  if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  return fetch(path, opt).then(function(r){ return r.json(); });
}
function load(){
  document.getElementById("count").textContent = "読み込み中…";
  return api("/admin/api/users").then(function(j){
    if (!j.ok) {
      document.getElementById("lerr").textContent = j.error;
      try { sessionStorage.removeItem("mk_admin"); } catch (e) {}
      document.getElementById("login").style.display = "block";
      document.getElementById("app").style.display = "none";
      return false;
    }
    USERS = j.users; render(); return true;
  }).catch(function(e){ document.getElementById("lerr").textContent = "通信エラー：" + e.message; return false; });
}
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function ymd(s){ if(!s) return ""; var d=new Date(s); if(isNaN(d)) return String(s).slice(0,10); return d.getFullYear()+"/"+(d.getMonth()+1)+"/"+d.getDate(); }
function trialLeft(u){
  var days = u.trialDays || 7;
  var start = u.trialStartDate || "";
  Object.keys(u.apps||{}).forEach(function(k){ var t=u.apps[k].trialStartDate; if(t && (!start || t<start)) start=t; });
  if (!start) return null;
  var s = new Date(String(start).slice(0,10)+"T00:00:00");
  var now = new Date(); now.setHours(0,0,0,0);
  return days - Math.round((now - s)/86400000);
}
function stateOf(u){ return u.status || "trial"; }
function needsFix(u){ return u.authState !== "ok" || u.disabled; }
function match(u){
  if (FILTER === "fix" && !needsFix(u)) return false;
  if (["active","trial","inactive"].indexOf(FILTER) >= 0 && stateOf(u) !== FILTER) return false;
  var q = document.getElementById("q").value.trim().toLowerCase();
  if (!q) return true;
  return [u.displayName,u.salonName,u.email,u.prefecture].join(" ").toLowerCase().indexOf(q) >= 0;
}
function renderChips(){
  var c = {all:USERS.length,active:0,trial:0,inactive:0,fix:0};
  USERS.forEach(function(u){ c[stateOf(u)] = (c[stateOf(u)]||0)+1; if(needsFix(u)) c.fix++; });
  var defs = [["all","全員"],["active","本会員"],["trial","体験"],["inactive","停止"],["fix","ログインできない"]];
  document.getElementById("chips").innerHTML = defs.map(function(d){
    return '<button class="chip'+(FILTER===d[0]?' on':'')+'" onclick="FILTER=\''+d[0]+'\';render()">'+d[1]+'<b>'+(c[d[0]]||0)+'</b></button>';
  }).join("");
}
function render(){
  renderChips();
  var rows = USERS.filter(match);
  document.getElementById("count").textContent = rows.length + " / " + USERS.length + "人";
  if (!rows.length) { document.getElementById("list").innerHTML = '<div class="empty">該当する会員はいません</div>'; return; }
  document.getElementById("list").innerHTML = rows.map(card).join("");
}
function card(u){
  var st = stateOf(u);
  var tags = [];
  if (u.authState === "missing") tags.push('<span class="tag bad">ログインできない（アカウントが消えている）</span>');
  if (u.authState === "mismatch") tags.push('<span class="tag bad">ログインできない（IDずれ）</span>');
  if (u.disabled) tags.push('<span class="tag bad">アカウント無効</span>');
  if (st === "trial") {
    var left = trialLeft(u);
    if (left === null) tags.push('<span class="tag warnt">体験 '+(u.trialDays||7)+'日（未使用）</span>');
    else if (left > 0) tags.push('<span class="tag warnt">体験 残り'+left+'日</span>');
    else tags.push('<span class="tag bad">体験 期限切れ</span>');
  }
  var used = Object.keys(u.apps||{}).filter(function(k){ return u.apps[k].loginCount>0 || u.apps[k].deviceId; });
  used.forEach(function(k){ tags.push('<span class="tag">'+esc((APP_NAMES[k]||k).replace(/（.*）/,""))+(k.charAt(0)==="a"?"(A)":"")+' '+u.apps[k].loginCount+'回</span>'); });
  if (u.lastSignIn) tags.push('<span class="tag">最終ログイン '+ymd(u.lastSignIn)+'</span>');
  if (u.createdAt) tags.push('<span class="tag">登録 '+ymd(u.createdAt)+'</span>');

  var seg = ["trial","active","inactive"].map(function(s){
    return '<button class="'+s+(st===s?' on':'')+'" onclick="setStatus(\''+u.uid+'\',\''+s+'\')">'+ST[s]+'</button>';
  }).join("");

  var apps = Object.keys(APP_NAMES).filter(function(k){ return u.apps && u.apps[k]; }).map(function(k){
    var a = u.apps[k];
    return '<div class="app"><div class="t">'+APP_NAMES[k]+'</div><div class="s">ログイン '+a.loginCount+'回・端末'+(a.deviceId?'登録済み':'未登録')+'・切替 '+a.switchCount+'回</div>'
      + (a.deviceId ? '<button class="toggle" onclick="resetDevice(\''+u.uid+'\',\''+k+'\')">この端末登録を外す</button>' : '')
      + '</div>';
  }).join("");

  var fixBtn = needsFix(u)
    ? '<button class="btn warn" onclick="fixLogin(\''+u.uid+'\')">ログインできるように直す</button>'
    : '<button class="btn" onclick="fixLogin(\''+u.uid+'\')">パスワードを melcoco に戻す</button>';

  return '<div class="card'+(needsFix(u)?' alert':'')+(OPEN[u.uid]?' open':'')+'" id="c_'+u.uid+'">'
    + '<div class="row1"><div class="who"><div class="name">'+esc(u.displayName||"（名前なし）")+'</div>'
    + '<div class="meta">'+esc(u.salonName)+(u.prefecture?'・'+esc(u.prefecture):'')+'</div>'
    + '<div class="meta">'+esc(u.email)+'</div></div>'
    + '<div class="seg">'+seg+'</div></div>'
    + '<div class="info">'+tags.join("")+'</div>'
    + (needsFix(u) ? '<div class="actions">'+fixBtn+'</div>' : '')
    + '<button class="toggle" onclick="toggle(\''+u.uid+'\')">'+(OPEN[u.uid]?'▲ 閉じる':'▼ くわしく・操作')+'</button>'
    + '<div class="more">'
    + '<div class="apps">'+(apps||'<div class="s">アプリの記録なし</div>')+'</div>'
    + '<div class="actions">'
    + '<label style="font-size:13px;color:var(--sub)">体験日数 <input type="number" min="1" max="3650" value="'+(u.trialDays||7)+'" id="td_'+u.uid+'" style="width:80px;padding:7px 8px"></label>'
    + '<button class="btn" onclick="saveDays(\''+u.uid+'\',false)">保存</button>'
    + '<button class="btn" onclick="saveDays(\''+u.uid+'\',true)">今日から体験をやり直す</button>'
    + '</div><div class="actions">'
    + (needsFix(u) ? '' : fixBtn)
    + '<button class="btn" onclick="resetDevice(\''+u.uid+'\',\'\')">全アプリの端末登録を外す</button>'
    + '</div><div class="actions" style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)">'
    + '<button class="btn" style="color:var(--bad);border-color:#f2b8c2" onclick="removeUser(\''+u.uid+'\')">退会者として削除</button>'
    + '</div><div class="meta" style="margin-top:8px">ID: '+u.uid+'</div>'
    + '</div></div>';
}
function toggle(uid){ OPEN[uid] = !OPEN[uid]; render(); }
function find(uid){ for (var i=0;i<USERS.length;i++) if (USERS[i].uid===uid) return USERS[i]; }
function setStatus(uid, s){
  var u = find(uid); if (stateOf(u) === s) return;
  var prev = u.status; u.status = s; render();
  api("/admin/api/users/"+uid, {status: s}).then(function(j){
    if (j.ok) toast((u.displayName||"")+" を「"+ST[s]+"」にしました");
    else { u.status = prev; render(); toast("エラー：" + j.error); }
  });
}
function saveDays(uid, restart){
  var v = document.getElementById("td_"+uid).value;
  if (restart && !confirm("体験の開始日を今日にします。よろしいですか？")) return;
  api("/admin/api/users/"+uid, restart ? {trialDays: v, restartTrial: true} : {trialDays: v}).then(function(j){
    if (j.ok) { toast(restart ? "今日から "+v+"日間の体験にしました" : "体験日数を "+v+"日にしました"); load(); }
    else toast("エラー：" + j.error);
  });
}
function resetDevice(uid, app){
  if (!confirm(app ? "この端末登録を外します。次にログインした端末が登録されます。" : "全アプリの端末登録を外します。")) return;
  api("/admin/api/users/"+uid+"/reset-device", {app: app}).then(function(j){
    if (j.ok) { toast("端末登録を外しました"); load(); } else toast("エラー：" + j.error);
  });
}
function removeUser(uid){
  var u = find(uid);
  var nm = u.displayName || u.email;
  var t = prompt(nm + " さんを削除します。\n会員データとログイン用アカウントが消え、元に戻せません。\n\n削除する場合は「削除」と入力してください。");
  if (t === null) return;
  if (t.trim() !== "削除") { toast("「削除」と入力されなかったので中止しました"); return; }
  api("/admin/api/users/"+uid+"/delete", {}).then(function(j){
    if (j.ok) { toast(nm + " さんを削除しました"); delete OPEN[uid]; load(); } else toast("エラー：" + j.error);
  });
}
function fixLogin(uid){
  var u = find(uid);
  if (!confirm((u.displayName||u.email)+" のパスワードを melcoco にします。よろしいですか？")) return;
  api("/admin/api/users/"+uid+"/fix-login", {}).then(function(j){
    if (j.ok) { toast(j.message); load(); } else toast("エラー：" + j.error);
  });
}
</script></body></html>`;


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
