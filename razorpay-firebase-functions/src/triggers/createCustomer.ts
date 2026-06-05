import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import Razorpay from 'razorpay';
import { Customers } from 'razorpay/dist/types/customers';
import { logs } from '../logs';
import { RazorpaySyncConfig, CustomerDoc } from '../types';
import { TypedFirestore } from '../utils/typedFirestore';

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

                const typedFs = new TypedFirestore(admin.firestore(), config);
                const customerData: CustomerDoc = {
                    razorpay_customer_id: customer.id,
                    email: user.email || null,
                    name: user.displayName || null,
                    phone: user.phoneNumber || null,
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                    updated_at: admin.firestore.FieldValue.serverTimestamp(),
                };

                await typedFs.getCustomerDoc(user.uid).set(customerData, { merge: true });

            } catch (error: any) {
                logs.error(new Error(`Failed to create Razorpay customer for user ${user.uid}: ${error.message}`));
            }
        }
    );
};
