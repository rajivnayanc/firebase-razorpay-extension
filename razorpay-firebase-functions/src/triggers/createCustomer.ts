import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import Razorpay from 'razorpay';
import { Customers } from 'razorpay/dist/types/customers';
import { logs } from '../logs';
import { RazorpaySyncConfig } from '../types';

export const buildCreateCustomer = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return functions.auth.user().onCreate(
        async (user): Promise<void> => {
            if (!config.syncCustomers) {
                logs.info(`Customer sync disabled. Skipping Razorpay customer creation for user: ${user.uid}`);
                return;
            }

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

                const customer = await rzp.customers.create(customerParams);
                logs.info(`Created Razorpay customer ${customer.id} for user ${user.uid}`);

                await admin.firestore()
                    .collection(config.customersCollection)
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
};
