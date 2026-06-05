import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
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
                    email: user.email || undefined,
                    contact: user.phoneNumber || undefined,
                    name: user.displayName || undefined,
                    fail_existing: false,
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
                    created_at: FieldValue.serverTimestamp(),
                    updated_at: FieldValue.serverTimestamp(),
                };

                await typedFs.getCustomerDoc(user.uid).set(customerData, { merge: true });

            } catch (error: any) {
                const errMsg = error.message || (typeof error === 'object' ? JSON.stringify(error) : String(error));
                logs.error(new Error(`Failed to create Razorpay customer for user ${user.uid}: ${errMsg}`));
            }
        }
    );
};
