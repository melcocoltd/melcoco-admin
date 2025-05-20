const admin = require("firebase-admin");
const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("📡 Firebase 認証ユーザー取得開始...");

admin.auth().listUsers()
  .then((listUsersResult) => {
    if (listUsersResult.users.length === 0) {
      console.log("⚠️ ユーザーが存在しません。");
    } else {
      listUsersResult.users.forEach((userRecord) => {
        console.log(`📌 UID: ${userRecord.uid} | Email: ${userRecord.email}`);
      });
    }
  })
  .catch((error) => {
    console.error("❌ ユーザー取得エラー:", error.message);
  });