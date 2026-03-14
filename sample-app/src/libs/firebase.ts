import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

const firebaseConfig = {
    // When using Firebase Emulators with a demo- project, the config values
    // don't need to be real. The emulator intercepts all calls locally.
    apiKey: "fake-api-key",
    authDomain: "demo-test.firebaseapp.com",
    projectId: "demo-test",
    storageBucket: "demo-test.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef123456"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// Connect to emulators if running locally
if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    try {
        connectAuthEmulator(auth, 'http://127.0.0.1:9099');
        connectFirestoreEmulator(db, '127.0.0.1', 8080);
        console.log('Connected to Firebase Emulators');
    } catch (err) {
        // Ignore if already connected
    }
}

export { app, auth, db };
