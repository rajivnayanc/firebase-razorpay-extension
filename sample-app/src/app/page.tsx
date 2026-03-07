'use client';
import { useState, useEffect } from 'react';
import { auth, db } from '@/libs/firebase';
import { signInAnonymously, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, doc, addDoc, onSnapshot } from 'firebase/firestore';
import { useRazorpay } from 'react-razorpay';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentStatus, setPaymentStatus] = useState<string>('');
  const { error, isLoading, Razorpay } = useRazorpay();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const login = async () => {
    try {
      await signInAnonymously(auth);
    } catch (err) {
      console.error(err);
    }
  };

  const logout = () => signOut(auth);

  const startCheckout = async () => {
    if (!user) return;
    setPaymentStatus('Initiating order...');

    // The Razorpay Firebase Extension listens to this collection
    const sessionsRef = collection(db, 'customers', user.uid, 'checkout_sessions');
    const docRef = await addDoc(sessionsRef, {
      amount: 50000, // 500.00 INR
      currency: 'INR',
    });

    // Listen to the document for the extension to populate order_id
    const unsub = onSnapshot(docRef, (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.status === 'created' && data.order_id) {
        setPaymentStatus('Order created, opening Razorpay...');
        unsub(); // Stop listening

        const options = {
          key: 'rzp_test_fake_key_for_demo', // Will fail if completely fake, user should replace or use test mode
          amount: data.amount.toString(),
          currency: data.currency,
          name: 'Acme Corp',
          description: 'Premium Test Transaction',
          order_id: data.order_id,
          handler: (response: any) => {
            console.log('Payment Success:', response);
            setPaymentStatus('Payment Successful! (Requires webhook to finalize status in Firestore)');
          },
          prefill: {
            name: 'John Doe',
            email: 'john@example.com',
            contact: '9999999999'
          },
          theme: {
            color: '#3399cc'
          }
        };

        const rzp = new Razorpay(options);
        rzp.on('payment.failed', (response: any) => {
          console.error(response.error);
          setPaymentStatus('Payment Failed.');
        });
        rzp.open();
      } else if (data.status === 'failed') {
        setPaymentStatus(`Order creation failed: ${data.error}`);
        unsub();
      } else if (data.status === 'processing') {
        setPaymentStatus('Extension is processing the order...');
      }
    });
  };

  if (loading) return <div className="p-8">Loading...</div>;

  return (
    <main className="min-h-screen p-8 bg-gray-50 flex flex-col items-center justify-center text-gray-800">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full border border-gray-100">
        <h1 className="text-2xl font-bold mb-6 text-center text-indigo-600">Razorpay Extension Test App</h1>

        {!user ? (
          <div className="flex flex-col gap-4">
            <p className="text-center text-gray-500 mb-4">Sign in to test the payment flow.</p>
            <button
              onClick={login}
              className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
            >
              Sign In Anonymously
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="bg-gray-50 p-4 rounded-lg flex justify-between items-center border border-gray-200">
              <div>
                <p className="text-xs text-gray-500 uppercase font-semibold">Logged in as</p>
                <p className="font-mono text-sm truncate w-48" title={user.uid}>{user.uid}</p>
              </div>
              <button onClick={logout} className="text-sm text-red-600 hover:text-red-800 font-medium">Logout</button>
            </div>

            <button
              onClick={startCheckout}
              className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium shadow-md transition-all hover:-translate-y-0.5"
            >
              Pay ₹500.00
            </button>

            {paymentStatus && (
              <div className="mt-4 p-4 bg-blue-50 text-blue-800 rounded-lg text-sm border border-blue-100">
                {paymentStatus}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
