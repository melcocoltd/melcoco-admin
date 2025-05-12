const admin = require("firebase-admin");
const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase Admin SDK 初期化成功");
