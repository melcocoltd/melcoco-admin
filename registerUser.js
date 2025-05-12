console.log("スクリプト開始");

const admin = require("firebase-admin");
const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

async function registerUser() {
  const email = "newuser@example.com";
  const password = "melcoco2025";
  const displayName = "新規会員";

  console.log("▶️ ユーザー登録処理を開始");

  try {
    const user = await auth.createUser({ email, password, displayName });

    await db.collection("users").doc(user.uid).set({
      status: "inactive",
      displayName,
    });

    console.log("✅ 登録成功:", email);
  } catch (err) {
    console.error("❌ 登録失敗:", err.message);
  }
}

// 必ず関数を呼び出す
registerUser().catch((e) => console.error("❌ 実行時エラー:", e.message));