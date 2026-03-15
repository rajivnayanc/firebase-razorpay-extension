import { NextRequest, NextResponse } from 'next/server';
import * as admin from 'firebase-admin';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  // Use environment variables for the service account or fallback to emulator
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
          const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          admin.initializeApp({
              credential: admin.credential.cert(serviceAccount)
          });
      } catch (error) {
          console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env var', error);
      }
  } else {
      // Setup for emulator - the environment variable FIREBASE_AUTH_EMULATOR_HOST MUST be set automatically by the frontend startup or manually
      admin.initializeApp({ projectId: "demo-test" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    // Verify the ID token to get the user ID
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    if (!uid) {
      return NextResponse.json({ error: 'Invalid Token' }, { status: 401 });
    }

    // Set admin claims
    await admin.auth().setCustomUserClaims(uid, {
      admin: true,
      role: 'admin'
    });

    console.log(`Successfully set admin claims for user: ${uid}`);
    return NextResponse.json({ 
      status: 'SUCCESS', 
      message: 'Admin claims set. Please sign out and sign back in.' 
    });

  } catch (error: any) {
    console.error('Error setting admin claim:', error);
    return NextResponse.json(
      { error: 'Failed to set admin claim', details: error.message },
      { status: 500 }
    );
  }
}
