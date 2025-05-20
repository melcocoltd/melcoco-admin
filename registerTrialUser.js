// registerTrialUser.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "melco.coltd.japan@gmail.com",
    pass: "pnujlqpmxlbqaxdp",
  },
});

app.post("/registerTrialUser", async (req, res) => {
  const { email, name, salonName, prefecture, apps } = req.body;

  if (!email || !salonName || !prefecture || !name) {
    return res.status(400).json({ error: "必要な項目が不足しています。" });
  }

  console.log("📦 appsの中身:", apps); // デバッグログ

  const defaultPassword = "melcoco";

  try {
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    // appsが配列かどうか確認し、異なる場合は対応（regitri.html 用）
    let loginApps = {};
    if (Array.isArray(apps)) {
      if (apps.includes("agent")) loginApps.agent = { loginCount: 0 };
      if (apps.includes("timer")) loginApps.timer = { loginCount: 0 };
    } else {
      if (apps.agent === "利用申請する") loginApps.agent = { loginCount: 0 };
      if (apps.timer === "利用申請する") loginApps.timer = { loginCount: 0 };
    }

    await db.collection("users").doc(userRecord.uid).set({
      status: "trial",
      apps: loginApps,
      displayName: name,
      salonName,
      prefecture,
    });

    // 通知メール（管理者向け）
    await transporter.sendMail({
      from: '"MELCOCO 申請通知" <melco.coltd.japan@gmail.com>',
      to: "melco.coltd.japan@gmail.com",
      subject: "【MELCOCO】体験版利用申請がありました",
      text: `
サロン名: ${salonName}
都道府県: ${prefecture}
氏名: ${name}
メール: ${email}
申請アプリ: ${JSON.stringify(apps, null, 2)}
      `,
    });

    // 通知メール（申請者向け）
    await transporter.sendMail({
      from: '"MELCOCO" <melco.coltd.japan@gmail.com>',
      to: email,
      subject: "【MELCOCO】ご利用申請ありがとうございます",
      text: `
${name} 様

MELCOCOアプリ体験版のご利用申請を受け付けました。
以下のログインページよりご利用いただけます（24時間以内にログインがない場合は無効になります）。

▼ログインページ
https://melco-hairdesign.com/pwa/login.html

初期パスワード: melcoco

---
MELCOCO事務局
      `,
    });

    res.status(200).json({ message: "登録とメール送信が完了しました", uid: userRecord.uid });
  } catch (error) {
    console.error("🔥 登録処理中のエラー:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});