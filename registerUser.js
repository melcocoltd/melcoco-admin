// registerUser.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Firebase秘密鍵をBase64から復元
const serviceAccount = JSON.parse(
  Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "melco.coltd.japan@gmail.com",
    pass: "pnujlqpmxlbqaxdp", // 🔐 本番ではenvで渡すのが安全
  },
});

app.post("/registerTrialUser", async (req, res) => {
  const { email, name, salonName, prefecture, apps = {}, status = "trial" } = req.body;

  if (!email || !salonName || !prefecture || !name) {
    return res.status(400).json({ error: "必須項目が未入力です" });
  }

  const defaultPassword = "melcoco";

  try {
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    await db.collection("users").doc(userRecord.uid).set({
      status,
      apps,
      displayName: name,
      salonName,
      prefecture,
    });

    // 🔔 管理者通知
    await transporter.sendMail({
      from: '"MELCOCO サポート" <melco.coltd.japan@gmail.com>',
      to: "melco.coltd.japan@gmail.com",
      subject: "【MELCOCO】新規ユーザー申請あり",
      text: `サロン名: ${salonName}\n都道府県: ${prefecture}\n氏名: ${name}\nメール: ${email}\n申請アプリ: ${Object.keys(apps).join(", ")}`,
    });

    // 🔔 ユーザー通知
    await transporter.sendMail({
      from: '"MELCOCO サポート" <melco.coltd.japan@gmail.com>',
      to: email,
      subject: "【MELCOCO】申請ありがとうございます",
      text: `${name} 様\n\nMELCOCOアプリ利用申請を受け付けました。\nログインはこちら:\nhttps://melco-hairdesign.com/pwa/login.html\n\nログインパスワード: melcoco\n※体験版は24時間または5回までの制限があります。`,
    });

    res.status(200).json({ message: "ok" });
  } catch (error) {
    console.error("🔥 登録エラー:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});