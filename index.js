const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const registerTrialUser = require("./registerTrialUser");

const serviceAccount = require("./melcoco-app-firebase-adminsdk-fbsvc-e6e92263a5.json");

// 🔑 Firebase 初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin SDK 初期化成功");

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 ルーターに admin を渡す
app.use((req, res, next) => {
  req.admin = admin;
  next();
});

app.use(registerTrialUser);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ メインサーバー起動中: http://localhost:${PORT}`);
});