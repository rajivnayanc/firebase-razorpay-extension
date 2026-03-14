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
  const [currentOrderId, setCurrentOrderId] = useState<string>('');
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('');
  const [currentSubscriptionId, setCurrentSubscriptionId] = useState<string>('');
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

  const verifyOrder = async (orderId: string) => {
    if (!user) return;
    setPaymentStatus('Verifying order status...');
    try {
      const idToken = await user.getIdToken();
      const functionUrl = window.location.hostname === 'localhost'
        ? 'http://127.0.0.1:5001/demo-test/us-central1/ext-razorpay-payments-razorpayWebhookHandler'
        : 'https://us-central1-demo-test.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler'; // Just a fallback

      const res = await fetch(`${functionUrl}/verify-order/${orderId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });

      if (res.ok) {
        const data = await res.json();
        setPaymentStatus(`Order verified. Status: ${data.status}`);
      } else {
        const errData = await res.json();
        setPaymentStatus(`Order verification failed: ${errData.error || errData.message}`);
      }
    } catch (err: any) {
      console.error(err);
      setPaymentStatus(`Order verification error: ${err.message}`);
    }
  };

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
        setCurrentOrderId(data.order_id);
        unsub(); // Stop listening

        const options = {
          key: 'rzp_test_REhhBk92ynVgRB', // Will fail if completely fake, user should replace or use test mode
          amount: data.amount.toString(),
          currency: data.currency,
          name: 'Acme Corp',
          description: 'Premium Test Transaction',
          order_id: data.order_id,
          handler: async (response: any) => {
            console.log('Payment Success:', response);
            setPaymentStatus('Verifying payment signature with extension...');

            try {
              const idToken = await user.getIdToken();
              const functionUrl = window.location.hostname === 'localhost'
                ? 'http://127.0.0.1:5001/demo-test/us-central1/ext-razorpay-payments-razorpayWebhookHandler'
                : 'https://us-central1-demo-test.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler';

              const res = await fetch(`${functionUrl}/verify-payment`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                  sessionId: docRef.id
                })
              });

              if (res.ok) {
                setPaymentStatus(`Payment Successful and Signature Verified! ${res}`);
              } else {
                const errData = await res.json();
                setPaymentStatus(`Verification failed: ${errData.message}`);
              }
            } catch (err: any) {
              console.error(err);
              setPaymentStatus(`Verification error: ${err.message}`);
            }
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

  const startSubscription = async () => {
    if (!user) return;
    setSubscriptionStatus('Initiating subscription...');

    const subsRef = collection(db, 'customers', user.uid, 'subscriptions');
    const docRef = await addDoc(subsRef, {
      plan_id: 'plan_test_123', // NOTE: User needs to replace this with a valid Plan ID from Razorpay dashboard to test properly
      total_count: 12,
      quantity: 1,
    });

    const unsub = onSnapshot(docRef, (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.status === 'created' && data.subscription_id) {
        setSubscriptionStatus('Subscription created, opening Razorpay...');
        setCurrentSubscriptionId(data.subscription_id);
        unsub();

        const options = {
          key: 'rzp_test_REhhBk92ynVgRB', // User's test key
          subscription_id: data.subscription_id,
          name: 'Acme Corp',
          description: 'Premium Monthly Subscription Test',
          handler: async (response: any) => {
            console.log('Subscription Success:', response);
            setSubscriptionStatus('Verifying subscription signature with extension...');
            
            try {
              const idToken = await user.getIdToken();
              const functionUrl = window.location.hostname === 'localhost' 
                ? 'http://127.0.0.1:5001/demo-test/us-central1/ext-razorpay-payments-razorpayWebhookHandler'
                : 'https://us-central1-demo-test.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler';

              const res = await fetch(`${functionUrl}/verify-payment`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_subscription_id: response.razorpay_subscription_id,
                  razorpay_signature: response.razorpay_signature,
                  sessionId: docRef.id // The subscription document ID
                })
              });

              if (res.ok) {
                setSubscriptionStatus('Subscription Successful and Signature Verified!');
              } else {
                const errData = await res.json();
                setSubscriptionStatus(`Verification failed: ${errData.message}`);
              }
            } catch (err: any) {
              console.error(err);
              setSubscriptionStatus(`Verification error: ${err.message}`);
            }
          },
          prefill: {
            name: 'Jane Doe',
            email: 'jane@example.com',
            contact: '8888888888'
          },
          theme: {
            color: '#cc3399'
          }
        };

        // @ts-ignore - react-razorpay typing doesn't correctly support subscription_id instead of order_id
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', (response: any) => {
          console.error(response.error);
          setSubscriptionStatus('Subscription Payment Failed.');
        });
        rzp.open();
      } else if (data.status === 'failed') {
        setSubscriptionStatus(`Subscription creation failed: ${data.error}`);
        unsub();
      } else if (data.status === 'processing') {
        setSubscriptionStatus('Extension is processing the subscription...');
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

            {currentOrderId && (
              <button
                onClick={() => verifyOrder(currentOrderId)}
                className="w-full py-2 px-4 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium shadow-md transition-all mt-2"
              >
                Verify Order Status
              </button>
            )}
            
            <hr className="my-4 border-gray-200" />
            
            <button
              onClick={startSubscription}
              className="w-full py-3 px-4 bg-pink-600 hover:bg-pink-700 text-white rounded-lg font-medium shadow-md transition-all hover:-translate-y-0.5"
            >
              Subscribe to Plan (Requires valid Plan ID)
            </button>

            {subscriptionStatus && (
              <div className="mt-4 p-4 bg-pink-50 text-pink-800 rounded-lg text-sm border border-pink-100">
                {subscriptionStatus}
              </div>
            )}
            
            {currentSubscriptionId && (
              <div className="mt-2 text-xs text-center text-gray-500">
                Subscription ID: {currentSubscriptionId}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
