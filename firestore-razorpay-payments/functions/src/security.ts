import Razorpay from 'razorpay';
import config from './config';

export const verifyWebhookSignature = (
    payload: string,
    signature: string
): boolean => {
    if (!signature || !payload) return false;

    return Razorpay.validateWebhookSignature(
        payload,
        signature,
        config.razorpayWebhookSecret
    );
};
