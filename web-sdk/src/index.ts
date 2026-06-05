import {
    Firestore,
    collection,
    doc,
    setDoc,
    onSnapshot
} from 'firebase/firestore';
import { Auth } from 'firebase/auth';
import { Functions, httpsCallable } from 'firebase/functions';
import {
    CheckoutSessionDoc,
    SubscriptionDoc,
    RazorpayPopupOptions
} from './types';

export interface RazorpayPaymentsConfig {
    firestore: Firestore;
    auth: Auth;
    functions: Functions;
    keyId: string;
    customersCollection?: string;
    productsCollection?: string;
}

export class RazorpayPayments {
    private firestore: Firestore;
    private auth: Auth;
    private functions: Functions;
    private keyId: string;
    private customersCollection: string;
    private productsCollection: string;

    constructor(config: RazorpayPaymentsConfig) {
        this.firestore = config.firestore;
        this.auth = config.auth;
        this.functions = config.functions;
        this.keyId = config.keyId;
        this.customersCollection = config.customersCollection || 'customers';
        this.productsCollection = config.productsCollection || 'products';
    }

    private loadRazorpayScript(): Promise<void> {
        return new Promise((resolve, reject) => {
            if ((window as any).Razorpay) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://checkout.razorpay.com/v1/checkout.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load Razorpay SDK. Please check your internet connection.'));
            document.head.appendChild(script);
        });
    }

    async startCheckout(options: {
        productId: string;
        metadata?: Record<string, string>;
        prefill?: {
            name?: string;
            email?: string;
            contact?: string;
        };
        themeColor?: string;
    }): Promise<{ status: 'paid' | 'failed' }> {
        const user = this.auth.currentUser;
        if (!user) {
            throw new Error('User is not authenticated.');
        }

        // 1. Create checkout session draft
        const checkoutSessionsCol = collection(
            this.firestore,
            this.customersCollection,
            user.uid,
            'checkout_sessions'
        );
        const sessionRef = doc(checkoutSessionsCol);

        await setDoc(sessionRef, {
            productId: options.productId,
            metadata: options.metadata || {}
        } as CheckoutSessionDoc);

        // 2. Wait for order to be created by server and listen to session updates
        return new Promise((resolve, reject) => {
            let unsubSession: () => void;
            let unsubOrder: () => void;
            let popupTriggered = false;

            const cleanup = () => {
                if (unsubSession) unsubSession();
                if (unsubOrder) unsubOrder();
            };

            // Listen to the session document for overall completion status or errors
            unsubSession = onSnapshot(sessionRef, (snap) => {
                const data = snap.data() as CheckoutSessionDoc | undefined;
                if (!data) return;

                if (data.status === 'paid') {
                    cleanup();
                    resolve({ status: 'paid' });
                } else if (data.status === 'failed') {
                    cleanup();
                    resolve({ status: 'failed' });
                } else if (data.error) {
                    cleanup();
                    reject(new Error(data.error));
                }
            }, (err) => {
                cleanup();
                reject(err);
            });

            // Listen to the subcollection razorpay_responses/order for the order details to open the popup
            const orderDocRef = doc(this.firestore, sessionRef.path, 'razorpay_responses', 'order');
            unsubOrder = onSnapshot(orderDocRef, async (snap) => {
                if (!snap.exists()) return;
                if (popupTriggered) return;

                popupTriggered = true;
                const orderData = snap.data();

                try {
                    await this.loadRazorpayScript();

                    const rzpOptions: RazorpayPopupOptions = {
                        key: this.keyId,
                        order_id: orderData.id,
                        amount: orderData.amount,
                        currency: orderData.currency,
                        name: orderData.notes?.name || 'Payment',
                        description: orderData.notes?.description || '',
                        prefill: options.prefill,
                        theme: options.themeColor ? { color: options.themeColor } : undefined,
                        handler: () => {
                            // User authorized payment on checkout popup.
                            // We do not resolve here yet because we wait for firestore status update from webhook.
                        },
                        modal: {
                            ondismiss: () => {
                                cleanup();
                                reject(new Error('Payment modal was closed by user.'));
                            }
                        }
                    };

                    const rzp = new (window as any).Razorpay(rzpOptions);
                    rzp.open();
                } catch (err) {
                    cleanup();
                    reject(err);
                }
            }, (err) => {
                cleanup();
                reject(err);
            });
        });
    }

