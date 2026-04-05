'use client';
import { useState, useEffect } from 'react';
import { auth, db, functions } from '@/libs/firebase';
import {
  signInAnonymously,
  onAuthStateChanged,
  User,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  getIdTokenResult
} from 'firebase/auth';
import { collection, doc, addDoc, onSnapshot, query, where, orderBy } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useRazorpay } from 'react-razorpay';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<any[]>([]);
  const [activeSubscriptions, setActiveSubscriptions] = useState<any[]>([]);
  const [userRole, setUserRole] = useState<string | null>(null);

  // UI States
  const [status, setStatus] = useState<{ message: string; type: 'info' | 'error' | 'success' }>({ message: '', type: 'info' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const { Razorpay } = useRazorpay();

  // Initialize
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        // Check for admin/roles
        const tokenResult = await getIdTokenResult(u);
        setIsAdmin(!!tokenResult.claims.admin);
        setUserRole((tokenResult.claims.stripeRole as string) || (tokenResult.claims.firebaseRole as string) || 'Free');

        // Listen to active subscriptions
        const subsQuery = query(
          collection(db, 'customers', u.uid, 'subscriptions'),
          where('status', 'in', ['active', 'trialing'])
        );
        onSnapshot(subsQuery, (snap) => {
          setActiveSubscriptions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        });
      }
    });

    // Listen to Products
    const productsQuery = query(collection(db, 'products'), where('active', '==', true));
    const unsubProducts = onSnapshot(productsQuery, (snap) => {
      setProducts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    return () => {
      unsub();
      unsubProducts();
    };
  }, []);

  const handlePurchase = async (product: any) => {
    if (!user) {
      setStatus({ message: 'Please login to continue', type: 'error' });
      return;
    }

    setStatus({ message: `Initiating ${product.name}...`, type: 'info' });

    try {
      const isSubscription = product.type === 'subscription' || !!product.allowedPlans || !!product.planId;
      const collectionName = isSubscription ? 'subscriptions' : 'checkout_sessions';
      const payload: any = {
        productId: product.id,
      };

      // If multiple intervals exist, we'd normally show a selector. 
      // For this demo, find the first available interval if not specified.
      if (isSubscription && product.allowedPlans && !product.planId) {
        payload.interval = Object.keys(product.allowedPlans)[0];
      }

      const docRef = await addDoc(collection(db, 'customers', user.uid, collectionName), payload);

      // Listen for the order/subscription ID from the extension
      const unsub = onSnapshot(docRef, (snap) => {
        const data = snap.data();
        if (!data) return;

        if (data.status === 'failed') {
          setStatus({ message: `Error: ${data.error}`, type: 'error' });
          unsub();
        } else if (data.order_id || data.subscription_id) {
          setStatus({ message: 'Opening Secure Checkout...', type: 'success' });
          unsub();

          const rzpOptions: any = {
            key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_REhhBk92ynVgRB',
            name: 'Premium Store',
            description: product.name,
            prefill: {
              email: user.email || '',
              contact: ''
            },
            theme: { color: '#2563eb' },
            handler: async (response: any) => {
              setStatus({ message: 'Payment successful! Syncing status...', type: 'success' });
              // The extension will handle the verification via webhooks.
              // We just wait for the document status to update if we want.
            }
          };

          if (data.order_id) {
            rzpOptions.order_id = data.order_id;
            rzpOptions.amount = data.amount;
            rzpOptions.currency = data.currency;
          } else {
            rzpOptions.subscription_id = data.subscription_id;
          }

          const rzp = new Razorpay(rzpOptions);
          rzp.open();
        }
      });

    } catch (err: any) {
      setStatus({ message: err.message, type: 'error' });
    }
  };

  const runAdminAction = async (action: 'sync' | 'create') => {
    setStatus({ message: `${action === 'sync' ? 'Syncing' : 'Creating'}...`, type: 'info' });
    try {
      const callable = httpsCallable(functions, action === 'sync' ? 'ext-razorpay-payments-syncPlans' : 'ext-razorpay-payments-createPlan');
      const result = await callable(action === 'create' ? {
        period: 'monthly',
        interval: 1,
        item: {
          name: 'Premium Pro',
          amount: 99900,
          currency: 'INR',
          description: 'Full access to all premium features'
        }
      } : {});
      setStatus({ message: 'Action completed successfully!', type: 'success' });
    } catch (err: any) {
      setStatus({ message: `Admin Error: ${err.message}`, type: 'error' });
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="animate-pulse text-blue-400 font-medium">Initializing Premium Experience...</div>
    </div>
  );

  return (
    <main className="p-4 md:p-8 max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <header className="flex justify-between items-center glass-card p-6 rounded-2xl">
        <div>
          <h1 className="text-3xl font-black gradient-text">RAZORPAY NEXT</h1>
          <p className="text-slate-400 text-sm font-medium">Enterprise Grade Payments</p>
        </div>

        {user ? (
          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-slate-200">{user.email || 'Anonymous User'}</p>
              <p className="text-xs text-blue-400 font-mono">{userRole} Role</p>
            </div>
            <button onClick={() => signOut(auth)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm font-bold transition-all">
              Sign Out
            </button>
          </div>
        ) : null}
      </header>

      {!user ? (
        <section className="max-w-md mx-auto glass-card p-8 rounded-3xl space-y-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold">{isLoginMode ? 'Welcome Back' : 'Create Account'}</h2>
            <p className="text-slate-400 text-sm mt-1">Start your premium journey today</p>
          </div>

          <form className="space-y-4" onSubmit={(e) => {
            e.preventDefault();
            isLoginMode ? signInWithEmailAndPassword(auth, email, password) : createUserWithEmailAndPassword(auth, email, password);
          }}>
            <input type="email" placeholder="Email Address" value={email} onChange={e => setEmail(e.target.value)} className="w-full bg-slate-900/50 border border-slate-700 rounded-xl p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
            <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="w-full bg-slate-900/50 border border-slate-700 rounded-xl p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
            <button type="submit" className="w-full premium-button text-white py-3 rounded-xl font-bold shadow-lg">
              {isLoginMode ? 'Sign In' : 'Register Now'}
            </button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-700"></div></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-slate-950 px-2 text-slate-500">Or continue with</span></div>
          </div>

          <button onClick={() => signInAnonymously(auth)} className="w-full py-3 border border-slate-700 rounded-xl text-sm font-bold hover:bg-slate-800/50 transition-all">
            Guest Access
          </button>

          <p className="text-center text-xs text-slate-500">
            {isLoginMode ? "Don't have an account?" : "Already have an account?"}{' '}
            <button onClick={() => setIsLoginMode(!isLoginMode)} className="text-blue-400 font-bold hover:underline">
              {isLoginMode ? 'Sign Up' : 'Log In'}
            </button>
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Main Catalog */}
          <div className="lg:col-span-2 space-y-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <span className="w-2 h-6 bg-blue-500 rounded-full"></span>
              Available Products
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {products.length === 0 ? (
                <div className="col-span-2 glass-card p-12 text-center rounded-2xl italic text-slate-500">
                  No products found. Sync plans to get started.
                </div>
              ) : products.map(product => (
                <div key={product.id} className="glass-card p-6 rounded-2xl flex flex-col justify-between hover:border-blue-500/50 transition-all group">
                  <div>
                    <div className="flex justify-between items-start mb-4">
                      <span className={`text-[10px] uppercase font-black px-2 py-1 rounded ${product.type === 'subscription' ? 'bg-pink-500/20 text-pink-400' : 'bg-blue-500/20 text-blue-400'}`}>
                        {product.type || (product.allowedPlans ? 'Subscription' : 'One-Time')}
                      </span>
                      <p className="text-xl font-black">₹{product.amount ? product.amount / 100 : (product.plans ? (Object.values(product.plans)[0] as any).item.amount / 100 : '---')}</p>
                    </div>
                    <h3 className="text-lg font-bold group-hover:text-blue-400 transition-colors">{product.name}</h3>
                    <p className="text-slate-400 text-sm mt-1 line-clamp-2">{product.description || 'Premium access to platform features'}</p>
                  </div>
                  <button onClick={() => handlePurchase(product)} className="mt-6 w-full py-3 premium-button text-white rounded-xl font-bold text-sm">
                    {product.type === 'subscription' || product.allowedPlans ? 'Subscribe Now' : 'One-Time Purchase'}
                  </button>
                </div>
              ))}
            </div>

            {/* Admin Panel (If Admin) */}
            {isAdmin && (
              <div className="glass-card p-6 rounded-2xl border-dashed border-slate-700 bg-slate-900/30">
                <h3 className="text-sm font-black text-slate-500 uppercase mb-4 tracking-widest">Administrative Control</h3>
                <div className="flex flex-wrap gap-4">
                  <button onClick={() => runAdminAction('sync')} className="px-6 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-sm font-bold transition-all">Sync from Razorpay</button>
                  <button onClick={() => runAdminAction('create')} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-bold transition-all">Create Demo Plan</button>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: Status & Monitor */}
          <div className="space-y-6">
            <div className="glass-card p-6 rounded-2xl space-y-4">
              <h2 className="text-sm font-black text-slate-500 uppercase tracking-widest">Active Access</h2>
              {activeSubscriptions.length === 0 ? (
                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800 text-center">
                  <p className="text-xs text-slate-500">No active subscriptions</p>
                </div>
              ) : activeSubscriptions.map(sub => (
                <div key={sub.id} className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl flex justify-between items-center">
                  <div>
                    <p className="text-xs font-bold text-blue-400">{sub.productId}</p>
                    <p className="text-[10px] text-slate-500 uppercase font-bold">{sub.status}</p>
                  </div>
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_#22c55e]"></span>
                </div>
              ))}
            </div>

            <div className="glass-card p-6 rounded-2xl space-y-4 relative overflow-hidden">
              <div className="shimmer absolute inset-0 opacity-20 pointer-events-none"></div>
              <h2 className="text-sm font-black text-slate-500 uppercase tracking-widest">System Status</h2>
              {status.message ? (
                <div className={`p-4 rounded-xl text-xs font-bold ${status.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}`}>
                  {status.message}
                </div>
              ) : (
                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800 text-center">
                  <p className="text-xs text-slate-500 italic">Standing by for transactions...</p>
                </div>
              )}
            </div>

            {/* Quick Helper for Demo */}
            <div className="p-6 border border-slate-800 rounded-2xl bg-slate-950/50 text-[10px] text-slate-500 leading-relaxed">
              <p className="font-bold text-slate-400 mb-2 uppercase">Developer Info</p>
              <p>This app demonstrates the <span className="text-blue-400">Product-First</span> pattern. The extension uses the trusted <code>productId</code> to resolve pricing on the backend, preventing client-side manipulation.</p>
              <button onClick={async () => {
                const token = await auth.currentUser?.getIdToken(true);
                await fetch('/api/set-admin-claim', { headers: { 'Authorization': `Bearer ${token}` } });
                window.location.reload();
              }} className="mt-4 text-blue-500 hover:underline">Self-Grant Admin for Demo</button>
            </div>
          </div>

        </div>
      )}

      {/* Footer */}
      <footer className="text-center py-12 text-slate-600 text-xs font-medium">
        Powered by Razorpay Firebase Extension &bull; Built for Enterprise Security
      </footer>
    </main>
  );
}
