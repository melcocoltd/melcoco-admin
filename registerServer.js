const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Firebase 認証キーの読み込み（ファイル名に注意）
const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

// 📩 nodemailer 設定
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "melco.coltd.japan@gmail.com",
    pass: "pnujlqpmxlbqaxdp",  },
});

// ✅ 登録エンドポイント
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture } = req.body;

  if (!email || !salonName || !prefecture || !name) {
    return res.status(400).json({ error: "すべての必須項目を入力してください。" });
  }

  const defaultPassword = "melcoco2025";

  try {
    const userRecord = await auth.createUser({
      email,
      password: defaultPassword,
      displayName: name,
    });

    await db.collection("users").doc(userRecord.uid).set({
      status: "inactive",
      displayName: name,
      salonName,
      prefecture,
    });

    await transporter.sendMail({
      from: '"MELCOCO申請受付" <melco.coltd.japan@gmail.com>',
      to: "melco.coltd.japan@gmail.com",
      subject: "【新規申請】MELCOCO 薬剤選定アプリ",
      text: `
▼新規申請内容：
サロン名：${salonName}
都道府県：${prefecture}
氏名　　：${name}
メール　：${email}
      `,
    });

    res.status(200).json({ message: "✅ ユーザー登録・通知完了", uid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ error: `❌ 登録失敗：${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});