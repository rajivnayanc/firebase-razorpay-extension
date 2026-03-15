import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';
import config from '../config';
import { logs } from '../logs';
import { Customers } from 'razorpay/dist/types/customers'
import { getRazorpay } from '../api';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

export const createCustomer = functions.auth.user().onCreate(
    async (user): Promise<void> => {
        try {
            logs.info(`Creating Razorpay customer for new user: ${user.uid}`);

            const customerParams: Customers.RazorpayCustomerCreateRequestBody = {
                email: user.email,
                contact: user.phoneNumber,
                name: user.displayName,
                notes: {
                    firebaseUID: user.uid,
                },
            };

            const customer = await getRazorpay().customers.create(customerParams);
            logs.info(`Created Razorpay customer ${customer.id} for user ${user.uid}`);

            // Save the customer ID to Firestore
            await admin.firestore()
                .collection(config.customersCollectionPath)
                .doc(user.uid)
                .set({
                    razorpay_customer_id: customer.id,
                    email: user.email || null,
                }, { merge: true });

        } catch (error: any) {
            logs.error(new Error(`Failed to create Razorpay customer for user ${user.uid}: ${error.message}`));
        }
    }
);
