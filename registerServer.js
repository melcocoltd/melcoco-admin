const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Firebase秘密鍵（base64）読み込み＆検証
let serviceAccount;
try {
  if (!process.env.FIREBASE_KEY_BASE64) {
    throw new Error("❌ 環境変数 FIREBASE_KEY_BASE64 が未定義です。");
  }
  const jsonString = Buffer.from(process.env.FIREBASE_KEY_BASE64, "base64").toString("utf8");
  serviceAccount = JSON.parse(jsonString);
  console.log("✅ Firebase鍵の読み込み成功（length: " + jsonString.length + "）");
} catch (error) {
  console.error("❌ Firebase鍵の読み込み失敗:", error.message);
  process.exit(1);
}

// 🔥 Firebase 初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const auth = admin.auth();

// 📩 Gmailメール送信用
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "melco.coltd.japan@gmail.com",
    pass: "pnujlqpmxlbqaxdp", // ← 2段階認証を使っているなら「アプリパスワード」
  },
});

// ✅ 登録エンドポイント（体験版 or 本会員）
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture, apps, status } = req.body;

  if (!email || !salonName || !prefecture || !name || !status) {
    return res.status(400).json({ error: "必要な情報が不足しています。" });
  }

  const defaultPassword = "melcoco";
  const trialMode = status === "trial";

  try {
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    // Firestore にユーザーデータ保存
    await db.collection("users").doc(userRecord.uid).set({
      status,
      email,
      displayName: name,
      salonName,
      prefecture,
      ...(trialMode && { trialStartDate: new Date().toISOString() })
    });

    // 🔔 管理者通知メール
    await transporter.sendMail({
      from: '"MELCOCOサポート" <melco.coltd.japan@gmail.com>',
      to: "melco.coltd.japan@gmail.com",
      subject: `【MELCOCO】${trialMode ? "体験版" : "本会員"}アプリ申請が届きました`,
      text: `
【申請内容】
サロン名: ${salonName}
都道府県: ${prefecture}
氏名: ${name}
メール: ${email}
対象アプリ: ${JSON.stringify(apps || ["agent", "timer"], null, 2)}
      `,
    });

    // 🔔 申請者への案内メール
    await transporter.sendMail({
      from: '"MELCOCOサポート" <melco.coltd.japan@gmail.com>',
      to: email,
      subject: trialMode ? "【MELCOCO】体験版アプリのご案内" : "【MELCOCO】ご登録ありがとうございます",
      text: trialMode
        ? `
${name} 様

MELCOCOアプリ体験版へのお申し込みありがとうございます。
7日間の利用制限がありますが、以下のURLよりログインいただけます。

ログインURL:
https://melco-hairdesign.com/pwa/login.html

ログインパスワード: melcoco

※体験版は7日間ご利用いただけます。
ご不明点がございましたら、お気軽にお問い合わせください。

MELCOCOサポート
        `
        : `
${name} 様

この度はMELCOCOアプリへのご登録ありがとうございます。
以下のURLよりログインが可能です。

ログインURL:
https://melco-hairdesign.com/pwa/login.html

ログインパスワード: melcoco

今後ともよろしくお願いいたします。

MELCOCOサポート
        `,
    });

    res.status(200).json({ message: "登録成功", uid: userRecord.uid });
  } catch (error) {
    console.error("❌ 登録失敗:", error.message);
    res.status(500).json({ error: `登録失敗: ${error.message}` });
  }
});

// ✅ サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});