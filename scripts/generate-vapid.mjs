import * as webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("\nPrivāto atslēgu glabā tikai Netlify vides mainīgajos un neievieto GitHub.");