    async startSubscription(options: {
        productId: string;
        interval?: string;
        metadata?: Record<string, string>;
        prefill?: {
            name?: string;
            email?: string;
            contact?: string;
        };
        themeColor?: string;
    }): Promise<{ status: 'active' | 'authenticated' | 'failed' }> {
        const user = this.auth.currentUser;
        if (!user) {
            throw new Error('User is not authenticated.');
        }

        // 1. Create subscription draft
        const subscriptionsCol = collection(
            this.firestore,
            this.customersCollection,
            user.uid,
            'subscriptions'
        );
        const draftRef = doc(subscriptionsCol);
        const draftId = draftRef.id;

        await setDoc(draftRef, {
            productId: options.productId,
            interval: options.interval,
            metadata: options.metadata || {}
        } as SubscriptionDoc);

        // 2. Wait for canonical doc to be created and listen for Razorpay Subscription response
        return new Promise((resolve, reject) => {
            let unsubCollection: () => void;
            let unsubDetails: () => void;
            let popupTriggered = false;
            let canonicalDocRef: any = null;

            const cleanup = () => {
                if (unsubCollection) unsubCollection();
                if (unsubDetails) unsubDetails();
            };

            // Listen to the subscriptions collection to find the document with draftId
            unsubCollection = onSnapshot(subscriptionsCol, (snap) => {
                const canonicalDoc = snap.docs.find(item => {
                    const data = item.data() as SubscriptionDoc;
                    return data.draftId === draftId;
                });

                if (!canonicalDoc) return;

                // Found canonical document! Switch to listening to it and its razorpay_responses subcollection
                const canonicalData = canonicalDoc.data() as SubscriptionDoc;
                canonicalDocRef = canonicalDoc.ref;

                if (canonicalData.status === 'active' || canonicalData.status === 'authenticated') {
                    cleanup();
                    resolve({ status: canonicalData.status as any });
                } else if (canonicalData.status === 'failed') {
                    cleanup();
                    resolve({ status: 'failed' });
                } else if (canonicalData.error) {
                    cleanup();
                    reject(new Error(canonicalData.error));
                }

                if (popupTriggered) return;

                // Stop listening to collection, only listen to this document
                unsubCollection();

                // Set up listener for document changes (e.g. status paid/failed)
                unsubCollection = onSnapshot(canonicalDocRef, (subSnap: any) => {
                    const subData = subSnap.data() as SubscriptionDoc;
                    if (!subData) return;

                    if (subData.status === 'active' || subData.status === 'authenticated') {
                        cleanup();
                        resolve({ status: subData.status as any });
                    } else if (subData.status === 'failed') {
                        cleanup();
                        resolve({ status: 'failed' });
                    } else if (subData.error) {
                        cleanup();
                        reject(new Error(subData.error));
                    }
                }, (err) => {
                    cleanup();
                    reject(err);
                });

                // Listen to raw subscription details doc inside the subcollection
                const detailsDocRef = doc(this.firestore, canonicalDocRef.path, 'razorpay_responses', 'subscription');
                unsubDetails = onSnapshot(detailsDocRef, async (detailsSnap) => {
                    if (!detailsSnap.exists()) return;
                    if (popupTriggered) return;

                    popupTriggered = true;
                    const subDetails = detailsSnap.data();

                    try {
                        await this.loadRazorpayScript();

                        const rzpOptions: RazorpayPopupOptions = {
                            key: this.keyId,
                            subscription_id: subDetails.id,
                            name: subDetails.notes?.name || 'Subscription',
                            description: subDetails.notes?.description || '',
                            prefill: options.prefill,
                            theme: options.themeColor ? { color: options.themeColor } : undefined,
                            handler: () => {
                                // User authorized subscription. Wait for webhook status update.
                            },
                            modal: {
                                ondismiss: () => {
                                    cleanup();
                                    reject(new Error('Subscription modal was closed by user.'));
                                }
                            }
                        };

                        const rzp = new (window as any).Razorpay(rzpOptions);
                        rzp.open();
                    } catch (err) {
                        cleanup();
                        reject(err);
                    }
                }, (err) => {
                    cleanup();
                    reject(err);
                });
            }, (err) => {
                cleanup();
                reject(err);
            });
        });
    }

    async cancelSubscription(subscriptionId: string): Promise<{ status: string }> {
        const cancelFunc = httpsCallable<{ subscriptionId: string }, { status: string }>(
            this.functions,
            'cancelSubscription'
        );
        const res = await cancelFunc({ subscriptionId });
        return res.data;
    }

    async updateSubscriptionPlan(
        subscriptionId: string,
        planId: string,
        scheduleChangeAt: 'now' | 'cycle_end' = 'now'
    ): Promise<{ plan_id: string; status: string }> {
        const updateFunc = httpsCallable<
            { subscriptionId: string; planId: string; scheduleChangeAt: 'now' | 'cycle_end' },
            { plan_id: string; status: string }
        >(this.functions, 'updateSubscriptionPlan');
        const res = await updateFunc({ subscriptionId, planId, scheduleChangeAt });
        return res.data;
    }
}

export function initializeRazorpayPayments(config: RazorpayPaymentsConfig): RazorpayPayments {
    return new RazorpayPayments(config);
}
