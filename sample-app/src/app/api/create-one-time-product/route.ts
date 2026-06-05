import { NextRequest, NextResponse } from 'next/server';
import * as admin from 'firebase-admin';

// Force emulator environment if no service account is set
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
}

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
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
    
    // Verify the ID token to get the user ID and claims
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const isAdmin = decodedToken.admin === true;

    if (!uid) {
      return NextResponse.json({ error: 'Invalid Token' }, { status: 401 });
    }

    // SAMPLE-02: Restrict product creation to admin users only
    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const db = admin.firestore();
    const productRef = db.collection('products').doc('one_time_premium');
    
    await productRef.set({
      active: true,
      name: 'Premium Lifetime Access',
      description: 'Get permanent lifetime access to all premium features with a single, one-time payment. No recurring fees.',
      amount: 499900, // ₹4,999.00
      currency: 'INR',
      type: 'one-time',
      firebaseRole: 'Premium'
    }, { merge: true });

    console.log(`Successfully created one-time premium product in Firestore`);
    return NextResponse.json({ 
      status: 'SUCCESS', 
      message: 'One-Time Premium Product created in Firestore!' 
    });

  } catch (error: unknown) {
    console.error('Error creating one-time product:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: 'Failed to create product', details: errorMessage },
      { status: 500 }
    );
  }
}
