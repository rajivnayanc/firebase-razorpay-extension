'use client';
import { useState, useEffect } from 'react';
import { auth, db } from '@/libs/firebase';
import {
  signInAnonymously,
  onAuthStateChanged,
  User,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from 'firebase/auth';
import { collection, doc, addDoc, onSnapshot } from 'firebase/firestore';
import { useRazorpay } from 'react-razorpay';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentStatus, setPaymentStatus] = useState<string>('');
  const [currentOrderId, setCurrentOrderId] = useState<string>('');
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('');
  const [currentSubscriptionId, setCurrentSubscriptionId] = useState<string>('');

  // Auth state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [authError, setAuthError] = useState('');

  // Plans state
  const [plans, setPlans] = useState<any[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [adminStatus, setAdminStatus] = useState<string>('');

  const { error, isLoading, Razorpay } = useRazorpay();

  const functionUrl = window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:5001/demo-test/us-central1/ext-razorpay-payments-razorpayWebhookHandler'
    : 'https://us-central1-demo-test.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler';

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        fetchPlans(u);
      }
    });
    return () => unsub();
  }, []);

  const loginAnonymously = async () => {
    setAuthError('');
    try {
      await signInAnonymously(auth);
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isLoginMode) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const logout = () => {
    setPlans([]);
    setSelectedPlanId('');
    setAdminStatus('');
    setPaymentStatus('');
    setSubscriptionStatus('');
    signOut(auth);
  };

  const fetchPlans = async (currentUser: User) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`${functionUrl}/plans`, {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setPlans(data.items || []);
        if (data.items?.length > 0) {
          setSelectedPlanId(data.items[0].id);
        }
      }
    } catch (err) {
      console.error('Fetch plans failed', err);
    }
  };

  const createTestPlan = async () => {
    if (!user) return;
    setAdminStatus('Creating test plan...');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${functionUrl}/admin/plans`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          period: 'monthly',
          interval: 1,
          item: {
            name: 'Test Premium Plan',
            amount: 100000,
            currency: 'INR',
            description: 'Created from sample app'
          }
        })
      });
      if (res.ok) {
        setAdminStatus('Plan createdsuccessfully!');
        fetchPlans(user);
      } else {
        const data = await res.json();
        setAdminStatus(`Error: ${data.error || 'Check if you have admin claim.'}`);
      }
    } catch (err: any) {
      setAdminStatus(`Error: ${err.message}`);
    }
  };

  const syncPlans = async () => {
    if (!user) return;
    setAdminStatus('Syncing plans from Razorpay...');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${functionUrl}/admin/plans/sync`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAdminStatus(`Synced ${data.count} plans successfully!`);
        fetchPlans(user);
      } else {
        const data = await res.json();
        setAdminStatus(`Sync Error: ${data.error || 'Check if you have admin claim.'}`);
      }
    } catch (err: any) {
      setAdminStatus(`Sync Error: ${err.message}`);
    }
  };

  const verifyOrder = async (orderId: string) => {
    if (!user) return;
    setPaymentStatus('Verifying order status...');
    try {
      const idToken = await user.getIdToken();
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

    const sessionsRef = collection(db, 'customers', user.uid, 'checkout_sessions');
    const docRef = await addDoc(sessionsRef, {
      amount: 50000, // 500.00 INR
      currency: 'INR',
    });

    const unsub = onSnapshot(docRef, (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.status === 'created' && data.order_id) {
        setPaymentStatus('Order created, opening Razorpay...');
        setCurrentOrderId(data.order_id);
        unsub();

        const options = {
          key: 'rzp_test_REhhBk92ynVgRB',
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
                setPaymentStatus(`Payment Successful and Signature Verified!`);
              } else {
                const errData = await res.json();
                setPaymentStatus(`Verification failed: ${errData.message}`);
              }
            } catch (err: any) {
              setPaymentStatus(`Verification error: ${err.message}`);
            }
          },
          prefill: {
            name: 'John Doe',
            email: 'john@example.com',
            contact: '9999999999'
          },
          theme: { color: '#3399cc' }
        };

        const rzp = new Razorpay(options);
        rzp.on('payment.failed', (response: any) => {
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
    if (!selectedPlanId) {
      setSubscriptionStatus('Please select a plan first.');
      return;
    }
    setSubscriptionStatus('Initiating subscription...');

    const subsRef = collection(db, 'customers', user.uid, 'subscriptions');
    const docRef = await addDoc(subsRef, {
      plan_id: selectedPlanId,
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
          key: 'rzp_test_REhhBk92ynVgRB',
          subscription_id: data.subscription_id,
          name: 'Acme Corp',
          description: 'Premium Monthly Subscription Test',
          handler: async (response: any) => {
            console.log('Subscription Success:', response);
            setSubscriptionStatus('Verifying subscription signature with extension...');

            try {
              const idToken = await user.getIdToken();
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
                  sessionId: docRef.id
                })
              });

              if (res.ok) {
                setSubscriptionStatus('Subscription Successful and Signature Verified!');
              } else {
                const errData = await res.json();
                setSubscriptionStatus(`Verification failed: ${errData.message}`);
              }
            } catch (err: any) {
              setSubscriptionStatus(`Verification error: ${err.message}`);
            }
          },
          prefill: {
            name: 'Jane Doe',
            email: 'jane@example.com',
            contact: '8888888888'
          },
          theme: { color: '#cc3399' }
        };

        // @ts-ignore
        const rzp = new Razorpay(options);
        rzp.on('payment.failed', (response: any) => {
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
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full border border-gray-100 flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-center text-indigo-600">Razorpay Extension Test</h1>

        {!user ? (
          <div className="flex flex-col gap-4">
            <div className="flex border-b border-gray-200 mb-2">
              <button
                onClick={() => setIsLoginMode(true)}
                className={`flex-1 py-2 text-sm font-medium ${isLoginMode ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500'}`}
              >
                Login
              </button>
              <button
                onClick={() => setIsLoginMode(false)}
                className={`flex-1 py-2 text-sm font-medium ${!isLoginMode ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-500'}`}
              >
                Sign Up
              </button>
            </div>

            <form onSubmit={handleEmailAuth} className="flex flex-col gap-3">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-md text-sm"
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-md text-sm"
                required
              />
              <button
                type="submit"
                className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
              >
                {isLoginMode ? 'Login' : 'Sign Up'}
              </button>
            </form>

            <div className="flex items-center gap-2">
              <hr className="flex-1 border-gray-200" />
              <span className="text-xs text-gray-400">OR</span>
              <hr className="flex-1 border-gray-200" />
            </div>

            <button
              onClick={loginAnonymously}
              className="w-full py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors text-sm"
            >
              Continue Anonymously
            </button>

            {authError && (
              <p className="text-xs text-red-500 bg-red-50 p-2 rounded border border-red-100 mt-2">
                {authError}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="bg-gray-50 p-4 rounded-lg flex justify-between items-center border border-gray-200">
              <div className="overflow-hidden">
                <p className="text-xs text-gray-500 uppercase font-semibold">Logged in as</p>
                <p className="font-mono text-sm truncate w-40" title={user.uid}>{user.uid}</p>
              </div>
              <button onClick={() => signOut(auth)} className="text-sm text-red-600 hover:text-red-800 font-medium whitespace-nowrap ml-2">Logout</button>
            </div>

            {/* Admin Controls Section */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Admin Controls</h2>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      try {
                        const token = await auth.currentUser?.getIdToken(true);
                        const res = await fetch(`/api/set-admin-claim`, {
                          method: 'POST',
                          headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const data = await res.json();
                        alert(`${data.message || data.error}`);
                      } catch (err) {
                        alert('Failed to set admin claim');
                      }
                    }}
                    className="text-xs py-1 px-3 bg-red-100 text-red-700 hover:bg-red-200 rounded-md font-medium transition-colors"
                  >
                    Make me Admin (Dev Only)
                  </button>
                  <button
                    onClick={syncPlans}
                    className="text-sm py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors"
                  >
                    Sync Plans
                  </button>
                  <button
                    onClick={createTestPlan}
                    className="text-sm py-2 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
                  >
                    Create Test Plan
                  </button>
                </div>
              </div>
            </div>

            <hr className="border-gray-200" />

            {/* One-time Payment */}
            <div>
              <button
                onClick={startCheckout}
                className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium shadow-md transition-all hover:-translate-y-0.5"
              >
                Pay ₹500.00
              </button>
              {paymentStatus && <div className="mt-3 p-3 bg-blue-50 text-blue-800 rounded-lg text-sm border border-blue-100">{paymentStatus}</div>}
              {currentOrderId && (
                <button onClick={() => verifyOrder(currentOrderId)} className="w-full py-2 px-4 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium shadow-md transition-all mt-2 text-sm">Verify Order Status</button>
              )}
            </div>

            <hr className="border-gray-200" />

            {/* Subscriptions */}
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-bold text-gray-700 uppercase">Subscriptions</h2>

              {plans.length > 0 ? (
                <select
                  value={selectedPlanId}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-md text-sm bg-white"
                >
                  {plans.map(p => (
                    <option key={p.id} value={p.id}>{p.name || p.id} ({p.currency} {p.amount ? p.amount / 100 : 0})</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-gray-500 italic">No plans synced yet. Use Admin Controls to sync or create plans.</p>
              )}

              <button
                onClick={startSubscription}
                disabled={!selectedPlanId}
                className={`w-full py-3 px-4 rounded-lg font-medium shadow-md transition-all ${selectedPlanId ? 'bg-pink-600 hover:bg-pink-700 text-white hover:-translate-y-0.5' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}
              >
                Subscribe to Plan
              </button>

              {subscriptionStatus && <div className="p-3 bg-pink-50 text-pink-800 rounded-lg text-sm border border-pink-100">{subscriptionStatus}</div>}
              {currentSubscriptionId && <div className="text-xs text-center text-gray-500">Sub ID: {currentSubscriptionId}</div>}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
