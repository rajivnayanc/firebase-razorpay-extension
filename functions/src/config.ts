export default {
    // Extension parameters
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',

    // Firestore paths
    customersCollectionPath: process.env.CUSTOMERS_COLLECTION || 'customers',
    productsCollectionPath: process.env.PRODUCTS_COLLECTION || 'products',
};
