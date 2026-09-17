// firebase-config.js
//
// 1. Go to https://console.firebase.google.com, create a project (free Spark plan).
// 2. Add a Web App to it, copy the config object it gives you, and paste it below.
// 3. In the console: Build > Authentication > Sign-in method > enable "Anonymous".
// 4. In the console: Build > Realtime Database > Create Database > start in
//    "locked mode" > then paste security-rules.json (in the project root) into
//    the Rules tab and Publish.

export const firebaseConfig = {
  apiKey: "AIzaSyCPVBL5d3Db3ofgcJ5ykVR6Dc7bAIw2Hnk",
  authDomain: "secreth-10e81.firebaseapp.com",
  databaseURL: "https://secreth-10e81-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "secreth-10e81",
  storageBucket: "secreth-10e81.firebasestorage.app",
  messagingSenderId: "619771549270",
  appId: "1:619771549270:web:007393b53f3f97e3f78df7",
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Every device (board or phone) needs a UID before touching the database,
// since the security rules key almost everything off auth.uid.
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    signInAnonymously(auth).catch(reject);
    auth.onAuthStateChanged(user => {
      if (user) resolve(user);
    });
  });
}
