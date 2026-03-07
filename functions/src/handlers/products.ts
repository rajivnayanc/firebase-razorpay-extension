import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

// Whitelist of allowed fields from Razorpay product/plan entities
const ALLOWED_PRODUCT_FIELDS = [
    'id', 'name', 'description', 'active', 'amount', 'currency',
    'unit_amount', 'unit', 'interval', 'period', 'item_id',
    'hsn_code', 'sac_code', 'tax_inclusive', 'tax_id', 'tax_group_id',
];

/**
 * Prefix Razorpay metadata keys with `razorpay_metadata_` to prevent
 * collision with user's own Firestore fields.
 * Follows Stripe extension's `stripe_metadata_*` pattern.
 */
function prefixMetadata(metadata: Record<string, any>): Record<string, any> {
    return Object.keys(metadata).reduce((prefixed, key) => {
        prefixed[`razorpay_metadata_${key}`] = metadata[key];
        return prefixed;
    }, {} as Record<string, any>);
}

function sanitizeEntity(entity: any): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const key of ALLOWED_PRODUCT_FIELDS) {
        if (entity[key] !== undefined) {
            sanitized[key] = entity[key];
        }
    }
    // Safely prefix any metadata from the entity
    if (entity.metadata && typeof entity.metadata === 'object') {
        Object.assign(sanitized, prefixMetadata(entity.metadata));
    }
    return sanitized;
}

export const handleProductEvent = async (event: any) => {
    const db = admin.firestore();

    const entityName = event.event.split('.')[0];
    const payloadEntity = event.payload[entityName]?.entity;

    if (!payloadEntity) return;

    const docRef = db.collection(config.productsCollectionPath).doc(payloadEntity.id);
    const eventName = event.event;

    // --- Event Deduplication ---
    const eventId = event.id || `${event.event}_${payloadEntity.id}`;
    const dedupRef = db.collection('_razorpay_processed_events').doc(eventId);

    try {
        if (eventName === 'item.deleted') {
            // For deletions, use transaction to deduplicate
            await db.runTransaction(async (t) => {
                const dedupDoc = await t.get(dedupRef);
                if (dedupDoc.exists) {
                    logs.webhookProcessed(event.event, `SKIPPED (duplicate: ${eventId})`);
                    return;
                }

                t.delete(docRef);
                t.set(dedupRef, {
                    processedAt: FieldValue.serverTimestamp(),
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    event: event.event,
                    entityId: payloadEntity.id,
                });
            });
            logs.webhookProcessed(event.event, payloadEntity.id);
            return;
        }

        // Upsert with deduplication and sanitization
        await db.runTransaction(async (t) => {
            const dedupDoc = await t.get(dedupRef);
            if (dedupDoc.exists) {
                logs.webhookProcessed(event.event, `SKIPPED (duplicate: ${eventId})`);
                return;
            }

            const sanitizedData = sanitizeEntity(payloadEntity);
            const dataToWrite = {
                ...sanitizedData,
                _razorpay_event: event.event,
                _last_event_id: eventId,
                updated_at: FieldValue.serverTimestamp(),
            };

            t.set(docRef, dataToWrite, { merge: true });
            t.set(dedupRef, {
                processedAt: FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                event: event.event,
                entityId: payloadEntity.id,
            });
        });

        logs.webhookProcessed(event.event, payloadEntity.id);
    } catch (error: any) {
        logs.error(error);
    }
};
