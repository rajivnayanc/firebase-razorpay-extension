import Razorpay from 'razorpay';

export const verifyWebhookSignature = (
    payload: string,
    signature: string,
    webhookSecret: string
): boolean => {
    if (!signature || !payload || !webhookSecret) return false;

    return Razorpay.validateWebhookSignature(
        payload,
        signature,
        webhookSecret
    );
};
