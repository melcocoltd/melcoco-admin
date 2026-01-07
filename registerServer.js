// ---------- 申請者向けメール ----------
async function sendUserMail({ email, name, trialMode }) {
  const androidLoginUrl =
    process.env.ANDROID_LOGIN_URL || "https://melco-hairdesign.com/pwa/login.html";

  const iosAppUrl =
    process.env.IOS_APP_URL || "https://melcoco.jp/irontimer-ios/";

  const subject = trialMode
    ? "【MELCOCO】体験版のご案内（7日間）"
    : "【MELCOCO】本会員のご案内";

  const headerLines = [
    `${name} 様`,
    "",
    trialMode
      ? "MELCOCOアプリ体験版へのお申し込みありがとうございます。"
      : "MELCOCOアプリへのお申し込みありがとうございます。",
    "",
    "【ご利用方法】",
    "",
    "■ iPhoneの方（ネイティブアプリ）",
    iosAppUrl,
    "",
    "■ Androidの方（PWA）",
    androidLoginUrl,
    "",
    "ログインパスワード: melcoco",
    "",
  ];

  const footerLines = trialMode
    ? [
        "※体験版のご利用期間は7日間です。",
        "継続してご利用されたい場合は、有料オンラインサロン「ココナッツ研究室」へご入会ください。",
        "https://melcoco.jp/coconut-lab/",
        "",
        "ご不明な点がございましたら、お気軽にお問い合わせください。",
        "",
        "MELCOCOサポート",
      ]
    : [
        "ご不明な点がございましたら、お気軽にお問い合わせください。",
        "",
        "MELCOCOサポート",
      ];

  const lines = headerLines.concat(footerLines);

  await sendMailPlain({
    to: email,
    subject,
    text: lines.join("\n"),
  });
}
