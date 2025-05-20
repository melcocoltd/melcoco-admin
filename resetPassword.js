// resetPassword.js

const admin = require("firebase-admin");
const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");

// Firebase 初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uid = "ここに対象のUIDを入力";
const newPassword = "cococo"; // 新しいパスワード

admin.auth().updateUser(uid, { password: newPassword })
  .then(userRecord => {
    console.log(`✅ パスワード更新成功: ${userRecord.uid}`);
  })
  .catch(error => {
    console.error("❌ エラー:", error.message);
  });// JavaScript Document