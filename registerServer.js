const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Firebase 認証キー（環境変数から取得）
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

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
    pass: "pnujlqpmxlbqaxdp", // アプリパスワード
  },
});

// ✅ 登録エンドポイント
app.post("/register", async (req, res) => {
  const { email, name, salonName, prefecture } = req.body;

  if (!email || !salonName || !prefecture || !name) {
    return res.status(400).json({ error: "すべての必須項目を入力してください。" });
  }

  const defaultPassword = "melcoco";

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
      to: email,
      subject: "【登録完了】MELCOCO 薬剤選定アプリのご案内",
      text: `
${name} 様

MELCOCO薬剤選定アプリへのご申請ありがとうございます。
下記の情報でログインが可能です。

▶ ログインURL：https://melco-hairdesign.com/pwa/register
▶ メールアドレス：${email}
▶ パスワード：melcoco

※セキュリティの都合上、24時間で自動ログアウトされます。
　毎日ログインをお願いいたします。

-- MELCOCO事務局
      `,
    });

    res.status(200).json({ message: "✅ ユーザー登録・通知完了", uid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ error: `❌ 登録失敗：${error.message}` });
  }
});

// 🚀 サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});