const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { success, error, cors } = require("../../shared/response");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

/**
 * Lambda Webhook Handler — Inbound Payment Webhook (Step 16a)
 * Receives payment confirmations from Payment Gateway.
 * This endpoint has NO JWT authorization (external webhook).
 */
exports.handler = async (event) => {
    try {
        // CORS pre-flight
        if (event.requestContext?.http?.method === "OPTIONS") {
            return cors();
        }

        const body = JSON.parse(event.body || "{}");
        const { orderCode, status, tenantId, signature } = body;

        // Basic validation
        if (!orderCode || !status) {
            return error(400, "Thiếu thông tin webhook (orderCode, status)!");
        }

        // In production, verify webhook signature using Secrets Manager
        // const expectedSig = await getSecretValue('smart-attendance-webhook-credentials');
        // if (signature !== expectedSig.PaymentWebhookSignatureKey) { ... }

        console.log(`[Webhook] Nhận thông báo thanh toán: Order #${orderCode}, Status: ${status}`);

        // Determine tenant from orderCode or body
        const targetTenantId = tenantId || "UNKNOWN";

        // Map payment status
        const statusMap = {
            "PAID": "COMPLETED",
            "CANCELLED": "CANCELLED",
            "EXPIRED": "EXPIRED",
            "PENDING": "PENDING"
        };
        const mappedStatus = statusMap[status] || status;

        // Update billing record
        if (targetTenantId !== "UNKNOWN") {
            await ddbDocClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${targetTenantId}`,
                    SK: `BILLING#ORDER#${orderCode}`
                },
                UpdateExpression: "SET #st = :status, #paid = :paidAt",
                ExpressionAttributeNames: {
                    "#st": "Status",
                    "#paid": "PaidAt"
                },
                ExpressionAttributeValues: {
                    ":status": mappedStatus,
                    ":paidAt": mappedStatus === "COMPLETED" ? new Date().toISOString() : null
                }
            }));

            // If payment completed, update subscription
            if (mappedStatus === "COMPLETED") {
                const expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + 1);

                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        PK: `TENANT#${targetTenantId}`,
                        SK: "SUBSCRIPTION#CURRENT"
                    },
                    UpdateExpression: "SET #plan = :plan, #st = :status, #exp = :expires, #upd = :updated",
                    ExpressionAttributeNames: {
                        "#plan": "Plan",
                        "#st": "Status",
                        "#exp": "ExpiresAt",
                        "#upd": "UpdatedAt"
                    },
                    ExpressionAttributeValues: {
                        ":plan": "PRO",
                        ":status": "ACTIVE",
                        ":expires": expiresAt.toISOString(),
                        ":updated": new Date().toISOString()
                    }
                }));
            }
        }

        return success(200, {
            message: "Webhook đã được xử lý thành công!",
            orderCode,
            status: mappedStatus
        });
    } catch (err) {
        console.error("Lỗi Lambda Webhook:", err);
        return error(500, err.message);
    }
};
